/*
 * The tooltip.
 *
 * The rules in the component's header are what this file checks, and three of them are
 * the ones a hand-rolled tooltip gets wrong:
 *
 *   IT APPEARS ON FOCUS, not only on hover, and immediately rather than after the hover
 *   delay — a keyboard user has no way to "hover for 400ms".
 *   IT DESCRIBES, IT DOES NOT NAME. The trigger keeps its own accessible name and gains
 *   `aria-describedby`. A tooltip wired as a label would replace the button's name with
 *   the same words, which reads as working and is not.
 *   ESCAPE DISMISSES IT, so it can never sit over the thing you were reading.
 *
 * And a fourth thing that is not in the header: THE HOVER DELAY IS A TIMER, and a timer
 * that outlives its component is a leak. The last describe unmounts mid-delay and
 * asserts against the scheduler, because there is no screen left to assert against.
 *
 * TWO STYLES OF DRIVING, DELIBERATELY. `userEvent` where the point is that a real user
 * gesture reaches the component — it moves focus for real, which `fireEvent.focusIn`
 * does not. `fireEvent` plus fake timers where the point is the clock: userEvent's
 * async wrapper never settles under vitest's fake timers, and the alternative,
 * `shouldAdvanceTime`, lets real time leak into an assertion that is about a single
 * millisecond either side of a boundary.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tooltip } from './Tooltip'

function bubble(): HTMLElement {
  return screen.getByRole('tooltip')
}

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: 'Toggle' })
}

/** Moves the fake clock and lets React flush what the timer caused. */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('focus', () => {
  it('shows the tooltip at once, without waiting out the hover delay', async () => {
    const user = userEvent.setup()
    render(
      <Tooltip label="Collapse sidebar" delayMs={400}>
        <button type="button">Toggle</button>
      </Tooltip>,
    )

    await user.tab()

    expect(trigger()).toHaveFocus()
    expect(bubble()).toHaveAttribute('data-visible', 'true')
  })

  /*
   * A DESCRIPTION, NOT A NAME. Wired with `aria-labelledby` the button would be
   * announced as "Collapse sidebar", and this assertion — that the name is still
   * "Toggle" — is the only one that would notice.
   */
  it('leaves the trigger its own name and adds only a description', async () => {
    const user = userEvent.setup()
    render(
      <Tooltip label="Collapse sidebar">
        <button type="button">Toggle</button>
      </Tooltip>,
    )

    await user.tab()

    expect(trigger()).toHaveAccessibleName('Toggle')
    expect(trigger()).toHaveAccessibleDescription('Collapse sidebar')
  })

  it('describes nothing until it is shown', () => {
    render(
      <Tooltip label="Collapse sidebar">
        <button type="button">Toggle</button>
      </Tooltip>,
    )

    expect(trigger()).not.toHaveAttribute('aria-describedby')
    expect(trigger()).toHaveAccessibleDescription('')
    expect(bubble()).toHaveAttribute('data-visible', 'false')
  })

  it('hides again when focus leaves', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Tooltip label="Collapse sidebar">
          <button type="button">Toggle</button>
        </Tooltip>
        <button type="button">Elsewhere</button>
      </>,
    )

    await user.tab()
    expect(bubble()).toHaveAttribute('data-visible', 'true')

    await user.tab()

    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus()
    expect(bubble()).toHaveAttribute('data-visible', 'false')
    expect(trigger()).toHaveAccessibleDescription('')
  })
})

