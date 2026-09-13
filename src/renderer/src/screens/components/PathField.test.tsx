/*
 * The path field, rendered.
 *
 * A path is CHOSEN, never typed — the renderer cannot browse a filesystem, and the same
 * native dialog that returns the path is what puts it on the main process's allowlist
 * for revealing later. So the two things worth proving here are that the field offers no
 * way to type one, and that the button is wired to the chooser.
 *
 * THE REST IS THE ACCESSIBLE NAME, ASSERTED BY VALUE. This field is a `<p>` labelled by
 * a `<span>` — not a `<label>` and not a control — so nothing about it is guaranteed by
 * the platform, and `getByLabelText` is the query that notices when the association
 * breaks. The hint has to reach the DESCRIPTION and stay out of the NAME: a hint folded
 * into the name is heard on every focus, ahead of the path the user is trying to read.
 */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PathField } from './PathField'

/* The real copy from the create screen. Long, and a sentence rather than a word —
 * a hint that leaked into a name would be unmistakable. */
const HINT = 'Both files go here, side by side. Somewhere you back up — not a temporary folder.'

const CHOSEN = 'D:\\Books\\Kaveri Traders'

function renderField(over: Partial<Parameters<typeof PathField>[0]> = {}) {
  return render(
    <PathField
      label="Keep it in"
      value={CHOSEN}
      placeholder="No folder chosen"
      buttonLabel="Choose folder"
      onChoose={() => {}}
      {...over}
    />,
  )
}

describe('PathField', () => {
  it('is named by its label and nothing else', () => {
    renderField({ hint: HINT })

    const value = screen.getByLabelText('Keep it in')

    /* Exactly the label. The hint below is guidance, not part of what this field is
     * called, and a screen reader that reads both on focus buries the path. */
    expect(value).toHaveAccessibleName('Keep it in')
    expect(value).toHaveAccessibleDescription(HINT)
  })

  it('shows the chosen path, and offers no way to type one', () => {
    const { container } = renderField()

    expect(screen.getByLabelText('Keep it in')).toHaveTextContent(CHOSEN)
    /* The whole premise of the component. A textbox here would be a path main never
     * vouched for, and one it would refuse to reveal. */
    expect(within(container).queryByRole('textbox')).toBeNull()
  })

  it('carries the full path in a tooltip, so a long one can still be read', () => {
    const long = `D:\\Accounts\\${'Kaveri Traders Private Limited\\'.repeat(8)}Books`
    renderField({ value: long })

    const value = screen.getByLabelText('Keep it in')
    expect(value).toHaveTextContent(long)
    expect(value).toHaveAttribute('title', long)
    /* Marked selectable, because the one thing anyone wants to do with a path is copy
     * it into a support message. */
    expect(value.className).toContain('selectable')
  })

  it('shows the placeholder before a path is chosen, and marks it as not a path', () => {
    renderField({ value: '' })

    const value = screen.getByLabelText('Keep it in')
    expect(value).toHaveTextContent('No folder chosen')
    /* No tooltip: a title repeating the placeholder tells nobody anything, and a title
     * holding the empty string is a browser artefact. */
    expect(value).not.toHaveAttribute('title')
    /* Dimmed, and not offered for copying — there is nothing there to copy. */
    expect(value.className).toContain('path-field__value--empty')
    expect(value.className).not.toContain('selectable')
  })

  it('asks the screen to open the chooser, once per click', async () => {
    const user = userEvent.setup()
    const onChoose = vi.fn()
    renderField({ onChoose })

    await user.click(screen.getByRole('button', { name: 'Choose folder' }))

    expect(onChoose).toHaveBeenCalledTimes(1)
  })

  it('takes the button word from the caller', () => {
    /* Three screens use this field and each names the thing it is choosing. A hardcoded
     * "Browse" would read wrongly on two of them. */
    renderField({ buttonLabel: 'Find the company file' })
    expect(screen.getByRole('button', { name: 'Find the company file' })).toBeInTheDocument()
  })

  it('refuses the click when disabled', async () => {
    const user = userEvent.setup()
    const onChoose = vi.fn()
    renderField({ onChoose, isDisabled: true })

    const button = screen.getByRole('button', { name: 'Choose folder' })
    expect(button).toBeDisabled()
    await user.click(button)
    expect(onChoose).not.toHaveBeenCalled()
  })

  it('is enabled unless told otherwise', () => {
    renderField()
    expect(screen.getByRole('button', { name: 'Choose folder' })).toBeEnabled()
  })

  it('replaces the hint with the error, and says the error out loud', () => {
    const error = 'Choose the folder to keep this company in.'
    renderField({ value: '', hint: HINT, error })

    /* `error ?? hint` — one message, not two stacked. The hint is guidance about a
     * decision that has already gone wrong. */
    expect(screen.getByRole('alert')).toHaveTextContent(error)
    expect(screen.getByLabelText('Keep it in')).toHaveAccessibleDescription(error)
    /* The name is still the label: an error is not what the field is called. */
    expect(screen.getByLabelText('Keep it in')).toHaveAccessibleName('Keep it in')
  })

  it('does not interrupt for a hint the way it does for an error', () => {
    const { container } = renderField({ hint: HINT })

    /* A standing hint is read when the field is reached; an error interrupts. Only one
     * of the two is an alert, and the component decides which by which prop arrived. */
    expect(within(container).queryByRole('alert')).toBeNull()
    expect(screen.getByText(HINT)).toBeInTheDocument()
  })

  it('describes nothing when there is neither hint nor error', () => {
    renderField()

    /* Not an empty description — no description at all. A dangling `aria-describedby`
     * pointing at a paragraph that was never rendered is a name-and-description bug
     * that reads as silence in some screen readers and as the id string in others. */
    expect(screen.getByLabelText('Keep it in')).not.toHaveAttribute('aria-describedby')
  })

  it('gives each field its own label, so two on one screen do not swap paths', () => {
    const archive = 'E:\\Backups\\kaveri.coffer-backup.zip'
    render(
      <>
        <PathField
          label="Keep it in"
          value={CHOSEN}
          placeholder="No folder chosen"
          buttonLabel="Choose folder"
          onChoose={() => {}}
        />
        <PathField
          label="Restore from"
          value={archive}
          placeholder="No backup chosen"
          buttonLabel="Choose backup"
          onChoose={() => {}}
        />
      </>,
    )

    /* Each name resolves to its own value. Shared ids would give both fields the first
     * label and both paths would answer to the same query. */
    expect(screen.getByLabelText('Keep it in')).toHaveTextContent(CHOSEN)
    expect(screen.getByLabelText('Restore from')).toHaveTextContent(archive)
  })
})
