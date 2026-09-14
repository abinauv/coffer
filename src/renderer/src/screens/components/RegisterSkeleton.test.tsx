/*
 * The loading register.
 *
 * What must hold: it says what is loading in one sentence, hides its bars, draws the
 * columns at the widths it was given so rows arrive without reflow, and has no spinner.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RegisterSkeleton } from './RegisterSkeleton'

const COLUMNS = [{ width: '1fr' }, { width: '6rem' }, { width: '8rem', align: 'end' as const }]

describe('RegisterSkeleton', () => {
  it('says what is loading, once, and marks itself busy', () => {
    const { container } = render(<RegisterSkeleton label="sales invoices" columns={COLUMNS} />)

    expect(screen.getByRole('status')).toHaveTextContent('Loading sales invoices')
    expect(container.firstElementChild).toHaveAttribute('aria-busy', 'true')
  })

  it('hides the placeholder rows from assistive technology', () => {
    const { container } = render(<RegisterSkeleton label="receipts" columns={COLUMNS} />)

    expect(container.querySelector('.skeleton__rows')).toHaveAttribute('aria-hidden', 'true')
  })

  it('draws six rows unless told otherwise, and as many as it is told', () => {
    const { container, rerender } = render(<RegisterSkeleton label="parties" columns={COLUMNS} />)
    expect(container.querySelectorAll('.skeleton__row')).toHaveLength(6)

    rerender(<RegisterSkeleton label="parties" columns={COLUMNS} rows={3} />)
    expect(container.querySelectorAll('.skeleton__row')).toHaveLength(3)
  })

  /* The whole point of a skeleton: the grid is the real table's, before the data is. */
  it('lays each row out on the columns it was given, figures to the end', () => {
    const { container } = render(<RegisterSkeleton label="bills" columns={COLUMNS} rows={1} />)

    const row = container.querySelector<HTMLElement>('.skeleton__row')
    expect(row?.style.gridTemplateColumns).toBe('1fr 6rem 8rem')
    const cells = row?.querySelectorAll('.skeleton__cell') ?? []
    expect(cells).toHaveLength(3)
    expect(cells[0]).toHaveAttribute('data-align', 'start')
    expect(cells[2]).toHaveAttribute('data-align', 'end')
  })

  it('draws the same shape every time, so nothing flickers between renders', () => {
    const first = render(<RegisterSkeleton label="a" columns={COLUMNS} />).container.innerHTML
    const second = render(<RegisterSkeleton label="a" columns={COLUMNS} />).container.innerHTML

    expect(second).toBe(first)
  })

  it('has no spinner', () => {
    const { container } = render(<RegisterSkeleton label="items" columns={COLUMNS} />)

    expect(container.querySelector('.button__spinner, [role="progressbar"]')).toBeNull()
  })
})
