/*
 * The trial balance.
 *
 * The report that proves the books. Every figure is summed from `journal_lines` when
 * asked — nothing is stored and nothing is cached — so what is on screen is what is in
 * the ledger at the moment the button was pressed.
 *
 * WHETHER IT TIES IS MAIN'S ANSWER. `balanced` arrives with the report, computed from the
 * same sums that produced the columns. The renderer states it and does not re-derive it:
 * two opinions about the one fact this report exists to give would eventually differ,
 * and the wrong one would be the one on screen.
 *
 * A trial balance that does not tie is not a rendering problem, so it is said plainly and
 * loudly rather than shown as a small red number.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Button } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { registerScreens } from '@renderer/lib/screens'
import { useRegisterCommands } from '@renderer/store/commands'
import { useNumberFormat } from '@renderer/store/regime'
import type { AppError, TrialBalance as TrialBalanceReport } from '@shared/dto'
import { EmptyState } from '../components/EmptyState'
import { FailureNotice } from '../components/FailureNotice'
import { FigureCell } from '../components/FigureCell'
import { Notice } from '../components/Notice'
import { RangeToolbar } from '../components/ReportLines'
import { RegisterSkeleton, type SkeletonColumn } from '../components/RegisterSkeleton'
import { ScreenFrame } from '../components/ScreenFrame'
import { formatAmount } from '../lib/ledger-format'
import { describeRange } from '../lib/report-view'
import { sectionsOf } from '../lib/trial-balance-view'

/* Code, account, debit, credit. */
const COLUMNS: readonly SkeletonColumn[] = [
  { width: '6rem' },
  { width: '1fr' },
  { width: '9rem', align: 'end' },
  { width: '9rem', align: 'end' },
]

export function TrialBalance(): JSX.Element {
  const format = useNumberFormat()
  const [report, setReport] = useState<TrialBalanceReport | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [isBusy, setBusy] = useState(false)

  /*
   * The range is passed in rather than read from state, so this function does not change
   * when a date field does. Typing in a date must not re-run the query on every
   * keystroke — the user says when they have finished by pressing Apply.
   */
  const loadRange = useCallback(async (from: string, to: string) => {
    setBusy(true)
    const result = await callApi((api) =>
      api.ledger.trialBalance({
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
    setReport(result.data)
  }, [])

  const load = useCallback(() => loadRange(fromDate, toDate), [loadRange, fromDate, toDate])

  useEffect(() => {
    void loadRange('', '')
  }, [loadRange])

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: 'ledger.trial-balance-refresh',
          title: 'Refresh the trial balance',
          section: 'Reports',
          keywords: ['ledger', 'totals', 'reload'],
          run: () => void load(),
        },
      ],
      [load],
    ),
  )

  const sections = useMemo(() => (report === null ? [] : sectionsOf(report)), [report])

  return (
    <ScreenFrame
      isInset
      width="list"
      title="Trial balance"
      lede="Summed from the journal every time it is asked for. Nothing here is stored, so it cannot disagree with the entries behind it."
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

        {report === null ? (
          error === null && <RegisterSkeleton label="the trial balance" columns={COLUMNS} />
        ) : report.rows.length === 0 ? (
          <EmptyState title="Nothing has been posted yet" titleAs="h2">
            <p>
              {describeRange(report.fromDate, report.toDate)} — and no entry falls in it. Post a
              journal and this fills in.
            </p>
          </EmptyState>
        ) : (
          <>
            {!report.balanced && (
              <Notice tone="danger" title="This trial balance does not tie">
                <p>
                  Total debits are {formatAmount(report.totalDebit, format)} and total credits are{' '}
                  {formatAmount(report.totalCredit, format)}. Every entry in these books was checked
                  three times before it was written, so this should be impossible. Please report it
                  with these two figures, and attach neither the company file nor a backup: both
                  hold your books.
                </p>
              </Notice>
            )}

            <p className="prose prose--muted">{describeRange(report.fromDate, report.toDate)}</p>

            <div className="register">
              <table className="ledger-table ledger-table--figures register__table">
                <thead>
                  <tr>
                    <th scope="col">Code</th>
                    <th scope="col">Account</th>
                    <th scope="col" className="ledger-table__figure">
                      Debit
                    </th>
                    <th scope="col" className="ledger-table__figure">
                      Credit
                    </th>
                  </tr>
                </thead>

                {sections.map((section) => (
                  <tbody key={section.type}>
                    <tr className="ledger-table__section">
                      <th scope="rowgroup" colSpan={4}>
                        {section.label}
                      </th>
                    </tr>
                    {section.rows.map((row) => (
                      <tr key={row.accountId}>
                        <td className="ledger-table__code">{row.code}</td>
                        <td>{row.name}</td>
                        <FigureCell amount={row.debitBalance} format={format} isBlankWhenZero />
                        <FigureCell amount={row.creditBalance} format={format} isBlankWhenZero />
                      </tr>
                    ))}
                    <tr className="ledger-table__subtotal">
                      <td />
                      <td>Total {section.label.toLowerCase()}</td>
                      <FigureCell amount={section.debitTotal} format={format} isBlankWhenZero />
                      <FigureCell amount={section.creditTotal} format={format} isBlankWhenZero />
                    </tr>
                  </tbody>
                ))}

                <tfoot>
                  <tr className="ledger-table__total">
                    <td />
                    <td>Total</td>
                    <FigureCell amount={report.totalDebit} format={format} />
                    <FigureCell amount={report.totalCredit} format={format} />
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

registerScreens([
  {
    id: 'trial-balance',
    title: 'Trial balance',
    area: 'workspace',
    nav: { label: 'Trial balance', icon: 'scale', group: 'reports', order: 0 },
    render: () => <TrialBalance />,
  },
])
