/*
 * The aged report — one component, registered once per side of the trade.
 *
 * The page a business chases money with, and the page a business gets chased from. What
 * it draws is what `reports.aged` sends: a control account broken into columns by how
 * long each amount has been outstanding, as at one day.
 *
 * IT IS ONE ACCOUNT DECOMPOSED, AND THE PAGE SAYS SO. The account it is a decomposition
 * of is named at the foot beside its balance, under the report's own total. Those two
 * figures reaching the same number is the whole claim this report makes, and it is made
 * where a reader can check it rather than in a comment. It is also what makes the page
 * checkable against the balance sheet: the same account, the same day, the same figure.
 *
 * WHEN IT DOES NOT TIE, THE REPORT STILL DRAWS. `ties` is main's answer and it is said
 * loudly, but never in place of the rows — the rows are the diagnosis. A page that
 * refused to draw would leave the person holding it with a number they cannot explain and
 * nothing to look at, which is the opposite of what a report is for.
 *
 * NOTHING HERE ADDS UP (CONVENTIONS §1.7), including the difference between the two
 * figures that disagree. The notice states both and lets the reader subtract.
 *
 * ONE THING THIS PAGE HAS THAT THE REGISTERS REFUSE: an overdue flag. `DocumentRegister`
 * argues on purpose that a register cannot say it, because a document does not know what
 * has been paid against it. Every row here is money still standing on the account as at
 * the date, so here the word means what it says — see `isOverdue`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Badge, Button, Input } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { makeRoute } from '@renderer/lib/routing'
import { registerScreens, type ScreenContext, type ScreenDefinition } from '@renderer/lib/screens'
import { useRegisterCommands } from '@renderer/store/commands'
import { useNumberFormat } from '@renderer/store/regime'
import { TRADE_SIDES, type TradeSide } from '@shared/documents'
import type { AgedPartyRow, AgedReport as Report, AppError } from '@shared/dto'
import { FailureNotice } from '../components/FailureNotice'
import { Notice } from '../components/Notice'
import { ScreenFrame } from '../components/ScreenFrame'
import {
  agedEmptySentence,
  agedLede,
  agedNav,
  agedScreenId,
  agedTitle,
  agedTotalLabel,
  bucketNameIn,
  bucketRangeSentence,
  columnFigure,
  dueDateFor,
  hasUnattributed,
  isUnattributed,
  itemNumberLabel,
  itemSourceLabel,
  itemTarget,
  overdueLabel,
  rowKey,
  UNATTRIBUTED_NOTE,
} from '../lib/ageing-view'
import { partyLabel } from '../lib/document-view'
import { formatAmount, formatAmountOrBlank } from '../lib/ledger-format'
import { todayISO } from '../lib/report-view'

export function AgedReport({ side, navigate }: ScreenContext & { side: TradeSide }): JSX.Element {
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [asAtDate, setAsAtDate] = useState(() => todayISO())
  const [isBusy, setBusy] = useState(false)
  /* Which parties are showing their items. Keyed rather than indexed — see `rowKey`. */
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())

  /* The date is passed in rather than read from state, so this does not change when the
   * date field does. The user says when they have finished by pressing Apply. */
  const loadAsAt = useCallback(
    async (date: string) => {
      setBusy(true)
      const result = await callApi((api) => api.reports.aged({ side, asAtDate: date }))
      setBusy(false)

      if (!result.ok) {
        setError(result.error)
        return
      }
      setError(null)
      setReport(result.data)
      /* A different day is a different set of rows. Leaving drill-downs open would show
       * one party's items under another's figures. */
      setOpen(new Set())
    },
    [side],
  )

  const load = useCallback(() => loadAsAt(asAtDate), [loadAsAt, asAtDate])

  useEffect(() => {
    void loadAsAt(todayISO())
  }, [loadAsAt])

  const toggle = useCallback((key: string) => {
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: `reports.${agedScreenId(side)}.refresh`,
          title: `Refresh the ${agedTitle(side).toLowerCase()}`,
          section: 'Reports',
          keywords: ['aged', 'ageing', 'overdue', 'outstanding', 'reload'],
          run: () => void load(),
        },
      ],
      [load, side],
    ),
  )

  return (
    <ScreenFrame
      isInset
      width="list"
      title={agedTitle(side)}
      lede={agedLede(side)}
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

        {report === null ? (
          <p className="prose prose--muted">Reading the account…</p>
        ) : (
          <>
            {!report.ties && <TieNotice report={report} />}
            {hasUnattributed(report.parties) && (
              <Notice tone="warning" title="A line on this account names no party">
                <p>{UNATTRIBUTED_NOTE}</p>
              </Notice>
            )}

            <p className="prose prose--muted">
              As at {report.asAtDate} · {report.accountCode} · {report.accountName}
            </p>

            {report.parties.length === 0 ? (
              <Notice tone="info" title="Nothing outstanding">
                <p>{agedEmptySentence(side)}</p>
              </Notice>
            ) : (
              <AgedTable
                report={report}
                side={side}
                open={open}
                onToggle={toggle}
                navigate={navigate}
              />
            )}
          </>
        )}
      </div>
    </ScreenFrame>
  )
}

