/*
 * The error state.
 *
 * What must hold: it interrupts, it says cause before fix and fix before the buttons, and
 * the machine-readable detail appears only when there is some.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ErrorState } from './ErrorState'

describe('ErrorState', () => {
  it('is an alert that says what happened and why', () => {
    render(
      <ErrorState
        title="The books could not be read"
        cause={<p>The file opened, but its contents are not a Coffer database.</p>}
      />,
    )

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('The books could not be read')
    expect(alert).toHaveTextContent('its contents are not a Coffer database')
  })

  /* The design system's order is the rule, so the order is asserted, not just presence. */
  it('puts the cause before the fix, and the fix before the actions', () => {
    render(
      <ErrorState
        title="The books could not be read"
        cause={<p>CAUSE</p>}
        fix={<p>FIX</p>}
        actions={<button type="button">Restore that backup</button>}
      />,
    )

    const text = screen.getByRole('alert').textContent ?? ''
    expect(text.indexOf('CAUSE')).toBeLessThan(text.indexOf('FIX'))
    expect(text.indexOf('FIX')).toBeLessThan(text.indexOf('Restore that backup'))
  })

  it('keeps the "!" mark out of what is read', () => {
    const { container } = render(<ErrorState title="Not read" cause="Because." />)

    expect(container.querySelector('.error-state__mark')).toHaveAttribute('aria-hidden', 'true')
  })

  it('shows a detail when there is one, and nothing for every way of having none', () => {
    const { container, rerender } = render(
      <ErrorState title="Not read" cause="Because." detail="DB_NOT_A_DATABASE" />,
    )
    expect(screen.getByText('DB_NOT_A_DATABASE')).toHaveClass('selectable')

    for (const detail of [undefined, null, '']) {
      rerender(<ErrorState title="Not read" cause="Because." detail={detail} />)
      expect(container.querySelector('.error-state__detail')).toBeNull()
    }
  })

  it('draws no fix and no actions that were not given', () => {
    const { container } = render(<ErrorState title="Not read" cause="Because." />)

    expect(container.querySelector('.error-state__fix')).toBeNull()
    expect(container.querySelector('.error-state__actions')).toBeNull()
  })
})
