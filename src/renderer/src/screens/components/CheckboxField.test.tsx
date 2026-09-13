/*
 * The checkbox atom, rendered.
 *
 * EVERY QUERY HERE GOES THROUGH THE LABEL, deliberately. `getByLabelText` is the only
 * query that fails when the box and the words beside it come apart — a `htmlFor` that
 * points at nothing, or two fields on one screen sharing an id — and both of those look
 * perfect in a screenshot and are unusable with a pointer or a screen reader.
 *
 * And the assertion is `toHaveAccessibleName` with the WHOLE sentence, not a substring.
 * The children of this component go INSIDE the `<label>`, so anything a caller nests
 * there becomes part of the name a screen-reader user hears. A test that only checked
 * the box could be found would not notice the difference — and neither would one that
 * looked for the label's words as a substring, which is why the `hint` tests below pin
 * the name entire: a nested hint EXTENDS the name rather than replacing it.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import type { JSX } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { CheckboxField } from './CheckboxField'

/* The real sentence from RecoveryCodesStep — the one tick in the product that costs the
 * user their books if it is wrong. Long on purpose: a name is the whole label. */
const ACKNOWLEDGEMENT =
  'I have saved these codes somewhere other than this computer, and I understand that ' +
  'losing them and the passphrase means losing these books.'

/** A checkbox whose state is held by a parent, as a screen's is. */
function Controlled({
  initial = false,
  onChange,
}: {
  initial?: boolean
  onChange?: (isChecked: boolean) => void
}): JSX.Element {
  const [isChecked, setChecked] = useState(initial)
  return (
    <CheckboxField
      isChecked={isChecked}
      onChange={(next) => {
        setChecked(next)
        onChange?.(next)
      }}
    >
      Show archived
    </CheckboxField>
  )
}

