/*
 * The labelled text field.
 *
 * THIS FILE EXISTS BECAUSE OF ONE BUG, WRITTEN TWICE. The tempting shape for a field is
 * `<label className="field">` wrapped around the control, and it is fine until the field
 * grows a hint — at which point the hint's text becomes part of the control's ACCESSIBLE
 * NAME. A screen reader then announces three sentences where the label is two words, and
 * `getByLabelText` stops finding the field at all. `Select` next door was extracted for
 * exactly this reason (see its header).
 *
 * So the assertions here are deliberately about the NAME and not about the markup:
 * queried by label, and checked for what a screen-reader user actually hears. Every
 * query by label in this project is an accessibility assertion whether or not it was
 * written as one; these are written as one.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import type { JSX } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Input } from './Input'

describe('the accessible name', () => {
  it('is exactly the label when the field has no hint', () => {
    render(<Input label="Legal name" />)

    expect(screen.getByLabelText('Legal name')).toHaveAccessibleName('Legal name')
  })

  /*
   * THE REGRESSION. The hint must describe the field, never extend its name. Asserting
   * that `getByLabelText` finds something is not enough — a hint inside the label makes
   * the name "Legal name As it appears on the certificate of incorporation." and a query
   * for the substring would still succeed under `{ exact: false }`.
   */
  it('is still exactly the label when the field has a hint', () => {
    render(<Input label="Legal name" hint="As it appears on the certificate of incorporation." />)

    const field = screen.getByLabelText('Legal name')
    expect(field).toHaveAccessibleName('Legal name')
    expect(field).toHaveAccessibleDescription('As it appears on the certificate of incorporation.')
  })

  it('is still exactly the label when the field is in error', () => {
    render(<Input label="Legal name" error="Enter the name on the incorporation certificate." />)

    const field = screen.getByLabelText('Legal name')
    expect(field).toHaveAccessibleName('Legal name')
    expect(field).toHaveAccessibleDescription('Enter the name on the incorporation certificate.')
  })

  it('survives hiding the label — hidden visually is not hidden from a reader', () => {
    render(<Input label="Search accounts" isLabelHidden />)

    const field = screen.getByLabelText('Search accounts')
    expect(field).toHaveAccessibleName('Search accounts')
    expect(screen.getByText('Search accounts')).toHaveClass('visually-hidden')
  })

  it('shows the label when it is not hidden', () => {
    render(<Input label="Legal name" />)

    expect(screen.getByText('Legal name')).toHaveClass('field__label')
  })
})

describe('the message under the field', () => {
  it('carries no description at all when there is neither hint nor error', () => {
    render(<Input label="Legal name" />)

    const field = screen.getByLabelText('Legal name')
    expect(field).toHaveAccessibleDescription('')
    expect(field).not.toHaveAttribute('aria-describedby')
  })

  it('replaces the hint with the error rather than showing both', () => {
    const { rerender } = render(<Input label="Legal name" hint="As registered." />)
    expect(screen.getByText('As registered.')).toBeVisible()

    rerender(<Input label="Legal name" hint="As registered." error="This name is already used." />)

    expect(screen.getByText('This name is already used.')).toBeVisible()
    expect(screen.queryByText('As registered.')).toBeNull()
  })

  /* A validation failure interrupts; a hint that was always there does not. */
  it('is an alert when it is an error and not when it is a hint', () => {
    const { rerender } = render(<Input label="Legal name" hint="As registered." />)
    expect(screen.getByText('As registered.')).toBeVisible()
    expect(screen.queryByRole('alert')).toBeNull()

    rerender(<Input label="Legal name" error="This name is already used." />)

    expect(screen.getByRole('alert')).toHaveTextContent('This name is already used.')
  })

  it('styles a hint and an error differently', () => {
    const { rerender } = render(<Input label="Legal name" hint="As registered." />)
    expect(screen.getByText('As registered.')).toHaveClass('field__hint')

    rerender(<Input label="Legal name" error="This name is already used." />)
    expect(screen.getByText('This name is already used.')).toHaveClass('field__error')
  })
})

