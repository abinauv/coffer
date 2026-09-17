/*
 * The balance sheet.
 *
 * WHETHER IT BALANCES IS MAIN'S ANSWER, like the trial balance's. `balanced` arrives
 * computed from the same sums that produced the columns, and the renderer states it
 * rather than re-deriving it — two opinions about the one fact this statement exists to
 * give would eventually differ, and the wrong one would be on screen.
 *
 * The profit line is on the face of the sheet, inside equity, and is labelled as what it
 * is: income less expenses that no year-end close has moved yet. Without it the two
 * sides do not agree, and a reader who knows that would rightly distrust the whole thing.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Button, Input } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { registerScreens } from '@renderer/lib/screens'
import { useRegisterCommands } from '@renderer/store/commands'
import { useNumberFormat } from '@renderer/store/regime'
import type { AppError, BalanceSheet as Sheet } from '@shared/dto'
import { FailureNotice } from '../components/FailureNotice'
import { FigureCell } from '../components/FigureCell'
import { Notice } from '../components/Notice'
import { ReportSectionTable } from '../components/ReportLines'
import { RegisterSkeleton, type SkeletonColumn } from '../components/RegisterSkeleton'
import { ScreenFrame } from '../components/ScreenFrame'
import { formatDate } from '../lib/dates'
import { formatAmount } from '../lib/ledger-format'
import { todayISO } from '../lib/report-view'

/* An account and its figure. */
const COLUMNS: readonly SkeletonColumn[] = [{ width: '1fr' }, { width: '10rem', align: 'end' }]

export function BalanceSheet(): JSX.Element {
  const format = useNumberFormat()
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [asAtDate, setAsAtDate] = useState(() => todayISO())
  const [isBusy, setBusy] = useState(false)

  const loadAsAt = useCallback(async (date: string) => {
    setBusy(true)
    const result = await callApi((api) => api.reports.balanceSheet({ asAtDate: date }))
    setBusy(false)

    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    setSheet(result.data)
  }, [])

  const load = useCallback(() => loadAsAt(asAtDate), [loadAsAt, asAtDate])

  useEffect(() => {
    void loadAsAt(todayISO())
  }, [loadAsAt])

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: 'reports.balance-sheet-refresh',
          title: 'Refresh the balance sheet',
          section: 'Reports',
          keywords: ['statement', 'assets', 'liabilities', 'reload'],
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
      title="Balance sheet"
      lede="What the business owns and owes on one day, summed from the journal when you ask for it."
      actions={
        <Button icon="refresh" onClick={() => void load()} isBusy={isBusy}>
          Refresh
        </Button>
      }
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="ledger" />}

        <div className="toolbar">
          <Input
            label="As at"
            type="date"
            value={asAtDate}
            onChange={(event) => setAsAtDate(event.target.value)}
          />
          <Button onClick={() => void load()} isBusy={isBusy}>
            Apply
          </Button>
        </div>

        {sheet === null ? (
          error === null && <RegisterSkeleton label="the balance sheet" columns={COLUMNS} />
        ) : (
          <>
            {!sheet.balanced && (
              <Notice tone="danger" title="This balance sheet does not balance">
                <p>
                  Assets come to {formatAmount(sheet.totalAssets, format)} and the other side to{' '}
                  {formatAmount(sheet.totalLiabilitiesAndEquity, format)}. Every entry in these
                  books was checked three times before it was written, so this should be impossible.
                  Please report it with these two figures, and attach neither the company file nor a
                  backup: both hold your books.
                </p>
              </Notice>
            )}

            <p className="prose prose--muted">As at {formatDate(sheet.asAtDate)}</p>

            <div className="report-columns">
              <ReportSectionTable section={sheet.assets} totalLabel="Total assets" />

              <div className="stack">
                <ReportSectionTable section={sheet.liabilities} totalLabel="Total liabilities" />
                <EquityTable sheet={sheet} />
              </div>
            </div>

            <div className="register">
              <table className="ledger-table ledger-table--figures register__table report-table">
                <tfoot>
                  <tr className="ledger-table__total">
                    <td>Total assets</td>
                    <FigureCell amount={sheet.totalAssets} format={format} />
                  </tr>
                  <tr className="ledger-table__total">
                    <td>Total liabilities and equity</td>
                    <FigureCell amount={sheet.totalLiabilitiesAndEquity} format={format} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </div>
    </ScreenFrame>
  )
}

/**
 * Equity, with the unclosed profit under it.
 *
 * The profit is drawn as its own row rather than folded into the section total, because
 * it is not an account and a reader looking for it in the chart would not find it. The
 * combined figure below is what the sheet balances on.
 */
function EquityTable({ sheet }: { sheet: Sheet }): JSX.Element {
  const format = useNumberFormat()
  return (
    <div className="stack stack--tight">
      <ReportSectionTable
        section={sheet.equity}
        heading="Equity and reserves"
        totalLabel="Total capital accounts"
      />
      <div className="register">
        <table className="ledger-table ledger-table--figures register__table report-table">
          <tbody>
            <tr>
              <td>Profit for the period, not yet closed</td>
              <FigureCell amount={sheet.profitForPeriod} format={format} />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

registerScreens([
  {
    id: 'balance-sheet',
    title: 'Balance sheet',
    area: 'workspace',
    nav: { label: 'Balance sheet', icon: 'columns', group: 'reports', order: 1 },
    render: () => <BalanceSheet />,
  },
])
