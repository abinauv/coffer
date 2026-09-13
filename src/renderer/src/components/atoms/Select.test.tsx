/*
 * The labelled `<select>`.
 *
 * This atom exists because the hint-inside-the-label bug was written by hand twice in
 * one batch (see the component's header), so the first half of this file is the same
 * accessibility assertion as `Input`'s, made against the other control: queried BY
 * LABEL, and checked for the name a screen-reader user actually hears rather than for
 * the presence of an element.
 *
 * The second half is about a trap that belongs to `<select>` specifically. A select
 * whose chosen option is not among its options falls back to the first one ON ITS OWN,
 * so the field can read perfectly while the state behind it is stale or wrong. The
 * consequence for tests is stated in CONVENTIONS §6 and honoured here: what is asserted
 * is the value that CROSSED THE BOUNDARY into the owner, not the option the browser
 * settled on.
 */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import type { JSX } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Select } from './Select'

/*
 * Deliberately out of the order the screen would show them, and with values that are
 * not their labels. A fixture listed alphabetically cannot tell a select that reports
 * the chosen VALUE from one that reports its label or its index.
 */
const JURISDICTIONS = [
  { code: '33', name: 'Tamil Nadu' },
  { code: '29', name: 'Karnataka' },
  { code: '27', name: 'Maharashtra' },
]

function options(): JSX.Element {
  return (
    <>
      {JURISDICTIONS.map((jurisdiction) => (
        <option key={jurisdiction.code} value={jurisdiction.code}>
          {jurisdiction.name}
        </option>
      ))}
    </>
  )
}

describe('the accessible name', () => {
  it('is exactly the label when the field has no hint', () => {
    render(<Select label="Place of supply">{options()}</Select>)

    expect(screen.getByLabelText('Place of supply')).toHaveAccessibleName('Place of supply')
  })

  /*
   * THE REGRESSION THIS ATOM WAS EXTRACTED FOR. With the hint inside the label the name
   * becomes "Place of supply Where the goods are delivered…", which is what a screen
   * reader would say and what `getByLabelText` would then fail to find.
   */
  it('is still exactly the label when the field has a hint', () => {
    render(
      <Select label="Place of supply" hint="Where the goods are delivered.">
        {options()}
      </Select>,
    )

    const field = screen.getByLabelText('Place of supply')
    expect(field).toHaveAccessibleName('Place of supply')
    expect(field).toHaveAccessibleDescription('Where the goods are delivered.')
  })

  it('is still exactly the label when the field is in error', () => {
    render(
      <Select label="Place of supply" error="Choose the state the goods are delivered to.">
        {options()}
      </Select>,
    )

    const field = screen.getByLabelText('Place of supply')
    expect(field).toHaveAccessibleName('Place of supply')
    expect(field).toHaveAccessibleDescription('Choose the state the goods are delivered to.')
  })

  it('survives hiding the label', () => {
    render(
      <Select label="Place of supply" isLabelHidden>
        {options()}
      </Select>,
    )

    expect(screen.getByLabelText('Place of supply')).toHaveAccessibleName('Place of supply')
    expect(screen.getByText('Place of supply')).toHaveClass('visually-hidden')
  })
})

