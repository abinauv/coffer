import { describe, expect, it } from 'vitest'
import {
  ariaLiveFor,
  createToast,
  defaultDurationMs,
  EMPTY_TOAST_STATE,
  MAX_VISIBLE_TOASTS,
  toastsReducer,
  type Toast,
  type ToastInput,
  type ToastState,
} from './toasts'

function show(state: ToastState, input: ToastInput, id: string, now = 0): ToastState {
  return toastsReducer(state, { type: 'show', toast: createToast(input, id, now) })
}

function ids(state: ToastState): string[] {
  return state.toasts.map((toast) => toast.id)
}

describe('defaultDurationMs', () => {
  it('gives every tone a duration except danger', () => {
    expect(defaultDurationMs('success')).toBe(4000)
    expect(defaultDurationMs('info')).toBe(5000)
    expect(defaultDurationMs('warning')).toBe(8000)
  })

  /* A failure that dismissed itself was never reported. */
  it('leaves danger on screen until it is dismissed', () => {
    expect(defaultDurationMs('danger')).toBeNull()
  })
})

describe('createToast', () => {
  it('defaults the tone to info and takes the duration from the tone', () => {
    const toast = createToast({ title: 'Saved' }, 't1', 1000)
    expect(toast.tone).toBe('info')
    expect(toast.durationMs).toBe(5000)
    expect(toast.createdAt).toBe(1000)
  })

  it('lets an explicit duration override the tone default, including null', () => {
    expect(createToast({ title: 'x', tone: 'success', durationMs: 100 }, 'a', 0).durationMs).toBe(
      100,
    )
    expect(createToast({ title: 'x', tone: 'success', durationMs: null }, 'a', 0).durationMs).toBe(
      null,
    )
  })

  it('omits optional fields rather than setting them undefined', () => {
    const toast = createToast({ title: 'x' }, 'a', 0)
    expect('body' in toast).toBe(false)
    expect('action' in toast).toBe(false)
    expect('dedupeKey' in toast).toBe(false)
  })
})