describe('Escape', () => {
  it('dismisses a tooltip that is showing', async () => {
    const user = userEvent.setup()
    render(
      <Tooltip label="Collapse sidebar">
        <button type="button">Toggle</button>
      </Tooltip>,
    )

    await user.tab()
    expect(bubble()).toHaveAttribute('data-visible', 'true')

    await user.keyboard('{Escape}')

    expect(bubble()).toHaveAttribute('data-visible', 'false')
    expect(trigger()).toHaveAccessibleDescription('')
  })

  /* The listener exists only while the tooltip is up. A sidebar of fifteen collapsed
   * nav items would otherwise carry fifteen document-level keydown handlers. */
  it('listens for keys only while it is showing', async () => {
    const user = userEvent.setup()
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')

    render(
      <Tooltip label="Collapse sidebar">
        <button type="button">Toggle</button>
      </Tooltip>,
    )
    expect(add.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(0)

    await user.tab()
    expect(add.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1)

    await user.keyboard('{Escape}')
    expect(remove.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1)

    add.mockRestore()
    remove.mockRestore()
  })

  it('ignores a key that is not Escape', async () => {
    const user = userEvent.setup()
    render(
      <Tooltip label="Collapse sidebar">
        <button type="button">Toggle</button>
      </Tooltip>,
    )

    await user.tab()
    await user.keyboard('{Enter}')

    expect(bubble()).toHaveAttribute('data-visible', 'true')
  })
})

describe('hover', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('waits out the delay before appearing', () => {
    render(
      <Tooltip label="Collapse sidebar" delayMs={400}>
        <button type="button">Toggle</button>
      </Tooltip>,
    )

    fireEvent.pointerOver(trigger())

    /* One millisecond short: still hidden. A test that only ever advanced past the
     * delay would pass against a tooltip that appeared on the first pointer event. */
    advance(399)
    expect(bubble()).toHaveAttribute('data-visible', 'false')

    advance(1)
    expect(bubble()).toHaveAttribute('data-visible', 'true')
    expect(trigger()).toHaveAccessibleDescription('Collapse sidebar')
  })

  it('honours a delay shorter than the default', () => {
    render(
      <Tooltip label="Collapse sidebar" delayMs={250}>
        <button type="button">Toggle</button>
      </Tooltip>,
    )

    fireEvent.pointerOver(trigger())
    advance(250)

    expect(bubble()).toHaveAttribute('data-visible', 'true')
  })

  it('waits 400ms when no delay is given', () => {
    render(
      <Tooltip label="Collapse sidebar">
        <button type="button">Toggle</button>
      </Tooltip>,
    )

    fireEvent.pointerOver(trigger())
    advance(399)
    expect(bubble()).toHaveAttribute('data-visible', 'false')

    advance(1)
    expect(bubble()).toHaveAttribute('data-visible', 'true')
  })

  it('never appears when the pointer leaves before the delay is up', () => {
    render(
      <Tooltip label="Collapse sidebar" delayMs={400}>
        <button type="button">Toggle</button>
      </Tooltip>,
    )

    fireEvent.pointerOver(trigger())
    advance(200)
    fireEvent.pointerOut(trigger(), { relatedTarget: document.body })

    advance(1000)

    expect(bubble()).toHaveAttribute('data-visible', 'false')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('hides when the pointer leaves after it has appeared', () => {
    render(
      <Tooltip label="Collapse sidebar" delayMs={400}>
        <button type="button">Toggle</button>
      </Tooltip>,
    )

    fireEvent.pointerOver(trigger())
    advance(400)
    expect(bubble()).toHaveAttribute('data-visible', 'true')

    fireEvent.pointerOut(trigger(), { relatedTarget: document.body })

    expect(bubble()).toHaveAttribute('data-visible', 'false')
  })

  /* Re-entering restarts the countdown rather than stacking a second one — two live
   * timers means the tooltip appears at whichever fires first, which is the earlier
   * hover the user has already left. */
  it('keeps only one countdown when the pointer re-enters', () => {
    render(
      <Tooltip label="Collapse sidebar" delayMs={400}>
        <button type="button">Toggle</button>
      </Tooltip>,
    )

    fireEvent.pointerOver(trigger())
    advance(300)
    fireEvent.pointerOver(trigger())

    expect(vi.getTimerCount()).toBe(1)
    advance(399)
    expect(bubble()).toHaveAttribute('data-visible', 'false')
    advance(1)
    expect(bubble()).toHaveAttribute('data-visible', 'true')
  })
})

describe('the bubble', () => {
  it('is placed below the trigger unless told otherwise', () => {
    render(
      <Tooltip label="Collapse sidebar">
        <button type="button">Toggle</button>
      </Tooltip>,
    )

    expect(bubble()).toHaveClass('tooltip__bubble', 'tooltip__bubble--bottom')
  })

  it('takes the placement it was given', () => {
    render(
      <Tooltip label="Collapse sidebar" placement="right">
        <button type="button">Toggle</button>
      </Tooltip>,
    )

    expect(bubble()).toHaveClass('tooltip__bubble--right')
  })

  it('says the label it was given', () => {
    render(
      <Tooltip label="Collapse sidebar">
        <button type="button">Toggle</button>
      </Tooltip>,
    )

    expect(bubble()).toHaveTextContent('Collapse sidebar')
  })
})

/*
 * THE LEAK. A hover interrupted by the component going away leaves a `setTimeout`
 * holding a closure over `setVisible`. Nothing about the screen can show it — the
 * screen is gone — so the assertion is about the scheduler.
 */
describe('unmounting', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('cancels a hover that was still counting down', () => {
    const { unmount } = render(
      <Tooltip label="Collapse sidebar" delayMs={400}>
        <button type="button">Toggle</button>
      </Tooltip>,
    )

    fireEvent.pointerOver(trigger())
    expect(vi.getTimerCount()).toBe(1)

    unmount()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves no document listener behind when it was showing', () => {
    const remove = vi.spyOn(document, 'removeEventListener')
    const { unmount } = render(
      <Tooltip label="Collapse sidebar">
        <button type="button">Toggle</button>
      </Tooltip>,
    )

    fireEvent.focusIn(trigger())
    expect(bubble()).toHaveAttribute('data-visible', 'true')

    unmount()

    expect(remove.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1)
    remove.mockRestore()
  })
})