describe('CheckboxField', () => {
  it('is found by its words, and hears exactly those words', () => {
    render(
      <CheckboxField isChecked={false} onChange={() => {}}>
        {ACKNOWLEDGEMENT}
      </CheckboxField>,
    )

    const box = screen.getByLabelText(ACKNOWLEDGEMENT)
    expect(box).toBeInstanceOf(HTMLInputElement)
    expect(box).toHaveAttribute('type', 'checkbox')
    /* The whole sentence, not a fragment of it. Half a warning is not a warning. */
    expect(box).toHaveAccessibleName(ACKNOWLEDGEMENT)
  })

  it('draws the state it was given, in both directions', () => {
    /* Both, because a component that ignores the prop and always renders unchecked
     * passes the first half on its own. */
    const { unmount } = render(
      <CheckboxField isChecked onChange={() => {}}>
        Show archived
      </CheckboxField>,
    )
    expect(screen.getByLabelText('Show archived')).toBeChecked()
    unmount()

    render(
      <CheckboxField isChecked={false} onChange={() => {}}>
        Show archived
      </CheckboxField>,
    )
    expect(screen.getByLabelText('Show archived')).not.toBeChecked()
  })

  it('reports the state the box has arrived at, not the one it left', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)

    await user.click(screen.getByLabelText('Show archived'))
    expect(onChange).toHaveBeenLastCalledWith(true)

    /* The other direction. `onChange(true)` unconditionally satisfies the first
     * assertion, and a screen wired to it would never let anything be unticked. */
    await user.click(screen.getByLabelText('Show archived'))
    expect(onChange).toHaveBeenLastCalledWith(false)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('clicking the words works, not only the box itself', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <CheckboxField isChecked={false} onChange={onChange}>
        {ACKNOWLEDGEMENT}
      </CheckboxField>,
    )

    /* The point of the component: a 13px square is not a target, the sentence is. */
    await user.click(screen.getByText(ACKNOWLEDGEMENT))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('does not tick itself when the screen ignores the change', async () => {
    const user = userEvent.setup()
    render(
      <CheckboxField isChecked={false} onChange={() => {}}>
        Show archived
      </CheckboxField>,
    )

    await user.click(screen.getByLabelText('Show archived'))

    /* Controlled, not self-managing. An uncontrolled box would show a tick the state
     * behind it never took — which is how a screen ends up submitting one answer while
     * showing the other. */
    expect(screen.getByLabelText('Show archived')).not.toBeChecked()
  })

  it('is enabled unless told otherwise', () => {
    render(
      <CheckboxField isChecked={false} onChange={() => {}}>
        Show archived
      </CheckboxField>,
    )
    expect(screen.getByLabelText('Show archived')).toBeEnabled()
  })

  it('refuses the click when disabled', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <CheckboxField isChecked={false} onChange={onChange} isDisabled>
        Show archived
      </CheckboxField>,
    )

    const box = screen.getByLabelText('Show archived')
    expect(box).toBeDisabled()
    await user.click(box)
    /* Both halves: disabled and inert. A `disabled` attribute with a live handler
     * behind it is a control that looks refused and is not. */
    expect(onChange).not.toHaveBeenCalled()
  })

  it('stays ticked while disabled rather than reading as unticked', () => {
    /* A bad state handed over directly: checked and disabled at once. A screen that
     * disables the acknowledgement after it is given must not appear to withdraw it. */
    render(
      <CheckboxField isChecked onChange={() => {}} isDisabled>
        {ACKNOWLEDGEMENT}
      </CheckboxField>,
    )

    const box = screen.getByLabelText(ACKNOWLEDGEMENT)
    expect(box).toBeChecked()
    expect(box).toBeDisabled()
  })

  /*
   * THE HINT SLOT, WHICH EXISTS BECAUSE THE LABEL IS THE NAME.
   *
   * Before 0016 there was nowhere to put guidance but `children`, and `children` are
   * rendered inside the `<label>` — so a caller nesting a sentence of explanation got it
   * welded onto the accessible name and read out on every visit to the box. Both callers
   * in the product pass a plain phrase, so this was latent; the next one would not have
   * noticed until somebody used the product with a screen reader.
   */
  it('keeps a hint out of the name and puts it in the description', () => {
    render(
      <CheckboxField
        isChecked={false}
        onChange={() => {}}
        hint="Archived accounts are hidden by default."
      >
        Show archived
      </CheckboxField>,
    )

    const box = screen.getByLabelText('Show archived')
    /* The name is the LABEL and nothing else. Asserted as the whole name rather than by
     * substring: 'Show archived' is a substring of 'Show archived Archived accounts are
     * hidden by default.', so a substring match passes against the bug this fixes. */
    expect(box).toHaveAccessibleName('Show archived')
    expect(box).toHaveAccessibleDescription('Archived accounts are hidden by default.')
  })

  it('carries no description when there is no hint', () => {
    /* The other side of the condition. An `aria-describedby` pointing at an element that
     * was never rendered names an empty description, which announces the control as
     * described-by-nothing rather than as undescribed. */
    render(
      <CheckboxField isChecked={false} onChange={() => {}}>
        Show archived
      </CheckboxField>,
    )

    const box = screen.getByLabelText('Show archived')
    expect(box).not.toHaveAttribute('aria-describedby')
    expect(box).toHaveAccessibleDescription('')
  })

  it('gives each field its own hint, so one box is not described by another', () => {
    /* Two on a screen, as the party editor has. Ids are derived from the same `useId`
     * as the label's, so a hint id that was a constant would point both boxes at the
     * first hint — invisible on screen and wrong to anyone listening. */
    render(
      <>
        <CheckboxField isChecked={false} onChange={() => {}} hint="They receive invoices.">
          We sell to them
        </CheckboxField>
        <CheckboxField isChecked={false} onChange={() => {}} hint="They send us bills.">
          We buy from them
        </CheckboxField>
      </>,
    )

    expect(screen.getByLabelText('We sell to them')).toHaveAccessibleDescription(
      'They receive invoices.',
    )
    expect(screen.getByLabelText('We buy from them')).toHaveAccessibleDescription(
      'They send us bills.',
    )
  })

  it('still hits the box when the words are clicked, with a hint beside them', async () => {
    /* The hint is outside the `<label>` now, so it must not have become a second target
     * — nor must the label have stopped being one. */
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <CheckboxField isChecked={false} onChange={onChange} hint="Only you can see this.">
        Show archived
      </CheckboxField>,
    )

    await user.click(screen.getByText('Only you can see this.'))
    expect(onChange).not.toHaveBeenCalled()

    await user.click(screen.getByText('Show archived'))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('gives each field its own id, so two on one screen do not steal each other', async () => {
    const user = userEvent.setup()
    const onCustomer = vi.fn()
    const onVendor = vi.fn()

    /* The pair from the party editor. They shared an id once and clicking either
     * sentence toggled the first box — invisible in a screenshot, wrong in the data. */
    render(
      <>
        <CheckboxField isChecked={false} onChange={onCustomer}>
          We sell to them
        </CheckboxField>
        <CheckboxField isChecked={false} onChange={onVendor}>
          We buy from them
        </CheckboxField>
      </>,
    )

    await user.click(screen.getByText('We buy from them'))

    expect(onVendor).toHaveBeenCalledWith(true)
    expect(onCustomer).not.toHaveBeenCalled()
  })
})