/**
 * The two figures this report exists to reconcile, when they disagree.
 *
 * Both are stated and neither is subtracted from the other. It says what it is and what
 * to do, and it does not stop anything below it from being drawn.
 */
function TieNotice({ report }: { report: Report }): JSX.Element {
  const format = useNumberFormat()
  return (
    <Notice tone="danger" title="This report does not agree with the account">
      <p>
        The rows below come to {formatAmount(report.totals.total, format)}, and {report.accountCode}{' '}
        · {report.accountName} stands at {formatAmount(report.controlBalance, format)} as at{' '}
        {report.asAtDate}. Every line on that account is meant to be here, so the two cannot differ
        — please report it, with a backup if you can. The rows are still shown below, because the
        difference is somewhere among them.
      </p>
    </Notice>
  )
}

interface TableProps {
  report: Report
  side: TradeSide
  open: ReadonlySet<string>
  onToggle: (key: string) => void
  navigate: ScreenContext['navigate']
}

/*
 * One column per bucket, then what stands to the party's credit, then what they owe.
 *
 * "LESS ON ACCOUNT" IS THE HEADING, NOT "ON ACCOUNT". `total` is the columns LESS what is
 * on account, and main sends that figure as a positive quantity — it is what stands to
 * the party's credit, not a negative debt. A reader adding across a row headed "On
 * account" would be out by twice it. The heading carries the sign, because the renderer
 * may not (CONVENTIONS §1.7): flipping it here would be arithmetic on money.
 */
function AgedTable({ report, side, open, onToggle, navigate }: TableProps): JSX.Element {
  const format = useNumberFormat()

  return (
    <table className="ledger-table ledger-table--figures">
      <thead>
        <tr>
          <th scope="col">{partyLabel(side)}</th>
          {report.buckets.map((bucket, index) => (
            <th
              key={index}
              scope="col"
              className="ledger-table__figure"
              title={bucketRangeSentence(bucket)}
            >
              {bucket.label}
            </th>
          ))}
          <th scope="col" className="ledger-table__figure">
            Less on account
          </th>
          <th scope="col" className="ledger-table__figure">
            Total
          </th>
        </tr>
      </thead>
      <tbody>
        {report.parties.map((row) => (
          <PartyRows
            key={rowKey(row)}
            report={report}
            row={row}
            isOpen={open.has(rowKey(row))}
            onToggle={() => onToggle(rowKey(row))}
            navigate={navigate}
          />
        ))}
      </tbody>
      <tfoot>
        <tr className="ledger-table__subtotal">
          <td>{agedTotalLabel(side)}</td>
          <Figures report={report} figures={report.totals.buckets} />
          <td className="ledger-table__figure">
            {formatAmountOrBlank(report.totals.onAccount, format)}
          </td>
          <td className="ledger-table__figure">{formatAmount(report.totals.total, format)}</td>
        </tr>
        {/* The claim, made where it can be checked. */}
        <tr className="ledger-table__total">
          <td>
            Balance on {report.accountCode} · {report.accountName}
          </td>
          <td colSpan={report.buckets.length + 1} />
          <td className="ledger-table__figure">{formatAmount(report.controlBalance, format)}</td>
        </tr>
      </tfoot>
    </table>
  )
}

/*
 * One cell per column of the report, in the report's own order.
 *
 * KEYED BY INDEX, WHICH IS THE TRUTH HERE. A column's identity IS its position — that is
 * what `item.bucket` indexes — so the position is the honest key, and a label key would
 * additionally collide if a table ever arrived with two columns named alike.
 */
function Figures({ report, figures }: { report: Report; figures: readonly string[] }): JSX.Element {
  const format = useNumberFormat()
  return (
    <>
      {report.buckets.map((_bucket, index) => {
        const figure = columnFigure(figures, index)
        return (
          <td key={index} className="ledger-table__figure">
            {figure === null ? '' : formatAmountOrBlank(figure, format)}
          </td>
        )
      })}
    </>
  )
}

