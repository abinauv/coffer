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
import { Notice } from '../components/Notice'
import { ReportSectionTable } from '../components/ReportLines'
import { ScreenFrame } from '../components/ScreenFrame'
import { formatAmount } from '../lib/ledger-format'
import { todayISO } from '../lib/report-view'

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
          <p className="prose prose--muted">Summing the ledger…</p>
        ) : (
          <>
            {!sheet.balanced && (
              <Notice tone="danger" title="This balance sheet does not balance">
                <p>
                  Assets come to {formatAmount(sheet.totalAssets, format)} and the other side to{' '}
                  {formatAmount(sheet.totalLiabilitiesAndEquity, format)}. Every entry in these
                  books was checked three times before it was written, so this should be impossible
                  — please report it, with a backup if you can.
                </p>
              </Notice>
            )}

            <p className="prose prose--muted">As at {sheet.asAtDate}</p>

            <div className="report-columns">
              <ReportSectionTable section={sheet.assets} totalLabel="Total assets" />

              <div className="stack">
                <ReportSectionTable section={sheet.liabilities} totalLabel="Total liabilities" />
                <EquityTable sheet={sheet} />
              </div>
            </div>

            <table className="ledger-table ledger-table--figures report-table">
              <tfoot>
                <tr className="ledger-table__total">
                  <td>Total assets</td>
                  <td className="ledger-table__figure">
                    {formatAmount(sheet.totalAssets, format)}
                  </td>
                </tr>
                <tr className="ledger-table__total">
                  <td>Total liabilities and equity</td>
                  <td className="ledger-table__figure">
                    {formatAmount(sheet.totalLiabilitiesAndEquity, format)}
                  </td>
                </tr>
              </tfoot>
            </table>
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
      <table className="ledger-table ledger-table--figures report-table">
        <tbody>
          <tr>
            <td>Profit for the period, not yet closed</td>
            <td className="ledger-table__figure">{formatAmount(sheet.profitForPeriod, format)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

registerScreens([
  {
    id: 'balance-sheet',
    title: 'Balance sheet',
    area: 'workspace',
    nav: { label: 'Balance sheet', icon: 'ledger', group: 'reports', order: 1 },
    render: () => <BalanceSheet />,
  },
])
