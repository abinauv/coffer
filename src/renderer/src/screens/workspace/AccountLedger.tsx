/*
 * One account's ledger, with the balance after every movement.
 *
 * THE OPENING BALANCE IS ITS OWN ROW, and it is not decoration. A ledger for May that
 * started at zero would close on May's movement wearing the closing balance's name —
 * which is the single most misleading thing this screen could do, because the figure
 * looks right, is labelled right, and is wrong by everything that happened before May.
 *
 * Groups are not offered. A group holds no figures of its own, so its ledger would be
 * empty while its children's was not, and an empty ledger reads as "nothing happened
 * here" rather than as "you asked the wrong account".
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Button } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { registerScreens } from '@renderer/lib/screens'
import { useRegisterCommands } from '@renderer/store/commands'
import { useNumberFormat } from '@renderer/store/regime'
import type { Account, AccountLedger as Ledger, AppError } from '@shared/dto'
import { FailureNotice } from '../components/FailureNotice'
import { Notice } from '../components/Notice'
import { RangeToolbar } from '../components/ReportLines'
import { ScreenFrame } from '../components/ScreenFrame'
import { accountLabel, postableAccounts } from '../lib/chart-tree'
import { formatAmount, formatAmountOrBlank } from '../lib/ledger-format'
import { describeRange } from '../lib/report-view'

export function AccountLedger(): JSX.Element {
  const format = useNumberFormat()
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [accountId, setAccountId] = useState('')
  const [ledger, setLedger] = useState<Ledger | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [isBusy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      const result = await callApi((api) => api.ledger.listAccounts({}))
      if (!result.ok) {
        setError(result.error)
        return
      }
      setAccounts(result.data)
    })()
  }, [])

  const loadFor = useCallback(async (id: string, from: string, to: string) => {
    if (id === '') {
      setLedger(null)
      return
    }
    setBusy(true)
    const result = await callApi((api) =>
      api.reports.accountLedger({
        accountId: id,
        ...(from === '' ? {} : { fromDate: from }),
        ...(to === '' ? {} : { toDate: to }),
      }),
    )
    setBusy(false)

    if (!result.ok) {
      setError(result.error)
      setLedger(null)
      return
    }
    setError(null)
    setLedger(result.data)
  }, [])

  const load = useCallback(
    () => loadFor(accountId, fromDate, toDate),
    [loadFor, accountId, fromDate, toDate],
  )

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: 'reports.account-ledger-refresh',
          title: 'Refresh the account ledger',
          section: 'Reports',
          keywords: ['statement', 'account', 'running balance', 'reload'],
          run: () => void load(),
        },
      ],
      [load],
    ),
  )

  /* Leaves only: a group takes no postings, so its ledger is empty by construction and
   * offering it would be offering a blank screen. */
  const choices = useMemo(() => postableAccounts(accounts ?? []), [accounts])

  return (
    <ScreenFrame
      isInset
      width="list"
      title="Account ledger"
      lede="Everything that moved through one account, with the balance after each entry."
      actions={
        <Button
          icon="refresh"
          onClick={() => void load()}
          isBusy={isBusy}
          disabled={accountId === ''}
        >
          Refresh
        </Button>
      }
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="ledger" />}

        <div className="toolbar">
          <label className="field">
            <span className="field__label">Account</span>
            <select
              className="field__control"
              value={accountId}
              onChange={(event) => {
                setAccountId(event.target.value)
                void loadFor(event.target.value, fromDate, toDate)
              }}
            >
              <option value="">Choose an account</option>
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {accountLabel(choice)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <RangeToolbar
          fromDate={fromDate}
          toDate={toDate}
          onFromChange={setFromDate}
          onToChange={setToDate}
          onApply={() => void load()}
          onClear={() => {
            setFromDate('')
            setToDate('')
            void loadFor(accountId, '', '')
          }}
          isBusy={isBusy}
        />

        {accountId === '' ? (
          <p className="prose prose--muted">Choose an account to see its ledger.</p>
        ) : ledger === null ? (
          <p className="prose prose--muted">Reading the ledger…</p>
        ) : (
          <>
            <p className="prose prose--muted">
              {ledger.code} · {ledger.name} — {describeRange(ledger.fromDate, ledger.toDate)}
            </p>

            {ledger.rows.length === 0 && (
              <Notice tone="info" title="Nothing moved through this account">
                <p>
                  Its balance is {formatAmount(ledger.closingBalance, format)} and no entry in this
                  range touched it.
                </p>
              </Notice>
            )}

            <table className="ledger-table ledger-table--figures">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Entry</th>
                  <th scope="col">Particulars</th>
                  <th scope="col" className="ledger-table__figure">
                    Debit
                  </th>
                  <th scope="col" className="ledger-table__figure">
                    Credit
                  </th>
                  <th scope="col" className="ledger-table__figure">
                    Balance
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr className="ledger-table__row--context">
                  <td colSpan={5}>Opening balance</td>
                  <td className="ledger-table__figure">
                    {formatAmount(ledger.openingBalance, format)}
                  </td>
                </tr>
                {ledger.rows.map((row) => (
                  <tr key={`${row.entryId}-${row.date}-${row.balance}`}>
                    <td>{row.date}</td>
                    <td className="ledger-table__code">{row.entryNumber}</td>
                    <td>
                      {row.contra}
                      {row.narration !== '' && (
                        <span className="ledger-table__muted"> · {row.narration}</span>
                      )}
                    </td>
                    <td className="ledger-table__figure">
                      {formatAmountOrBlank(row.debit, format)}
                    </td>
                    <td className="ledger-table__figure">
                      {formatAmountOrBlank(row.credit, format)}
                    </td>
                    <td className="ledger-table__figure">{formatAmount(row.balance, format)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="ledger-table__total">
                  <td colSpan={3}>Closing balance</td>
                  <td className="ledger-table__figure">
                    {formatAmount(ledger.totalDebit, format)}
                  </td>
                  <td className="ledger-table__figure">
                    {formatAmount(ledger.totalCredit, format)}
                  </td>
                  <td className="ledger-table__figure">
                    {formatAmount(ledger.closingBalance, format)}
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

registerScreens([
  {
    id: 'account-ledger',
    title: 'Account ledger',
    area: 'workspace',
    nav: { label: 'Account ledger', icon: 'ledger', group: 'reports', order: 4 },
    render: () => <AccountLedger />,
  },
])
