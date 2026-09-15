import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { NumberFormat } from '@shared/dto'
import { FigureCell } from './FigureCell'

const INDIAN: NumberFormat = {
  groupSizes: [3, 2],
  decimalSeparator: '.',
  groupSeparator: ',',
  currencyCode: 'INR',
  currencySymbol: '₹',
}

function cellFor(element: React.ReactElement): HTMLTableCellElement {
  const { container } = render(
    <table>
      <tbody>
        <tr>{element}</tr>
      </tbody>
    </table>,
  )
  const cell = container.querySelector('td')
  if (cell === null) throw new Error('No cell')
  return cell
}

describe('FigureCell', () => {
  it('writes the amount the regime’s way, in the figure column', () => {
    const cell = cellFor(<FigureCell amount="125000.50" format={INDIAN} />)
    expect(cell).toHaveTextContent('1,25,000.50')
    expect(cell).toHaveClass('ledger-table__figure')
    expect(cell).not.toHaveClass('ledger-table__figure--negative')
  })

  /* The sign is main's and stays; the ink is added, never instead of it. */
  it('keeps a negative’s sign and adds the negative ink', () => {
    const cell = cellFor(<FigureCell amount="-15000.00" format={INDIAN} />)
    expect(cell).toHaveTextContent('-15,000.00')
    expect(cell).toHaveClass('ledger-table__figure--negative')
  })

  it('does not call a signed zero negative', () => {
    expect(cellFor(<FigureCell amount="-0.00" format={INDIAN} />)).not.toHaveClass(
      'ledger-table__figure--negative',
    )
  })

  it('leaves a zero empty when asked, as a debit or credit column does', () => {
    expect(cellFor(<FigureCell amount="0.00" format={INDIAN} isBlankWhenZero />)).toHaveTextContent(
      /^$/,
    )
  })

  it('says what follows the figure after it', () => {
    const cell = cellFor(
      <FigureCell amount="-1.00" format={INDIAN}>
        <span> (contra)</span>
      </FigureCell>,
    )
    expect(cell).toHaveTextContent('-1.00 (contra)')
  })
})