describe('the message under the field', () => {
  it('carries no description at all when there is neither hint nor error', () => {
    render(<Select label="Place of supply">{options()}</Select>)

    const field = screen.getByLabelText('Place of supply')
    expect(field).toHaveAccessibleDescription('')
    expect(field).not.toHaveAttribute('aria-describedby')
  })

  it('replaces the hint with the error rather than showing both', () => {
    const { rerender } = render(
      <Select label="Place of supply" hint="Where the goods are delivered.">
        {options()}
      </Select>,
    )
    expect(screen.getByText('Where the goods are delivered.')).toBeVisible()

    rerender(
      <Select label="Place of supply" hint="Where the goods are delivered." error="Choose a state.">
        {options()}
      </Select>,
    )

    expect(screen.getByText('Choose a state.')).toBeVisible()
    expect(screen.queryByText('Where the goods are delivered.')).toBeNull()
  })

  it('is an alert when it is an error and not when it is a hint', () => {
    const { rerender } = render(
      <Select label="Place of supply" hint="Where the goods are delivered.">
        {options()}
      </Select>,
    )
    expect(screen.getByText('Where the goods are delivered.')).toHaveClass('field__hint')
    expect(screen.queryByRole('alert')).toBeNull()

    rerender(
      <Select label="Place of supply" error="Choose a state.">
        {options()}
      </Select>,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Choose a state.')
    expect(screen.getByText('Choose a state.')).toHaveClass('field__error')
  })
})

describe('validity', () => {
  it('is not marked invalid while it merely has a hint', () => {
    render(
      <Select label="Place of supply" hint="Where the goods are delivered.">
        {options()}
      </Select>,
    )

    expect(screen.getByLabelText('Place of supply')).not.toHaveAttribute('aria-invalid')
  })

  it('is marked invalid when it has an error', () => {
    render(
      <Select label="Place of supply" error="Choose a state.">
        {options()}
      </Select>,
    )

    expect(screen.getByLabelText('Place of supply')).toBeInvalid()
  })
})

describe('choosing an option', () => {
  /** Records the value the owner was handed, which is the only thing it acts on. */
  function Host({ onValue }: { onValue: (value: string) => void }): JSX.Element {
    const [value, setValue] = useState('33')
    return (
      <Select
        label="Place of supply"
        value={value}
        onChange={(event) => {
          setValue(event.target.value)
          onValue(event.target.value)
        }}
      >
        {options()}
      </Select>
    )
  }

  it('lists every option, in the order it was given them', () => {
    render(<Select label="Place of supply">{options()}</Select>)

    const field = screen.getByLabelText('Place of supply')
    const labels = within(field)
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(labels).toEqual(['Tamil Nadu', 'Karnataka', 'Maharashtra'])
  })

  /*
   * THE VALUE, NOT THE LABEL, AND NOT THE INDEX. Karnataka is neither the first option
   * nor the one that was selected, and its code is neither its label nor its position —
   * so a component reporting any of those three would be visible here.
   */
  it('hands the owner the value behind the option that was chosen', async () => {
    const user = userEvent.setup()
    const onValue = vi.fn()
    render(<Host onValue={onValue} />)

    await user.selectOptions(screen.getByLabelText('Place of supply'), 'Karnataka')

    expect(onValue.mock.calls).toEqual([['29']])
    expect(screen.getByLabelText('Place of supply')).toHaveValue('29')
  })

  /*
   * AND WHY THE ASSERTION ABOVE IS ON THE CALLBACK. Hand the field a value no option
   * carries — a jurisdiction dropped from the regime, a stale draft — and the browser
   * silently shows the FIRST option instead. Nothing about the rendered field says the
   * state behind it is wrong, which is precisely why a screen test that reads the
   * displayed value is not testing the screen's state.
   */
  it('shows its first option when handed a value none of them carry', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <Select label="Place of supply" value="07" onChange={() => {}}>
        {options()}
      </Select>,
    )

    const field = screen.getByLabelText('Place of supply')
    expect(field).toHaveValue('33')
    expect(field).not.toHaveValue('07')

    quiet.mockRestore()
  })

  it('takes nothing while it is disabled', async () => {
    const user = userEvent.setup()
    const onValue = vi.fn()
    render(
      <Select
        label="Place of supply"
        disabled
        value="33"
        onChange={(event) => onValue(event.target.value)}
      >
        {options()}
      </Select>,
    )

    const field = screen.getByLabelText('Place of supply')
    expect(field).toBeDisabled()
    await user.selectOptions(field, 'Karnataka').catch(() => {})

    expect(onValue).not.toHaveBeenCalled()
    expect(field).toHaveValue('33')
  })
})

describe('the wiring', () => {
  it('ties the label and the message to an id supplied from outside', () => {
    render(
      <Select label="Place of supply" id="place-of-supply" hint="Where the goods are delivered.">
        {options()}
      </Select>,
    )

    const field = screen.getByLabelText('Place of supply')
    expect(field).toHaveAttribute('id', 'place-of-supply')
    expect(field).toHaveAttribute('aria-describedby', 'place-of-supply-message')
    expect(document.getElementById('place-of-supply-message')).toHaveTextContent(
      'Where the goods are delivered.',
    )
  })

  it('keeps two fields on the same screen apart', () => {
    render(
      <>
        <Select label="Place of supply">{options()}</Select>
        <Select label="Place of origin">{options()}</Select>
      </>,
    )

    expect(screen.getByLabelText('Place of supply').getAttribute('id')).not.toBe(
      screen.getByLabelText('Place of origin').getAttribute('id'),
    )
  })

  it('puts the label, the control and the message side by side rather than nested', () => {
    const { container } = render(
      <Select label="Place of supply" hint="Where the goods are delivered.">
        {options()}
      </Select>,
    )

    /* The structural half of the same bug: a control INSIDE the label is what makes the
     * hint join the name. All three are children of the field wrapper. */
    const field = container.querySelector('.field')
    expect(field?.querySelector('label')?.querySelector('select')).toBeNull()
    expect([...(field?.children ?? [])].map((child) => child.tagName)).toEqual([
      'LABEL',
      'SELECT',
      'P',
    ])
  })

  it('carries an extra class on the field without dropping its own', () => {
    const { container } = render(
      <Select label="Place of supply" className="editor__place">
        {options()}
      </Select>,
    )

    expect(container.querySelector('.field')).toHaveClass('field', 'editor__place')
  })

  it('passes the ordinary select attributes through', () => {
    render(
      <Select label="Place of supply" name="placeOfSupply" required>
        {options()}
      </Select>,
    )

    const field = screen.getByLabelText('Place of supply')
    expect(field).toHaveAttribute('name', 'placeOfSupply')
    expect(field).toBeRequired()
  })
})
