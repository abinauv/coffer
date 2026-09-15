/*
 * The indented rows of a statement section, and the toolbar that picks its range.
 *
 * Shared by the balance sheet and the profit and loss because the two are the same
 * drawing over different accounts. Nothing here computes anything: every figure arrives
 * as a decimal string already totalled by main.
 */

import type { JSX } from 'react'
import { Button, Input } from '@renderer/components/atoms'
import { useNumberFormat } from '@renderer/store/regime'
import type { DecimalString, NumberFormat, ReportSection } from '@shared/dto'
import { isContraBalance, sectionHeading } from '../lib/report-view'
import { FigureCell } from './FigureCell'

interface ReportSectionTableProps {
  section: ReportSection
  /** Overrides the section's own heading. The equity block on a balance sheet uses this. */
  heading?: string
  /** The word on the total line: 'Total assets'. */
  totalLabel?: string
}

export function ReportSectionTable({
  section,
  heading,
  totalLabel,
}: ReportSectionTableProps): JSX.Element {
  const format = useNumberFormat()
  const title = heading ?? sectionHeading(section.type)

  return (
    <div className="register">
      <table className="ledger-table ledger-table--figures register__table report-table">
        <thead>
          <tr>
            <th scope="col" colSpan={2}>
              {title}
            </th>
          </tr>
        </thead>
        <tbody>
          {section.lines.length === 0 ? (
            <tr className="ledger-table__row--context">
              <td colSpan={2}>Nothing has been posted here.</td>
            </tr>
          ) : (
            section.lines.map((line) => (
              <tr
                key={line.accountId}
                className={line.isGroup ? 'ledger-table__row--group' : undefined}
              >
                <td>
                  <span style={{ paddingInlineStart: `${line.depth * 1.25}rem` }}>
                    {line.code} · {line.name}
                  </span>
                </td>
                <Figure amount={line.amount} format={format} />
              </tr>
            ))
          )}
        </tbody>
        <tfoot>
          <tr className="ledger-table__total">
            <td>{totalLabel ?? `Total ${title.toLowerCase()}`}</td>
            {/* The foot is marked on exactly the same rule as the lines above it. It was
              bare until 0016, so a section entirely in credit footed with a lone
              `-15,000.00` under a column where every abnormal figure carried the word —
              which teaches the reader that the word means something and then withholds
              it at the one line they will quote. A section total is abnormal in the same
              sense a line is: assets are read as debits, income as credits, and a total
              facing the other way is the block as a whole being the wrong way round.
              (The net profit line is NOT this — a loss is an ordinary outcome, not an
              abnormal balance, and ProfitAndLoss.tsx names it in words of its own.) */}
            <Figure amount={section.total} format={format} />
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

/**
 * One figure cell, with the word for a balance facing the wrong way.
 *
 * A negative on a statement is real and is never hidden — the sign arrives from main and
 * is never flipped here (CONVENTIONS §1.7) — but an asset in credit is an overdraft, and
 * the reader deserves the word rather than a minus sign to spot in a column of digits.
 *
 * It is one component rather than two copies because the line and the total have to
 * agree: written twice, they disagreed for as long as this table has existed.
 */
function Figure({ amount, format }: { amount: DecimalString; format: NumberFormat }): JSX.Element {
  return (
    <FigureCell amount={amount} format={format}>
      {isContraBalance(amount) && <span className="ledger-table__muted"> (contra)</span>}
    </FigureCell>
  )
}

interface RangeToolbarProps {
  fromDate: string
  toDate: string
  onFromChange: (value: string) => void
  onToChange: (value: string) => void
  onApply: () => void
  onClear: () => void
  isBusy?: boolean
}

/**
 * From, to, Apply, Clear.
 *
 * Typing a date does not re-run the query — the user says when they have finished by
 * pressing Apply. A query per keystroke would fire eight times for one date and show
 * four wrong reports on the way to the right one.
 */
export function RangeToolbar({
  fromDate,
  toDate,
  onFromChange,
  onToChange,
  onApply,
  onClear,
  isBusy = false,
}: RangeToolbarProps): JSX.Element {
  return (
    <div className="toolbar">
      <Input
        label="From"
        type="date"
        value={fromDate}
        onChange={(event) => onFromChange(event.target.value)}
      />
      <Input
        label="To"
        type="date"
        value={toDate}
        onChange={(event) => onToChange(event.target.value)}
      />
      <Button onClick={onApply} isBusy={isBusy}>
        Apply
      </Button>
      {(fromDate !== '' || toDate !== '') && (
        <Button variant="ghost" onClick={onClear}>
          Clear
        </Button>
      )}
    </div>
  )
}
