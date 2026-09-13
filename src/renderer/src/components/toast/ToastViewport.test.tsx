/*
 * The toast layer, and specifically ITS TIMERS.
 *
 * `toastsReducer` is covered as a pure function in lib/toasts.test.ts, so nothing here
 * re-tests what the list contains. What only this file can test is the half the reducer
 * deliberately does not own: the clock in `store/toasts.tsx`, and the viewport that
 * pauses it.
 *
 * THREE THINGS ABOUT A COUNTDOWN THAT A "DOES IT APPEAR" TEST CANNOT SEE:
 *
 *   IT ENDS. A toast that never expires looks identical to one that expired correctly
 *   until you wait, so every duration is checked one millisecond either side.
 *   IT IS PER TOAST. The effect re-runs on every change to the stack, and a naive
 *   implementation restarts every countdown each time — meaning a busy screen's first
 *   toast never goes away. The second test below is the one that catches that: it shows
 *   a second toast midway through the first one's life and holds it to its ORIGINAL
 *   deadline.
 *   IT DIES WITH ITS COMPONENT. A timer still holding a closure over `dispatch` after
 *   unmount is a leak, and no assertion about the screen can see it — the screen is
 *   gone. So the assertion is `vi.getTimerCount()`.
 *
 * Driven with `fireEvent` rather than `userEvent`: userEvent's async wrapper never
 * settles under vitest's fake timers, and this whole file is about the clock.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ICON_PATHS } from '../../lib/icons'
import type { ToastInput, ToastTone } from '../../lib/toasts'
import { ToastProvider, useToasts } from '../../store/toasts'
import { ToastViewport } from './ToastViewport'

/* Total over the closed union, so a fifth tone fails to compile here until it is
 * answered for (CONVENTIONS §1.9). The values are what the component must produce. */
const TONES: Readonly<
  Record<ToastTone, { role: string; live: 'polite' | 'assertive'; icon: keyof typeof ICON_PATHS }>
> = {
  info: { role: 'status', live: 'polite', icon: 'info' },
  success: { role: 'status', live: 'polite', icon: 'check-circle' },
  warning: { role: 'status', live: 'polite', icon: 'alert-triangle' },
  danger: { role: 'alert', live: 'assertive', icon: 'alert-circle' },
}

const EVERY_TONE = Object.keys(TONES) as readonly ToastTone[]

let show: (input: ToastInput) => string

/** Publishes the store's `show` to the test, so each test raises exactly what it needs. */
function Bridge(): JSX.Element {
  show = useToasts().show
  return <></>
}

function mount(): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      <Bridge />
      <ToastViewport />
    </ToastProvider>,
  )
}

function raise(input: ToastInput): string {
  let id = ''
  act(() => {
    id = show(input)
  })
  return id
}

/** Moves the fake clock and lets React flush what the timer caused. */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

function region(): HTMLElement {
  return screen.getByRole('region', { name: 'Notifications' })
}

