/*
 * The money field.
 *
 * What is covered: the symbol is the REGIME's, the value comes back exactly as typed, and
 * the field keeps the atom's name and description. The atom's own behaviour — hint,
 * error, the disabled reason — is tested in Input.test.tsx and not repeated here.
 */

import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import type { JSX } from 'react'
import { describe, expect, it } from 'vitest'
import { DEFAULT_REGIME, renderScreen } from '@renderer/test/harness'
import { MoneyField } from './MoneyField'

function Controlled(): JSX.Element {
  const [value, setValue] = useState('')
  return (
    <>
      <MoneyField label="Amount" value={value} onChange={(event) => setValue(event.target.value)} />
      <output aria-label="typed">{value}</output>
    </>
  )
}

describe('MoneyField', () => {
  it('writes the currency symbol the regime gives, beside the value', () => {
    renderScreen(<MoneyField label="Amount" defaultValue="1500.00" />)

    const input = screen.getByRole('textbox', { name: 'Amount' })
    expect(input).toHaveClass('field__input--figure')
    expect(input).toHaveAttribute('inputmode', 'decimal')
    expect(screen.getByText('₹')).toHaveAttribute('aria-hidden', 'true')
  })

  /* The symbol is not India's by default. A company on another regime writes its own. */
  it('takes the symbol from whichever regime is open', () => {
    renderScreen(<MoneyField label="Amount" />, {
      regime: {
        ...DEFAULT_REGIME,
        numberFormat: {
          ...DEFAULT_REGIME.numberFormat,
          currencyCode: 'AED',
          currencySymbol: 'AED',
        },
      },
    })

    expect(screen.getByText('AED')).toHaveClass('field__prefix')
    expect(screen.queryByText('₹')).toBeNull()
  })

  it('hands back what was typed, without grouping or rounding it', async () => {
    const user = userEvent.setup()
    renderScreen(<Controlled />)

    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '100000.5')

    expect(screen.getByLabelText('typed')).toHaveTextContent('100000.5')
  })

  it('refuses to render with no company open, rather than guessing a currency', () => {
    expect(() => renderScreen(<MoneyField label="Amount" />, { regime: null })).toThrow(
      /needs an open company/,
    )
  })
})
