/*
 * The profit and loss.
 *
 * A period report, so the range is the point rather than a convenience — and with no
 * range it covers the books from inception, which after a year-end close means the
 * current year, because the closed years have been moved into retained earnings.
 *
 * A LOSS IS CALLED A LOSS. The figure is signed and stays signed, but the label changes
 * with it: "Net profit: -15,000.00" asks the reader to notice a minus sign in a column
 * of figures, which is precisely what they will not do.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Button } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { registerScreens } from '@renderer/lib/screens'
import { useRegisterCommands } from '@renderer/store/commands'
import type { AppError, ProfitAndLoss as Statement } from '@shared/dto'
import { FailureNotice } from '../components/FailureNotice'
import { RangeToolbar, ReportSectionTable } from '../components/ReportLines'
import { ScreenFrame } from '../components/ScreenFrame'
import { formatAmount } from '../lib/ledger-format'
import { describeRange, resultLabel, resultTone } from '../lib/report-view'

export function ProfitAndLoss(): JSX.Element {
  const [statement, setStatement] = useState<Statement | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [isBusy, setBusy] = useState(false)

  const loadRange = useCallback(async (from: string, to: string) => {
    setBusy(true)
    const result = await callApi((api) =>
      api.reports.profitAndLoss({
        ...(from === '' ? {} : { fromDate: from }),
        ...(to === '' ? {} : { toDate: to }),
      }),
    )
    setBusy(false)

    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    setStatement(result.data)
  }, [])

  const load = useCallback(() => loadRange(fromDate, toDate), [loadRange, fromDate, toDate])

  useEffect(() => {
    void loadRange('', '')
  }, [loadRange])

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: 'reports.profit-and-loss-refresh',
          title: 'Refresh the profit and loss',
          section: 'Reports',
          keywords: ['statement', 'income', 'expenses', 'reload'],
          run: () => void load(),
        },
      ],
      [load],
    ),
  )

  return (
    <ScreenFrame
      isInset
      width="list"
      title="Profit and loss"
      lede="What came in and what went out over a stretch of time, and what is left."
      actions={
        <Button icon="refresh" onClick={() => void load()} isBusy={isBusy}>
          Refresh
        </Button>
      }
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="ledger" />}

        <RangeToolbar
          fromDate={fromDate}
          toDate={toDate}
          onFromChange={setFromDate}
          onToChange={setToDate}
          onApply={() => void load()}
          onClear={() => {
            setFromDate('')
            setToDate('')
            void loadRange('', '')
          }}
          isBusy={isBusy}
        />

        {statement === null ? (
          <p className="prose prose--muted">Summing the ledger…</p>
        ) : (
          <>
            <p className="prose prose--muted">
              {describeRange(statement.fromDate, statement.toDate)}
            </p>

            <ReportSectionTable section={statement.income} totalLabel="Total income" />
            <ReportSectionTable section={statement.expenses} totalLabel="Total expenses" />

            <table className="ledger-table ledger-table--figures report-table">
              <tfoot>
                <tr
                  className={`ledger-table__total ledger-table__total--${resultTone(statement.netProfit)}`}
                >
                  <td>{resultLabel(statement.netProfit)}</td>
                  <td className="ledger-table__figure">{formatAmount(statement.netProfit)}</td>
                </tr>
              </tfoot>
            </table>
          </>
        )}
      </div>
    </ScreenFrame>
  )
}

registerScreens([
  {
    id: 'profit-and-loss',
    title: 'Profit and loss',
    area: 'workspace',
    nav: { label: 'Profit and loss', icon: 'ledger', group: 'reports', order: 2 },
    render: () => <ProfitAndLoss />,
  },
])