/** One toast, by its title — never the whole stack, so two toasts stay distinguishable. */
function toastTitled(title: string): HTMLElement {
  const heading = screen.getByText(title)
  const toast = heading.closest('.toast')
  if (!(toast instanceof HTMLElement)) throw new Error(`No toast around "${title}"`)
  return toast
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('what a toast says', () => {
  it('shows its title, its body and a way to dismiss it', () => {
    mount()

    raise({ tone: 'success', title: 'Backup written.', body: '/books/acme.coffer.backup' })

    const toast = toastTitled('Backup written.')
    expect(within(toast).getByText('/books/acme.coffer.backup')).toBeVisible()
    expect(within(toast).getByRole('button', { name: 'Dismiss notification' })).toBeVisible()
  })

  it('shows no body when there is none', () => {
    mount()

    raise({ tone: 'success', title: 'Backup written.' })

    expect(toastTitled('Backup written.').querySelector('.toast__body')).toBeNull()
  })

  it('is reachable as a landmark, not only when something changes', () => {
    mount()

    expect(region()).toBeVisible()
  })

  it.each(EVERY_TONE)('gives a %s toast its own icon', (tone) => {
    mount()

    raise({ tone, title: 'Backup written.' })

    expect(toastTitled('Backup written.').querySelector('.toast__icon path')).toHaveAttribute(
      'd',
      ICON_PATHS[TONES[tone].icon],
    )
  })

  /*
   * DANGER INTERRUPTS; NOTHING ELSE DOES. `role` and `aria-live` are the two halves of
   * that, and they are asserted for every member of the union rather than for the one
   * tone somebody remembered — a tone that quietly announces itself as `polite` is a
   * failure nobody sees until a screen-reader user misses a failed save.
   */
  it.each(EVERY_TONE)('announces a %s toast at the right urgency', (tone) => {
    mount()

    raise({ tone, title: 'Backup written.' })

    const toast = toastTitled('Backup written.')
    expect(toast).toHaveAttribute('role', TONES[tone].role)
    expect(toast).toHaveAttribute('aria-live', TONES[tone].live)
  })

  /* Newest at the end. Asserted by position with two different titles, because "both
   * are on screen" is true of either order. */
  it('stacks a new toast after the ones already up', () => {
    mount()

    raise({ tone: 'info', title: 'First.' })
    raise({ tone: 'info', title: 'Second.' })

    const titles = [...region().querySelectorAll('.toast__title')].map((node) => node.textContent)
    expect(titles).toEqual(['First.', 'Second.'])
  })
})

describe('the countdown', () => {
  it('takes a toast away when its time is up, and not before', () => {
    mount()

    raise({ tone: 'success', title: 'Backup written.' })

    /* `success` is 4000ms (lib/toasts). One millisecond short, then one more. */
    advance(3999)
    expect(screen.getByText('Backup written.')).toBeVisible()

    advance(1)
    expect(screen.queryByText('Backup written.')).toBeNull()
  })

  it('honours a duration given explicitly rather than the tone default', () => {
    mount()

    raise({ tone: 'success', title: 'Backup written.', durationMs: 10_000 })

    advance(4000)
    expect(screen.getByText('Backup written.')).toBeVisible()

    advance(6000)
    expect(screen.queryByText('Backup written.')).toBeNull()
  })

  /*
   * THE ONE THAT MATTERS. A second toast changes `state.toasts`, which re-runs the
   * effect and tears down every scheduled timer. An implementation that simply
   * rescheduled from `durationMs` would give the first toast a fresh five seconds — so
   * on a screen raising a toast every few seconds, the first one would never leave.
   *
   * Elapsed here: 3000 before the second toast, 2000 after. The first must go at
   * exactly 5000, not at 8000.
   */
  it('does not restart the first toast when a second one arrives', () => {
    mount()

    raise({ tone: 'info', title: 'First.' })
    advance(3000)

    raise({ tone: 'info', title: 'Second.' })
    advance(1999)
    expect(screen.getByText('First.')).toBeVisible()

    advance(1)
    expect(screen.queryByText('First.')).toBeNull()
    /* And the second still has its own three seconds — the two clocks are separate. */
    expect(screen.getByText('Second.')).toBeVisible()

    advance(2999)
    expect(screen.getByText('Second.')).toBeVisible()
    advance(1)
    expect(screen.queryByText('Second.')).toBeNull()
  })

  /*
   * A FAILURE THAT SCROLLED AWAY UNREAD WAS NEVER REPORTED (CONVENTIONS §5). `danger`
   * has no duration at all, so there is nothing to wait out.
   */
  it('never takes a danger toast away on its own', () => {
    mount()

    raise({ tone: 'danger', title: 'The period is closed.' })

    advance(60_000)

    expect(screen.getByText('The period is closed.')).toBeVisible()
    /* Nothing is even scheduled for it. */
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never takes away a toast whose duration was set to null', () => {
    mount()

    raise({ tone: 'info', title: 'Restoring…', durationMs: null })

    advance(60_000)

    expect(screen.getByText('Restoring…')).toBeVisible()
  })

  /*
   * A REPLACED TOAST GETS A FRESH CLOCK. Saving twice collapses to one confirmation by
   * `dedupeKey`, and the replacement must live its full life from when it arrived — the
   * remaining-time map is keyed on the creation time for exactly this.
   */
  it('restarts the countdown when a toast is replaced in place', () => {
    mount()

    raise({ tone: 'info', title: 'Saved.', dedupeKey: 'save' })
    advance(3000)

    raise({ tone: 'info', title: 'Saved twice.', dedupeKey: 'save' })

    /* Replaced, not stacked. */
    expect(screen.queryByText('Saved.')).toBeNull()
    expect(region().querySelectorAll('.toast')).toHaveLength(1)

    /* 4999 further — 7999 since the first — and it is still up, which only holds if the
     * clock started again. */
    advance(4999)
    expect(screen.getByText('Saved twice.')).toBeVisible()

    advance(1)
    expect(screen.queryByText('Saved twice.')).toBeNull()
  })
})

describe('pausing', () => {
  /*
   * The action button on a toast has to be reachable, which means the countdown has to
   * stop while the user is going for it. And it must RESUME WITH WHAT WAS LEFT, not with
   * a full duration — otherwise brushing past the stack refreshes everything in it.
   */
  it('holds every countdown while the pointer is over the stack', () => {
    mount()

    raise({ tone: 'info', title: 'Saved.' })
    advance(3000)

    fireEvent.pointerOver(region())
    advance(60_000)
    expect(screen.getByText('Saved.')).toBeVisible()

    fireEvent.pointerOut(region(), { relatedTarget: document.body })

    /* Two seconds were left when the pointer arrived, and two seconds is what is left. */
    advance(1999)
    expect(screen.getByText('Saved.')).toBeVisible()
    advance(1)
    expect(screen.queryByText('Saved.')).toBeNull()
  })

  it('holds every countdown while focus is inside the stack', () => {
    mount()

    raise({ tone: 'info', title: 'Saved.' })
    const dismiss = within(toastTitled('Saved.')).getByRole('button', {
      name: 'Dismiss notification',
    })

    fireEvent.focusIn(dismiss)
    advance(60_000)
    expect(screen.getByText('Saved.')).toBeVisible()

    fireEvent.focusOut(dismiss)
    advance(5000)
    expect(screen.queryByText('Saved.')).toBeNull()
  })
})

describe('dismissing', () => {
  it('takes away the toast whose button was pressed and leaves the other', () => {
    mount()

    raise({ tone: 'info', title: 'First.' })
    raise({ tone: 'info', title: 'Second.' })

    fireEvent.click(
      within(toastTitled('First.')).getByRole('button', { name: 'Dismiss notification' }),
    )

    expect(screen.queryByText('First.')).toBeNull()
    expect(screen.getByText('Second.')).toBeVisible()
  })

  it('runs the action and then dismisses the toast', () => {
    mount()
    const run = vi.fn()

    raise({ tone: 'info', title: 'Entry posted.', action: { label: 'Undo', run } })

    fireEvent.click(within(toastTitled('Entry posted.')).getByRole('button', { name: 'Undo' }))

    expect(run).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Entry posted.')).toBeNull()
  })

  it('offers no action button when the toast carries no action', () => {
    mount()

    raise({ tone: 'info', title: 'Entry posted.' })

    expect(toastTitled('Entry posted.').querySelector('.toast__action')).toBeNull()
  })

  /* A timer that outlives its toast would fire into a stack that no longer holds it.
   * The reducer is written to make that a no-op; this is the other end of the same
   * rule — nothing should still be scheduled. */
  it('clears the timer of a toast dismissed by hand', () => {
    mount()

    raise({ tone: 'info', title: 'Saved.' })
    expect(vi.getTimerCount()).toBe(1)

    fireEvent.click(
      within(toastTitled('Saved.')).getByRole('button', { name: 'Dismiss notification' }),
    )

    expect(vi.getTimerCount()).toBe(0)
  })
})

/*
 * THE LEAK. A toast still counting down when its provider goes away — a company closing
 * and the whole shell being replaced — leaves a `setTimeout` holding `dispatch`.
 */
describe('unmounting', () => {
  it('leaves nothing scheduled behind it', () => {
    const { unmount } = mount()

    raise({ tone: 'info', title: 'Saved.' })
    raise({ tone: 'warning', title: 'Two accounts share a code.' })
    expect(vi.getTimerCount()).toBe(2)

    unmount()

    expect(vi.getTimerCount()).toBe(0)
  })
})
