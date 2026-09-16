/*
 * The one keyboard listener.
 *
 * Every binding in the product goes through it, so what it refuses to do matters as much
 * as what it does. The case below was found in the running app and not in any test:
 * pressing Escape on the issue confirmation left the dialog stuck open, because the
 * editor's own "step back" command matched the same key, called `preventDefault`, and the
 * platform closes a `<dialog>` as the DEFAULT ACTION of that keystroke.
 *
 * happy-dom does not close a dialog on Escape at all (see Dialog.test.tsx), so "the dialog
 * closed" is not a claim this file can make. What it can hold is the half that was wrong:
 * the command must not run, and the keystroke must not be swallowed.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useMemo } from 'react'
import type { JSX } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Command } from '../lib/command-registry'
import { SHORTCUTS } from '../lib/shortcuts'
import { PlatformProvider } from './platform'
import { CommandProvider, useRegisterCommands } from './commands'

const stepBack = vi.fn()
const save = vi.fn()

function Screen(): JSX.Element {
  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: 'test.step-back',
          title: 'Back to the register',
          section: 'Test',
          shortcut: SHORTCUTS.stepBack,
          run: stepBack,
        },
        {
          id: 'test.save',
          title: 'Save this draft',
          section: 'Test',
          shortcut: SHORTCUTS.save,
          run: save,
        },
      ],
      [],
    ),
  )
  return <input aria-label="Narration" />
}

function mount({ withDialog = false } = {}): void {
  render(
    <PlatformProvider>
      <CommandProvider>
        <Screen />
        {withDialog && (
          <dialog open aria-label="Issue this sales invoice?">
            <p>the question</p>
          </dialog>
        )}
      </CommandProvider>
    </PlatformProvider>,
  )
}

beforeEach(() => {
  stepBack.mockClear()
  save.mockClear()
})

describe('the keyboard listener', () => {
  it('runs a command on its shortcut', async () => {
    const user = userEvent.setup()
    mount()

    await user.keyboard('{Escape}')
    expect(stepBack).toHaveBeenCalledTimes(1)
  })

  /* Escape types nothing, so a field has no claim on it. */
  it('runs Escape from inside a field', async () => {
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByLabelText('Narration'))
    await user.keyboard('{Escape}')

    expect(stepBack).toHaveBeenCalledTimes(1)
  })

  /* THE ONE THIS FILE EXISTS FOR. */
  it('leaves Escape to a modal dialog while one is open', async () => {
    const user = userEvent.setup()
    mount({ withDialog: true })

    await user.keyboard('{Escape}')

    expect(stepBack).not.toHaveBeenCalled()
  })

  it('does not swallow the keystroke the dialog needs', () => {
    mount({ withDialog: true })

    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
    window.dispatchEvent(event)

    /* Prevented, and the platform never closes the dialog. */
    expect(event.defaultPrevented).toBe(false)
  })

  /* A dialog owns Escape, not the whole keyboard: Ctrl S still reaches the screen, which
   * is what a dialog over a half-typed draft needs. */
  it('still runs the other bindings while a dialog is open', async () => {
    const user = userEvent.setup()
    mount({ withDialog: true })

    await user.keyboard('{Control>}s{/Control}')

    expect(save).toHaveBeenCalledTimes(1)
  })
})