describe('validity', () => {
  it('is not marked invalid while it merely has a hint', () => {
    render(<Input label="Legal name" hint="As registered." />)

    expect(screen.getByLabelText('Legal name')).not.toHaveAttribute('aria-invalid')
  })

  it('is marked invalid when it has an error', () => {
    render(<Input label="Legal name" error="This name is already used." />)

    expect(screen.getByLabelText('Legal name')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Legal name')).toBeInvalid()
  })

  /* An empty error is still an error. `error === undefined` is the condition, not
   * truthiness — a validator that returns '' would otherwise silently mark the field
   * valid while rendering an empty alert. */
  it('is marked invalid by an error with no words in it', () => {
    render(<Input label="Legal name" error="" />)

    expect(screen.getByLabelText('Legal name')).toHaveAttribute('aria-invalid', 'true')
  })
})

describe('what the user types', () => {
  /** Records every value that reached the owner, not only what the DOM shows. */
  function Host({ onValue }: { onValue: (value: string) => void }): JSX.Element {
    const [value, setValue] = useState('')
    return (
      <Input
        label="Legal name"
        value={value}
        onChange={(event) => {
          setValue(event.target.value)
          onValue(event.target.value)
        }}
      />
    )
  }

  it('reaches the owner one keystroke at a time', async () => {
    const user = userEvent.setup()
    const onValue = vi.fn()
    render(<Host onValue={onValue} />)

    await user.type(screen.getByLabelText('Legal name'), 'Acme')

    expect(onValue.mock.calls.map(([value]) => value)).toEqual(['A', 'Ac', 'Acm', 'Acme'])
    expect(screen.getByLabelText('Legal name')).toHaveValue('Acme')
  })

  it('takes nothing while it is disabled', async () => {
    const user = userEvent.setup()
    const onValue = vi.fn()
    render(
      <Input
        label="Legal name"
        disabled
        value=""
        onChange={(event) => onValue(event.target.value)}
      />,
    )

    const field = screen.getByLabelText('Legal name')
    expect(field).toBeDisabled()
    await user.type(field, 'Acme')

    expect(onValue).not.toHaveBeenCalled()
    expect(field).toHaveValue('')
  })
})

describe('the wiring', () => {
  it('ties the label and the message to an id supplied from outside', () => {
    render(<Input label="Legal name" id="company-name" hint="As registered." />)

    const field = screen.getByLabelText('Legal name')
    expect(field).toHaveAttribute('id', 'company-name')
    expect(field).toHaveAttribute('aria-describedby', 'company-name-message')
    expect(document.getElementById('company-name-message')).toHaveTextContent('As registered.')
  })

  it('generates its own id when none is given, and points the label at it', () => {
    render(<Input label="Legal name" hint="As registered." />)

    const field = screen.getByLabelText('Legal name')
    const id = field.getAttribute('id')
    expect(id).toBeTruthy()
    expect(field).toHaveAttribute('aria-describedby', `${id}-message`)
  })

  it('keeps two fields on the same screen apart', () => {
    render(
      <>
        <Input label="Legal name" />
        <Input label="Trade name" />
      </>,
    )

    const legal = screen.getByLabelText('Legal name')
    const trade = screen.getByLabelText('Trade name')
    expect(legal.getAttribute('id')).not.toBe(trade.getAttribute('id'))
  })

  it('passes the ordinary input attributes through', () => {
    render(<Input label="Effective from" type="date" required placeholder="YYYY-MM-DD" />)

    const field = screen.getByLabelText('Effective from')
    expect(field).toHaveAttribute('type', 'date')
    expect(field).toBeRequired()
    expect(field).toHaveAttribute('placeholder', 'YYYY-MM-DD')
  })
})

describe('the icon slot', () => {
  it('draws a decorative icon that stays out of the name', () => {
    render(<Input label="Search accounts" icon="search" />)

    const field = screen.getByLabelText('Search accounts')
    expect(field).toHaveAccessibleName('Search accounts')
    const control = field.parentElement
    expect(control).toHaveClass('field__control', 'field__control--with-icon')
    expect(control?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('leaves the control unadorned when there is no icon', () => {
    render(<Input label="Legal name" />)

    const control = screen.getByLabelText('Legal name').parentElement
    expect(control).toHaveClass('field__control')
    expect(control).not.toHaveClass('field__control--with-icon')
    expect(control?.querySelector('svg')).toBeNull()
  })
})
