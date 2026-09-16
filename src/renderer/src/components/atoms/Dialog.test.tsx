/*
 * The `<dialog>` atom.
 *
 * This is the component happy-dom was chosen for (src/renderer/src/test/setup.ts), so
 * it gets the hardest look — and the first job of the file is to be honest about where
 * the environment stops. MEASURED, not reasoned about; every line below was run.
 *
 * WHAT happy-dom 20 DOES implement:
 *   - `showModal()` and `close()`, and `dialog.open` reflects both.
 *   - The user-agent `display: none` on a closed dialog, so a closed dialog's contents
 *     leave the accessibility tree and `getByRole` stops finding them.
 *   - `cancel` as an ordinary cancelable event: dispatching one reaches React's
 *     `onCancel`, and `preventDefault()` on it is observable.
 *
 * WHAT IT DOES NOT, and what that costs:
 *   - ESCAPE DOES NOT PRODUCE A `cancel` EVENT. Neither `user.keyboard('{Escape}')` nor
 *     `fireEvent.keyDown` moves the dialog at all. In a browser Escape fires `cancel`
 *     and then closes; here nothing happens, so the tests below dispatch the `cancel`
 *     the platform would have dispatched, and say so rather than pretending to type.
 *   - `cancel` HAS NO DEFAULT ACTION. An unprevented `cancel` leaves the dialog open,
 *     so "it did not close itself" cannot distinguish a working `preventDefault()` from
 *     a deleted one. The assertion that can is `event.defaultPrevented`, which is what
 *     is asserted.
 *   - NO FOCUS MANAGEMENT AT ALL. `showModal()` leaves focus on `<body>`; there is no
 *     focus trap, no `inert` on the background, and `:modal` matches nothing. Worse,
 *     `.focus()` succeeds on a control inside a CLOSED dialog, which a browser refuses.
 *     So "the modal traps focus" is not a claim this suite can make. What it can check
 *     is that the component asked the platform for a MODAL — `showModal()`, not `show()`
 *     — which is where every one of those behaviours actually comes from.
 *
 * AND A TRAP WORTH WRITING DOWN: a closed dialog's children are still in the document.
 * `getByText` ignores visibility and finds them; only the role queries and
 * `toBeVisible()` notice. A screen test that asserts a dialog's content with
 * `getByText` is asserting nothing about whether the dialog is open.
 */

import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import type { JSX } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Dialog } from './Dialog'

/*
 * The `cancel` a browser dispatches when Escape is pressed on a modal dialog.
 *
 * Inside `act`, because dispatching the event is not the same as waiting for what it
 * causes: a handler that calls `setOpen(false)` leaves React with a queued update, and
 * an assertion made straight afterwards reads the previous render.
 */
function pressEscape(dialog: HTMLDialogElement): Event {
  const cancel = new Event('cancel', { bubbles: false, cancelable: true })
  act(() => {
    dialog.dispatchEvent(cancel)
  })
  return cancel
}

function dialogElement(): HTMLDialogElement {
  const element = document.querySelector('dialog')
  if (!(element instanceof HTMLDialogElement)) throw new Error('No <dialog> was rendered')
  return element
}

/** A dialog React keeps open, so an attempt to close it behind React's back shows up. */
function Pinned({ onClose = () => {} }: { onClose?: () => void }): JSX.Element {
  return (
    <Dialog isOpen onClose={onClose} title="Close the period">
      <p>June is about to be closed.</p>
    </Dialog>
  )
}

/** A dialog whose `isOpen` follows `onClose`, as a screen's would. */
function Controlled({ isDismissible = true }: { isDismissible?: boolean }): JSX.Element {
  const [isOpen, setOpen] = useState(true)
  return (
    <Dialog
      isOpen={isOpen}
      onClose={() => setOpen(false)}
      title="Close the period"
      isDismissible={isDismissible}
    >
      <p>June is about to be closed.</p>
    </Dialog>
  )
}

