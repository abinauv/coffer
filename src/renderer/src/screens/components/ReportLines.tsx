/*
 * The indented rows of a statement section, and the toolbar that picks its range.
 *
 * Shared by the balance sheet and the profit and loss because the two are the same
 * drawing over different accounts. Nothing here computes anything: every figure arrives
 * as a decimal string already totalled by main.
 */

import type { JSX } from 'react'
import { Button, Input } from '@renderer/components/atoms'
import type { ReportSection } from '@shared/dto'
import { formatAmount } from '../lib/ledger-format'
import { isContraBalance, sectionHeading } from '../lib/report-view'

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
  const title = heading ?? sectionHeading(section.type)

  return (
    <table className="ledger-table ledger-table--figures report-table">
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
              <td className="ledger-table__figure">
                {formatAmount(line.amount)}
                {/* A negative on a statement is real and is never hidden — but an asset
                    in credit is an overdraft, and the reader deserves the word. */}
                {isContraBalance(line.amount) && (
                  <span className="ledger-table__muted"> (contra)</span>
                )}
              </td>
            </tr>
          ))
        )}
      </tbody>
      <tfoot>
        <tr className="ledger-table__total">
          <td>{totalLabel ?? `Total ${title.toLowerCase()}`}</td>
          <td className="ledger-table__figure">{formatAmount(section.total)}</td>
        </tr>
      </tfoot>
    </table>
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