describe('toastsReducer', () => {
  it('appends, newest last', () => {
    let state = show(EMPTY_TOAST_STATE, { title: 'One' }, 'a')
    state = show(state, { title: 'Two' }, 'b')
    expect(ids(state)).toEqual(['a', 'b'])
  })

  it('dismisses by id', () => {
    let state = show(EMPTY_TOAST_STATE, { title: 'One' }, 'a')
    state = show(state, { title: 'Two' }, 'b')
    state = toastsReducer(state, { type: 'dismiss', id: 'a' })
    expect(ids(state)).toEqual(['b'])
  })

  /* A timer that fires after the user already dismissed its toast must not
   * produce a new state object, or the viewport re-renders for nothing. */
  it('returns the same state when dismissing an id that is gone', () => {
    const state = show(EMPTY_TOAST_STATE, { title: 'One' }, 'a')
    expect(toastsReducer(state, { type: 'dismiss', id: 'nope' })).toBe(state)
  })

  it('clears everything', () => {
    let state = show(EMPTY_TOAST_STATE, { title: 'One' }, 'a')
    state = show(state, { title: 'Two' }, 'b')
    expect(toastsReducer(state, { type: 'clear' }).toasts).toEqual([])
  })

  it('returns the same state when clearing an empty stack', () => {
    expect(toastsReducer(EMPTY_TOAST_STATE, { type: 'clear' })).toBe(EMPTY_TOAST_STATE)
  })

  describe('deduplication', () => {
    it('replaces a toast with the same key instead of stacking', () => {
      let state = show(EMPTY_TOAST_STATE, { title: 'Saving…', dedupeKey: 'save' }, 'a', 0)
      state = show(state, { title: 'Saved', dedupeKey: 'save' }, 'b', 500)
      expect(state.toasts).toHaveLength(1)
      expect(state.toasts[0]?.title).toBe('Saved')
      expect(state.toasts[0]?.createdAt).toBe(500)
    })

    it('keeps the original id so the timer and the DOM node survive the swap', () => {
      let state = show(EMPTY_TOAST_STATE, { title: 'Saving…', dedupeKey: 'save' }, 'a')
      state = show(state, { title: 'Saved', dedupeKey: 'save' }, 'b')
      expect(state.toasts[0]?.id).toBe('a')
    })

    it('keeps the position so the stack does not jump under the pointer', () => {
      let state = show(EMPTY_TOAST_STATE, { title: 'First', dedupeKey: 'k' }, 'a')
      state = show(state, { title: 'Second' }, 'b')
      state = show(state, { title: 'First again', dedupeKey: 'k' }, 'c')
      expect(state.toasts.map((toast) => toast.title)).toEqual(['First again', 'Second'])
    })

    it('stacks toasts with different keys', () => {
      let state = show(EMPTY_TOAST_STATE, { title: 'One', dedupeKey: 'a' }, 'a')
      state = show(state, { title: 'Two', dedupeKey: 'b' }, 'b')
      expect(state.toasts).toHaveLength(2)
    })

    it('stacks toasts with no key at all', () => {
      let state = show(EMPTY_TOAST_STATE, { title: 'One' }, 'a')
      state = show(state, { title: 'One' }, 'b')
      expect(state.toasts).toHaveLength(2)
    })
  })

  describe('capacity', () => {
    it('never exceeds the visible maximum', () => {
      let state = EMPTY_TOAST_STATE
      for (let index = 0; index < MAX_VISIBLE_TOASTS + 3; index += 1) {
        state = show(state, { title: `Toast ${index}` }, `t${index}`)
      }
      expect(state.toasts).toHaveLength(MAX_VISIBLE_TOASTS)
    })

    it('drops the oldest when everything is expiring', () => {
      let state = EMPTY_TOAST_STATE
      for (let index = 0; index < MAX_VISIBLE_TOASTS + 1; index += 1) {
        state = show(state, { title: `Toast ${index}` }, `t${index}`)
      }
      expect(ids(state)[0]).toBe('t1')
    })

    /* An unacknowledged failure outlives a confirmation that would have gone
     * away on its own anyway. */
    it('evicts an expiring toast before a sticky one', () => {
      let state = show(EMPTY_TOAST_STATE, { title: 'Failed', tone: 'danger' }, 'danger')
      for (let index = 0; index < MAX_VISIBLE_TOASTS; index += 1) {
        state = show(state, { title: `Toast ${index}` }, `t${index}`)
      }
      expect(ids(state)).toContain('danger')
      expect(state.toasts).toHaveLength(MAX_VISIBLE_TOASTS)
    })

    it('evicts the oldest sticky toast only when every toast is sticky', () => {
      let state = EMPTY_TOAST_STATE
      for (let index = 0; index < MAX_VISIBLE_TOASTS + 1; index += 1) {
        state = show(state, { title: `Failure ${index}`, tone: 'danger' }, `d${index}`)
      }
      expect(state.toasts).toHaveLength(MAX_VISIBLE_TOASTS)
      expect(ids(state)).not.toContain('d0')
      expect(ids(state)).toContain('d1')
    })
  })

  it('does not mutate the state it was given', () => {
    const state = show(EMPTY_TOAST_STATE, { title: 'One' }, 'a')
    const before: readonly Toast[] = state.toasts
    show(state, { title: 'Two' }, 'b')
    expect(state.toasts).toBe(before)
    expect(state.toasts).toHaveLength(1)
  })
})

describe('ariaLiveFor', () => {
  it('interrupts for danger and waits for everything else', () => {
    expect(ariaLiveFor('danger')).toBe('assertive')
    expect(ariaLiveFor('warning')).toBe('polite')
    expect(ariaLiveFor('success')).toBe('polite')
    expect(ariaLiveFor('info')).toBe('polite')
  })
})
