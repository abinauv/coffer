/*
 * One figure in a ledger table's figure column.
 *
 * NEGATIVE MONEY CARRIES ITS SIGN AND THE NEGATIVE INK. The sign is main's and is printed as
 * sent (CONVENTIONS §1.7); the colour is read back off the formatted text by `figureSign`,
 * the one place the renderer looks inside an amount. Colour never travels alone — the minus
 * sign is always there too — so a reader who cannot tell the ink apart loses nothing.
 *
 * Every report cell went through `formatAmount` by hand, and none of them coloured a negative:
 * an overdrawn bank on the account ledger and a credit on the trial balance were drawn in the
 * same ink as everything else.
 */

import type { JSX, ReactNode } from 'react'
import { figureSign } from '@renderer/lib/figures'
import type { DecimalString, NumberFormat } from '@shared/dto'
import { formatAmount, formatAmountOrBlank } from '../lib/ledger-format'

interface FigureCellProps {
  amount: DecimalString
  format: NumberFormat
  /** Leaves a zero empty — the debit and credit columns' convention on paper. */
  isBlankWhenZero?: boolean
  /** Said after the figure, such as "(contra)". */
  children?: ReactNode
}

/** The class a figure cell takes: right-aligned, and negative when the amount is. */
export function figureCellClass(text: string): string {
  return figureSign(text) === 'negative'
    ? 'ledger-table__figure ledger-table__figure--negative'
    : 'ledger-table__figure'
}

export function FigureCell({
  amount,
  format,
  isBlankWhenZero = false,
  children,
}: FigureCellProps): JSX.Element {
  const text = isBlankWhenZero ? formatAmountOrBlank(amount, format) : formatAmount(amount, format)
  return (
    <td className={figureCellClass(text)}>
      {text}
      {children}
    </td>
  )
}
