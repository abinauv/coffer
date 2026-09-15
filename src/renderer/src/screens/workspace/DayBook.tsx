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
import { useNumberFormat } from '@renderer/store/regime'
import type { AppError, DayBook as Book, JournalEntry } from '@shared/dto'
import { EmptyState } from '../components/EmptyState'
import { FailureNotice } from '../components/FailureNotice'
import { FigureCell } from '../components/FigureCell'
import { RangeToolbar } from '../components/ReportLines'
import { RegisterSkeleton, type SkeletonColumn } from '../components/RegisterSkeleton'
import { ScreenFrame } from '../components/ScreenFrame'
import { formatDate } from '../lib/dates'
import { formatAmount } from '../lib/ledger-format'
import { describeRange } from '../lib/report-view'

/* Code, account, debit, credit. */
const COLUMNS: readonly SkeletonColumn[] = [
  { width: '6rem' },
  { width: '1fr' },
  { width: '9rem', align: 'end' },
  { width: '9rem', align: 'end' },
]

export function DayBook(): JSX.Element {
  const format = useNumberFormat()
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
          error === null && <RegisterSkeleton label="the day book" columns={COLUMNS} />
        ) : book.days.length === 0 ? (
          <EmptyState title="Nothing has been posted yet" titleAs="h2">
            <p>{describeRange(book.fromDate, book.toDate)} — and no entry falls in it.</p>
          </EmptyState>
        ) : (
          <>
            <p className="prose prose--muted">
              {describeRange(book.fromDate, book.toDate)} — {book.entryCount}{' '}
              {book.entryCount === 1 ? 'entry' : 'entries'}, {formatAmount(book.total, format)} in
              total
            </p>

            {book.days.map((day) => (
              <section key={day.date} className="stack stack--tight">
                <h2 className="day-book__date">
                  {formatDate(day.date)}
                  <span className="day-book__total">{formatAmount(day.total, format)}</span>
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
  const format = useNumberFormat()
  return (
    <div className="register day-book__entry">
      <table className="ledger-table ledger-table--figures register__table">
        <colgroup>
          <col className="day-book__code" />
          <col />
          <col className="day-book__figure" />
          <col className="day-book__figure" />
        </colgroup>
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
              <FigureCell amount={line.debit} format={format} isBlankWhenZero />
              <FigureCell amount={line.credit} format={format} isBlankWhenZero />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

registerScreens([
  {
    id: 'day-book',
    title: 'Day book',
    area: 'workspace',
    nav: { label: 'Day book', icon: 'calendar', group: 'accounts', order: 3 },
    render: () => <DayBook />,
  },
])