interface PartyRowsProps {
  report: Report
  row: AgedPartyRow
  isOpen: boolean
  onToggle: () => void
  navigate: ScreenContext['navigate']
}

/**
 * A party's figures, and its items under them when it is open.
 *
 * The row that names nobody is drawn like any other and marked. Its money is real and the
 * foot needs it, so hiding it is the one thing that would make this page disagree with the
 * account it claims to equal — and it is the only place in the product where such a line
 * is visible at all.
 */
function PartyRows({ report, row, isOpen, onToggle, navigate }: PartyRowsProps): JSX.Element {
  const format = useNumberFormat()
  /* Party, one per bucket, on account, total. What the drill-down row spans. */
  const columnCount = report.buckets.length + 3

  return (
    <>
      <tr className="ledger-table__row">
        <td>
          <Button
            variant="ghost"
            size="sm"
            icon={isOpen ? 'chevron-down' : 'chevron-right'}
            aria-expanded={isOpen}
            onClick={onToggle}
          >
            {row.partyName}
          </Button>
          {/* Not a party without a name. See `isUnattributed`. */}
          {isUnattributed(row) && <Badge tone="warning">No party</Badge>}
        </td>
        <Figures report={report} figures={row.buckets} />
        <td className="ledger-table__figure">{formatAmountOrBlank(row.onAccount, format)}</td>
        <td className="ledger-table__figure">{formatAmount(row.total, format)}</td>
      </tr>
      {isOpen && (
        <tr className="aged__drill">
          <td colSpan={columnCount}>
            <AgedItems report={report} row={row} navigate={navigate} />
          </td>
        </tr>
      )}
    </>
  )
}

/*
 * WHAT THE FIGURES ABOVE ARE MADE OF — AS A LIST, NOT ACROSS THE SAME COLUMNS.
 *
 * Laying each item under the column it fell in would read beautifully and would be wrong
 * in one place: an amount standing to the party's credit arrives NEGATIVE, while the
 * party row's on-account figure is the same money as a POSITIVE. Under one heading the
 * two would contradict each other, and the only way to reconcile them is for the renderer
 * to flip a sign — which is arithmetic on money.
 *
 * So an item names its column instead, the amount is printed exactly as main sent it, and
 * the reader can see a credit for what it is.
 */
function AgedItems({
  report,
  row,
  navigate,
}: {
  report: Report
  row: AgedPartyRow
  navigate: ScreenContext['navigate']
}): JSX.Element {
  const format = useNumberFormat()

  return (
    <table className="ledger-table aged__items">
      <thead>
        <tr>
          <th scope="col">Number</th>
          <th scope="col">What it is</th>
          <th scope="col">Date</th>
          <th scope="col">Due</th>
          <th scope="col">Age</th>
          <th scope="col" className="ledger-table__figure">
            Amount
          </th>
        </tr>
      </thead>
      <tbody>
        {row.items.map((item) => {
          const target = itemTarget(item)
          const due = dueDateFor(item)
          const late = overdueLabel(item)
          return (
            <tr key={`${item.source}:${item.sourceId}`}>
              <td className="ledger-table__code">
                {target === null ? (
                  itemNumberLabel(item)
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate(makeRoute('workspace', target.screenId, target.params))}
                  >
                    {itemNumberLabel(item)}
                  </Button>
                )}
              </td>
              <td>{itemSourceLabel(item)}</td>
              <td className="ledger-table__code">{item.date}</td>
              {/* A dash where nothing falls due. See `dueDateFor`. */}
              <td className="ledger-table__code">{due ?? '—'}</td>
              <td>
                <span className="aged__age">{bucketNameIn(report.buckets, item.bucket)}</span>
                {late !== null && <Badge tone="negative">{late}</Badge>}
              </td>
              <td className="ledger-table__figure">{formatAmount(item.amount, format)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/*
 * TWO REGISTRATIONS FROM THE SIDE TABLE, the shape every screen registered per kind takes.
 * `TRADE_SIDES` is derived from `DOCUMENT_KINDS`, so a third side gets a report and a
 * rail entry with no edit here — and `SIDE_WORDS` fails to compile until somebody has
 * decided what to call it, which is the right order for that to happen in.
 */
export const agedReportScreens: readonly ScreenDefinition[] = TRADE_SIDES.map((side) => ({
  id: agedScreenId(side),
  title: agedTitle(side),
  area: 'workspace' as const,
  nav: agedNav(side),
  render: (context: ScreenContext) => <AgedReport {...context} side={side} />,
}))

registerScreens(agedReportScreens)