describe('opening and closing', () => {
  it('is in the accessibility tree when open and out of it when closed', () => {
    const { rerender } = render(
      <Dialog isOpen={false} onClose={() => {}} title="Close the period">
        <p>June is about to be closed.</p>
      </Dialog>,
    )

    expect(screen.queryByRole('dialog')).toBeNull()
    /* The node IS in the document — it is `display: none`, not absent. Anything
     * asserting on a dialog's contents with getByText would pass here. */
    expect(screen.getByText('June is about to be closed.')).not.toBeVisible()
    expect(dialogElement().open).toBe(false)

    rerender(
      <Dialog isOpen onClose={() => {}} title="Close the period">
        <p>June is about to be closed.</p>
      </Dialog>,
    )

    expect(screen.getByRole('dialog')).toBeVisible()
    expect(screen.getByText('June is about to be closed.')).toBeVisible()
    expect(dialogElement().open).toBe(true)
  })

  it('closes the element again when isOpen goes false', () => {
    const { rerender } = render(
      <Dialog isOpen onClose={() => {}} title="Close the period">
        body
      </Dialog>,
    )
    expect(dialogElement().open).toBe(true)

    rerender(
      <Dialog isOpen={false} onClose={() => {}} title="Close the period">
        body
      </Dialog>,
    )

    expect(dialogElement().open).toBe(false)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  /*
   * MODAL, not merely shown. The focus trap, the inert background and the top-layer
   * stacking are all consequences of `showModal()` rather than `show()`, and happy-dom
   * implements none of them — `dialog.open` is true either way. So the only place the
   * distinction is observable here is the call itself.
   */
  it('asks the platform for a modal rather than an inline dialog', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    const show = vi.spyOn(HTMLDialogElement.prototype, 'show')

    const { rerender } = render(
      <Dialog isOpen={false} onClose={() => {}} title="Close the period">
        body
      </Dialog>,
    )
    /* Nothing is opened by mounting a closed dialog. */
    expect(showModal).not.toHaveBeenCalled()

    rerender(
      <Dialog isOpen onClose={() => {}} title="Close the period">
        body
      </Dialog>,
    )

    expect(showModal).toHaveBeenCalledTimes(1)
    expect(show).not.toHaveBeenCalled()

    showModal.mockRestore()
    show.mockRestore()
  })
})

describe('Escape', () => {
  /*
   * The element must never close itself. `isOpen` is React state; if the platform
   * closed the dialog on its own, `isOpen` would still be true and the NEXT open would
   * be a no-op — the dialog would simply stop appearing.
   */
  it('is always prevented, so the element cannot close behind React', () => {
    render(<Pinned />)

    const cancel = pressEscape(dialogElement())

    expect(cancel.defaultPrevented).toBe(true)
  })

  it('is reported as a close request', () => {
    const onClose = vi.fn()
    render(<Pinned onClose={onClose} />)

    pressEscape(dialogElement())

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('actually closes a dialog whose isOpen follows it', () => {
    render(<Controlled />)
    expect(screen.getByRole('dialog')).toBeVisible()

    pressEscape(dialogElement())

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  /* Still prevented when the dialog refuses to be dismissed — the default action is
   * what must never run; whether to close is a separate decision. */
  it('is prevented but ignored when the dialog is not dismissible', () => {
    const onClose = vi.fn()
    render(
      <Dialog isOpen onClose={onClose} title="Close the period" isDismissible={false}>
        body
      </Dialog>,
    )

    const cancel = pressEscape(dialogElement())

    expect(cancel.defaultPrevented).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeVisible()
  })
})

describe('the backdrop', () => {
  it('closes the dialog when the click lands outside the panel', async () => {
    const user = userEvent.setup()
    render(<Controlled />)

    await user.click(dialogElement())

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('leaves it open when the click lands on the panel', async () => {
    const user = userEvent.setup()
    render(<Controlled />)

    await user.click(screen.getByText('June is about to be closed.'))

    expect(screen.getByRole('dialog')).toBeVisible()
  })

  it('is inert when the dialog is not dismissible', async () => {
    const user = userEvent.setup()
    render(<Controlled isDismissible={false} />)

    await user.click(dialogElement())

    expect(screen.getByRole('dialog')).toBeVisible()
  })
})

describe('the header', () => {
  it('names the dialog with its title and describes it with its description', () => {
    render(
      <Dialog
        isOpen
        onClose={() => {}}
        title="Close the period"
        description="Entries dated in June can no longer be posted."
      >
        body
      </Dialog>,
    )

    const dialog = screen.getByRole('dialog')
    /* Exactly the title — a description must describe, never extend the name. */
    expect(dialog).toHaveAccessibleName('Close the period')
    expect(dialog).toHaveAccessibleDescription('Entries dated in June can no longer be posted.')
    expect(screen.getByRole('heading', { name: 'Close the period' })).toBeVisible()
  })

  it('carries no description when none was given', () => {
    render(
      <Dialog isOpen onClose={() => {}} title="Close the period">
        body
      </Dialog>,
    )

    expect(screen.getByRole('dialog')).toHaveAccessibleDescription('')
    expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-describedby')
  })

  it('offers a labelled close button that reports the close', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Pinned onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: 'Close' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('offers no close button when the dialog is not dismissible', () => {
    render(
      <Dialog isOpen onClose={() => {}} title="Close the period" isDismissible={false}>
        body
      </Dialog>,
    )

    /* The header is still there — only the dismissal is gone. */
    expect(screen.getByRole('heading', { name: 'Close the period' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })

  /* `isChrome={false}` is the palette's shape: it draws its own header, so the atom's
   * must not appear above it. The body still does. */
  it('is dropped entirely when the dialog supplies its own chrome', () => {
    render(
      <Dialog isOpen onClose={() => {}} isChrome={false}>
        <p>June is about to be closed.</p>
      </Dialog>,
    )

    expect(screen.getByText('June is about to be closed.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-labelledby')
  })

  /*
   * THE TRAP THE PALETTE WALKS PAST. It passes `isChrome={false}` with no title, so the
   * combination below has no caller today — and had no test either, which is how the
   * atom shipped an `aria-labelledby` pointing at an element it never rendered. The name
   * a screen reader computes from a dangling reference is `""`: an unnamed dialog, which
   * is worse than one with no `aria-labelledby` at all.
   *
   * ASSERTED AS THE ACCESSIBLE NAME, never as the presence of the attribute. The whole
   * bug was an attribute that was present and pointed nowhere, so any assertion that
   * stops at `toHaveAttribute('aria-labelledby')` passes against it.
   */
  it('still names a chromeless dialog that was given a title', () => {
    render(
      <Dialog
        isOpen
        onClose={() => {}}
        title="Close the period"
        description="Entries dated in June can no longer be posted."
        isChrome={false}
      >
        <p>June is about to be closed.</p>
      </Dialog>,
    )

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAccessibleName('Close the period')
    /* `aria-describedby` dangles in exactly the same way and for the same reason. */
    expect(dialog).toHaveAccessibleDescription('Entries dated in June can no longer be posted.')
  })

  it('names a chromeless dialog without drawing the atom’s header around it', () => {
    render(
      <Dialog isOpen onClose={() => {}} title="Search commands" isChrome={false}>
        <p>Type a command.</p>
      </Dialog>,
    )

    /* The name is carried by a real, hidden element rather than by `aria-label`, which
     * is how Input, Select and Sidebar do it — so the title is still a heading in the
     * accessibility tree and the two chrome states name the dialog the same way. */
    const heading = screen.getByRole('heading', { name: 'Search commands' })
    expect(heading).toHaveClass('visually-hidden')
    /* But no chrome: the palette draws its own header and a second one above it would
     * be a duplicate title, which is the thing `isChrome={false}` exists to prevent. */
    expect(document.querySelector('.dialog__header')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })
})

describe('the frame', () => {
  it('renders a footer only when one was given', () => {
    const { rerender } = render(
      <Dialog isOpen onClose={() => {}} title="Close the period">
        body
      </Dialog>,
    )
    expect(screen.queryByRole('button', { name: 'Close the period' })).toBeNull()

    rerender(
      <Dialog
        isOpen
        onClose={() => {}}
        title="Close the period"
        footer={<button type="button">Close the period</button>}
      >
        body
      </Dialog>,
    )

    expect(screen.getByRole('button', { name: 'Close the period' })).toBeVisible()
  })

  it('carries its size and any extra class beside the base one', () => {
    render(
      <Dialog isOpen onClose={() => {}} title="Close the period" size="lg" className="period">
        body
      </Dialog>,
    )

    expect(screen.getByRole('dialog')).toHaveClass('dialog', 'dialog--lg', 'period')
  })

  it('is medium unless a size is asked for', () => {
    render(
      <Dialog isOpen onClose={() => {}} title="Close the period">
        body
      </Dialog>,
    )

    expect(screen.getByRole('dialog')).toHaveClass('dialog--md')
  })
})

/*
 * ESCAPE NEVER THROWS TYPING AWAY WITHOUT ASKING (design system §04, rule 2).
 *
 * The question replaces the footer rather than opening a second dialog: two modals means
 * two focus traps, and the platform gives us exactly one.
 */
describe('a dialog with typing in it', () => {
  function open(onClose = vi.fn()): { onClose: ReturnType<typeof vi.fn> } {
    render(
      <Dialog
        isOpen
        hasUnsavedInput
        onClose={onClose}
        title="New customer"
        footer={<button>Add</button>}
      >
        <p>the form</p>
      </Dialog>,
    )
    return { onClose }
  }

  it('asks instead of closing, and keeps the dialog up', async () => {
    const user = userEvent.setup()
    const { onClose } = open()

    await user.click(screen.getByRole('button', { name: 'Close' }))

    expect(screen.getByText('Discard what you have typed?')).toBeVisible()
    expect(onClose).not.toHaveBeenCalled()
    /* The footer's own button is out of the way while the question stands. */
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
  })

  it('puts the form back when the answer is to keep editing', async () => {
    const user = userEvent.setup()
    const { onClose } = open()

    await user.click(screen.getByRole('button', { name: 'Close' }))
    await user.click(screen.getByRole('button', { name: 'Keep editing' }))

    expect(screen.getByRole('button', { name: 'Add' })).toBeVisible()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes once discarding is chosen', async () => {
    const user = userEvent.setup()
    const { onClose } = open()

    await user.click(screen.getByRole('button', { name: 'Close' }))
    await user.click(screen.getByRole('button', { name: 'Discard' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('asks on Escape as well', () => {
    const onClose = vi.fn()
    open(onClose)

    /* The `cancel` a browser dispatches for Escape. See the header: happy-dom does not. */
    pressEscape(dialogElement())

    expect(screen.getByText('Discard what you have typed?')).toBeVisible()
    expect(onClose).not.toHaveBeenCalled()
  })

  /* A dialog that only reads — a confirmation, a delete — has nothing to lose. */
  it('closes straight away when nothing has been typed', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <Dialog
        isOpen
        onClose={onClose}
        title="Delete Bharat Steel?"
        footer={<button>Delete</button>}
      >
        <p>gone for good</p>
      </Dialog>,
    )

    await user.click(screen.getByRole('button', { name: 'Close' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Discard what you have typed?')).toBeNull()
  })
})
