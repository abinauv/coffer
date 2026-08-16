/*
 * The day book: every entry, in the order the books are read.
 *
 * By date and then by entry number, never by when it was typed. Two entries posted in
 * one sitting for different dates belong in date order, because that is the order the
 * books are reported and filed in.
 *
 * Each day carries its own total, computed in main. A column of figures totalled by
 * whoever happened to be drawing it is how two parts of one screen come to disagree.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Button } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { registerScreens } from '@renderer/lib/screens'
import { useRegisterCommands } from '@renderer/store/commands'
import type { AppError, DayBook as Book, JournalEntry } from '@shared/dto'
import { FailureNotice } from '../components/FailureNotice'
import { Notice } from '../components/Notice'
import { RangeToolbar } from '../components/ReportLines'
import { ScreenFrame } from '../components/ScreenFrame'
import { formatAmount, formatAmountOrBlank } from '../lib/ledger-format'
import { describeRange } from '../lib/report-view'

export function DayBook(): JSX.Element {
  const [book, setBook] = useState<Book | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [isBusy, setBusy] = useState(false)

  const loadRange = useCallback(async (from: string, to: string) => {
    setBusy(true)
    const result = await callApi((api) =>
      api.reports.dayBook({
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
    setBook(result.data)
  }, [])

  const load = useCallback(() => loadRange(fromDate, toDate), [loadRange, fromDate, toDate])

  useEffect(() => {
    void loadRange('', '')
  }, [loadRange])

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: 'reports.day-book-refresh',
          title: 'Refresh the day book',
          section: 'Reports',
          keywords: ['journal', 'entries', 'reload'],
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
      title="Day book"
      lede="Every entry in the books, in the order they are read: by date, then by number."
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

        {book === null ? (
          <p className="prose prose--muted">Reading the journal…</p>
        ) : book.days.length === 0 ? (
          <Notice tone="info" title="Nothing has been posted yet">
            <p>{describeRange(book.fromDate, book.toDate)} — and no entry falls in it.</p>
          </Notice>
        ) : (
          <>
            <p className="prose prose--muted">
              {describeRange(book.fromDate, book.toDate)} — {book.entryCount}{' '}
              {book.entryCount === 1 ? 'entry' : 'entries'}, {formatAmount(book.total)} in total
            </p>

            {book.days.map((day) => (
              <section key={day.date} className="stack stack--tight">
                <h2 className="day-book__date">
                  {day.date}
                  <span className="day-book__total">{formatAmount(day.total)}</span>
                </h2>
                {day.entries.map((entry) => (
                  <EntryTable key={entry.id} entry={entry} />
                ))}
              </section>
            ))}
          </>
        )}
      </div>
    </ScreenFrame>
  )
}

/** One entry, with its lines. A reversal says so; so does an entry that was reversed. */
function EntryTable({ entry }: { entry: JournalEntry }): JSX.Element {
  return (
    <table className="ledger-table ledger-table--figures day-book__entry">
      <thead>
        <tr>
          <th scope="col" colSpan={2}>
            {entry.entryNumber} · {entry.narration}
            {entry.reversesEntryId !== null && (
              <span className="ledger-table__muted"> · a reversal</span>
            )}
            {entry.reversedByEntryId !== null && (
              <span className="ledger-table__muted"> · reversed</span>
            )}
          </th>
          <th scope="col" className="ledger-table__figure">
            Debit
          </th>
          <th scope="col" className="ledger-table__figure">
            Credit
          </th>
        </tr>
      </thead>
      <tbody>
        {entry.lines.map((line) => (
          <tr key={line.id}>
            <td className="ledger-table__code">{line.accountCode}</td>
            <td>{line.accountName}</td>
            <td className="ledger-table__figure">{formatAmountOrBlank(line.debit)}</td>
            <td className="ledger-table__figure">{formatAmountOrBlank(line.credit)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

registerScreens([
  {
    id: 'day-book',
    title: 'Day book',
    area: 'workspace',
    nav: { label: 'Day book', icon: 'ledger', group: 'reports', order: 3 },
    render: () => <DayBook />,
  },
])
