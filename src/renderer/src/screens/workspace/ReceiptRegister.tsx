/*
 * The money registers — one component, registered once per kind.
 *
 * Every voucher of one kind these books hold. The screen a bookkeeper opens on the
 * morning a statement arrives, so what it owes them is the answer to "did we record that
 * one" — a reference, a party, a date, and how much of it is still on account.
 *
 * ONE KIND PER SCREEN, STILL ON PURPOSE. `receipts` is one table for both directions, and
 * a register mixing money out into a list of money in would invite reading a total that
 * means nothing.
 *
 * WHAT CHANGED IN 0013-3 IS THE COUNT, NOT THE RULE. This was `Receipts.tsx`, and its
 * header said payments would get their own screen when a purchase bill got its posting
 * rule — because until then there was nothing for one to settle. 0013-1 gave it one.
 *
 * WHAT IS ON ACCOUNT IS A COLUMN, AND IT IS THE POINT OF THE SCREEN. A receipt nobody has
 * matched is not an error and not an unfinished task — it is money the customer has paid
 * and the business has not decided about. It has to be visible, or an aged report and the
 * balance sheet stop agreeing for a reason nobody can find (rule 3).
 *
 * IT PAGES, for the reason the invoice register does: `listReceipts` caps at 500 whatever
 * it is asked for, so a register with no paging would show the first page of a busy year
 * and look complete. One row more than is drawn is the whole mechanism.
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
import type { AppError, ReceiptStatusDto, ReceiptSummary } from '@shared/dto'
import { RECEIPT_KINDS, receiptDefinitionOf, type ReceiptKind } from '@shared/receipts'
import { FailureNotice } from '../components/FailureNotice'
import { Notice } from '../components/Notice'
import { ScreenFrame } from '../components/ScreenFrame'
import { formatAmount, formatAmountOrBlank } from '../lib/ledger-format'
import {
  editorScreenId,
  emptyRegisterSentence,
  isStruckStatus,
  PAGE_SIZE,
  partyLabel,
  registerLede,
  registerNav,
  registerScreenId,
  statusFilters,
  statusLabel,
  statusTone,
} from '../lib/receipt-view'

export function ReceiptRegister({
  kind,
  navigate,
}: ScreenContext & { kind: ReceiptKind }): JSX.Element {
  const format = useNumberFormat()
  const definition = receiptDefinitionOf(kind)

  /* One place that knows where the editor lives. No id is a new voucher. */
  const openReceipt = useCallback(
    (id?: string) =>
      navigate(makeRoute('workspace', editorScreenId(kind), id === undefined ? {} : { id })),
    [kind, navigate],
  )

  const [rows, setRows] = useState<ReceiptSummary[] | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [status, setStatus] = useState<ReceiptStatusDto | ''>('')
  const [search, setSearch] = useState('')
  /* What was actually asked for, as distinct from what is in the box: re-fetching on
   * every keystroke would put a query on the books for each letter. */
  const [applied, setApplied] = useState('')
  const [page, setPage] = useState(0)
  const [hasMore, setMore] = useState(false)

  const load = useCallback(async () => {
    const result = await callApi((api) =>
      api.receipts.list({
        kind,
        ...(status === '' ? {} : { status }),
        ...(applied.trim() === '' ? {} : { search: applied.trim() }),
        /* One more than is drawn. The extra row is the whole paging mechanism. */
        limit: PAGE_SIZE + 1,
        offset: page * PAGE_SIZE,
      }),
    )
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    setMore(result.data.length > PAGE_SIZE)
    setRows(result.data.slice(0, PAGE_SIZE))
  }, [applied, kind, page, status])

  useEffect(() => {
    void load()
  }, [load])

  /* Any change to what is being looked for starts again at the first page. Staying on
   * page 4 of a filter that now matches six rows shows an empty register, which reads as
   * "there are none" — the worst answer to give somebody about their own money. */
  const refine = useCallback((change: () => void) => {
    setPage(0)
    change()
  }, [])

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: `receipts.${kind}.new`,
          title: `Record a ${definition.label.toLowerCase()}`,
          section: definition.side === 'sales' ? 'Sales' : 'Purchases',
          keywords: [definition.label.toLowerCase(), 'money', 'paid', 'cheque', 'bank'],
          run: () => openReceipt(),
        },
        {
          id: `receipts.${kind}.refresh`,
          title: `Refresh the ${definition.pluralLabel.toLowerCase()} register`,
          section: definition.side === 'sales' ? 'Sales' : 'Purchases',
          keywords: [definition.label.toLowerCase(), 'reload'],
          run: () => void load(),
        },
      ],
      [definition, kind, load, openReceipt],
    ),
  )

  const isFiltered = status !== '' || applied.trim() !== ''

  return (
    <ScreenFrame
      isInset
      width="list"
      title={definition.pluralLabel}
      lede={registerLede(kind)}
      actions={
        <Button icon="plus" variant="primary" onClick={() => openReceipt()}>
          Record a {definition.label.toLowerCase()}
        </Button>
      }
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="ledger" />}

        <div className="toolbar">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              refine(() => setApplied(search))
            }}
          >
            <Input
              label="Search"
              isLabelHidden
              icon="search"
              placeholder={`Search by number, ${partyLabel(definition.side).toLowerCase()}, reference or narration`}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </form>

          {statusFilters().map((filter) => (
            <Button
              key={filter.value}
              variant={status === filter.value ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => refine(() => setStatus(filter.value))}
            >
              {filter.label}
            </Button>
          ))}
        </div>

        {rows === null ? (
          <p className="prose prose--muted">Reading the register…</p>
        ) : rows.length === 0 ? (
          <Notice
            tone="info"
            title={
              isFiltered ? 'Nothing matches that' : `No ${definition.pluralLabel.toLowerCase()} yet`
            }
          >
            <p>
              {isFiltered
                ? 'Nothing on this page matches. Clearing the search or the status filter will show the rest.'
                : emptyRegisterSentence(kind)}
            </p>
          </Notice>
        ) : (
          <table className="ledger-table ledger-table--figures">
            <thead>
              <tr>
                <th scope="col">Number</th>
                <th scope="col">Date</th>
                <th scope="col">{partyLabel(definition.side)}</th>
                <th scope="col">Status</th>
                <th scope="col" className="ledger-table__figure">
                  Amount
                </th>
                <th scope="col" className="ledger-table__figure">
                  On account
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((receipt) => (
                <tr key={receipt.id} className="ledger-table__row">
                  <td className="ledger-table__code">
                    <Button variant="ghost" size="sm" onClick={() => openReceipt(receipt.id)}>
                      {receipt.number}
                    </Button>
                  </td>
                  <td className="ledger-table__code">{receipt.date}</td>
                  <td>{receipt.partyName}</td>
                  <td>
                    <Badge
                      tone={statusTone(receipt.status)}
                      isStruck={isStruckStatus(receipt.status)}
                    >
                      {statusLabel(receipt.status)}
                    </Badge>
                  </td>
                  <td className="ledger-table__figure">{formatAmount(receipt.amount, format)}</td>
                  {/* Blank rather than a zero when it is all matched: a column of 0.00
                      against every settled receipt is noise, and what this column is FOR
                      is the row that has something left on it. */}
                  <td className="ledger-table__figure">
                    {formatAmountOrBlank(receipt.unallocated, format)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Shown whenever there is more than one page to be on, so that "Previous" is
            reachable from a page reached by "Next". */}
        {(hasMore || page > 0) && (
          <div className="toolbar">
            <Button
              variant="ghost"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
            >
              Previous
            </Button>
            <span className="prose prose--muted">Page {page + 1}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={!hasMore}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </ScreenFrame>
  )
}

/*
 * One registration per kind, from the kind table — the same shape the document registers
 * take, and FOUR of them since 0015.
 *
 * THE PREDICTION THIS COMMENT USED TO MAKE CAME TRUE UNCHANGED: "a third kind — a customer
 * refund, which is money out on the sales side — gets a register and a sidebar entry with
 * no edit here." It did, and so did the fourth. What the batch actually had to change on
 * this side was a nav ORDER for each of them, because that table is keyed by kind and is
 * the one thing here a new row does not fill in by itself.
 */
export const receiptRegisterScreens: readonly ScreenDefinition[] = RECEIPT_KINDS.map(
  (definition) => ({
    id: registerScreenId(definition.kind),
    title: definition.pluralLabel,
    area: 'workspace' as const,
    nav: registerNav(definition.kind),
    render: (context: ScreenContext) => <ReceiptRegister {...context} kind={definition.kind} />,
  }),
)

registerScreens(receiptRegisterScreens)
