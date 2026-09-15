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
 * WHAT IS ON ACCOUNT IS A COLUMN, AND IT IS THE POINT OF THE SCREEN. A receipt nobody has
 * matched is not an error and not an unfinished task — it is money the customer has paid
 * and the business has not decided about. It has to be visible, or an aged report and the
 * balance sheet stop agreeing for a reason nobody can find (rule 3).
 *
 * IT PAGES, for the reason the document register does, and since 5b says where on the list
 * it is from `receipts.count`. The same toolbar, skeleton, empty state and foot as that
 * register; a voucher has no settlement badge because its settling is the On account column.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Badge, Button } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { makeRoute } from '@renderer/lib/routing'
import { registerScreens, type ScreenContext, type ScreenDefinition } from '@renderer/lib/screens'
import { useRegisterCommands } from '@renderer/store/commands'
import { useNumberFormat } from '@renderer/store/regime'
import type { AppError, ReceiptStatusDto, ReceiptSummary } from '@shared/dto'
import { RECEIPT_KINDS, receiptDefinitionOf, type ReceiptKind } from '@shared/receipts'
import { FailureNotice } from '../components/FailureNotice'
import { RegisterPager } from '../components/RegisterPager'
import { RegisterSkeleton } from '../components/RegisterSkeleton'
import { RegisterEmpty, RegisterToolbar } from '../components/RegisterToolbar'
import { ScreenFrame } from '../components/ScreenFrame'
import { formatDate } from '../lib/dates'
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
  registerSearchPlaceholder,
  statusFilters,
  statusLabel,
  statusTone,
} from '../lib/receipt-view'

const SKELETON_COLUMNS = [
  { width: '10rem' },
  { width: '1fr' },
  { width: '7rem' },
  { width: '6rem' },
  { width: '8rem', align: 'end' },
  { width: '8rem', align: 'end' },
] as const

export function ReceiptRegister({
  kind,
  navigate,
}: ScreenContext & { kind: ReceiptKind }): JSX.Element {
  const format = useNumberFormat()
  const definition = receiptDefinitionOf(kind)
  const label = definition.label.toLowerCase()

  /* One place that knows where the editor lives. No id is a new voucher. */
  const openReceipt = useCallback(
    (id?: string) =>
      navigate(makeRoute('workspace', editorScreenId(kind), id === undefined ? {} : { id })),
    [kind, navigate],
  )

  const [rows, setRows] = useState<ReceiptSummary[] | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [status, setStatus] = useState<ReceiptStatusDto | ''>('')
  const [search, setSearch] = useState('')
  /* What was actually asked for, as distinct from what is in the box. */
  const [applied, setApplied] = useState('')
  const [page, setPage] = useState(0)
  const [hasMore, setMore] = useState(false)

  const load = useCallback(async () => {
    const filter = {
      kind,
      ...(status === '' ? {} : { status }),
      ...(applied.trim() === '' ? {} : { search: applied.trim() }),
    }
    const [result, count] = await Promise.all([
      callApi((api) =>
        api.receipts.list({
          ...filter,
          /* One more than is drawn. The extra row is the whole paging mechanism. */
          limit: PAGE_SIZE + 1,
          offset: page * PAGE_SIZE,
        }),
      ),
      callApi((api) => api.receipts.count(filter)),
    ])
    setTotal(count.ok ? count.data : null)
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
          title: `Record a ${label}`,
          section: definition.side === 'sales' ? 'Sales' : 'Purchases',
          keywords: [label, 'money', 'paid', 'cheque', 'bank'],
          run: () => openReceipt(),
        },
        {
          id: `receipts.${kind}.refresh`,
          title: `Refresh the ${definition.pluralLabel.toLowerCase()} register`,
          section: definition.side === 'sales' ? 'Sales' : 'Purchases',
          keywords: [label, 'reload'],
          run: () => void load(),
        },
      ],
      [definition, kind, label, load, openReceipt],
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
          Record a {label}
        </Button>
      }
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="ledger" />}

        <RegisterToolbar
          placeholder={registerSearchPlaceholder(definition.side)}
          search={search}
          onSearchChange={setSearch}
          onSearchSubmit={() => refine(() => setApplied(search))}
          filters={statusFilters()}
          status={status}
          onStatusChange={(next) => refine(() => setStatus(next))}
        />

        {rows === null ? (
          error === null && (
            <RegisterSkeleton
              label={definition.pluralLabel.toLowerCase()}
              columns={SKELETON_COLUMNS}
            />
          )
        ) : rows.length === 0 ? (
          <RegisterEmpty
            plural={definition.pluralLabel.toLowerCase()}
            isFiltered={isFiltered}
            sentence={emptyRegisterSentence(kind)}
            newLabel={`Record a ${label}`}
            onNew={() => openReceipt()}
            onClear={() =>
              refine(() => {
                setStatus('')
                setSearch('')
                setApplied('')
              })
            }
          />
        ) : (
          <div className="register">
            <table className="ledger-table ledger-table--figures register__table">
              <thead>
                <tr>
                  <th scope="col">Number</th>
                  <th scope="col">{partyLabel(definition.side)}</th>
                  <th scope="col">Date</th>
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
                    <td className="register__number">
                      <Button
                        variant="ghost"
                        size="sm"
                        isIdentifier
                        onClick={() => openReceipt(receipt.id)}
                      >
                        {receipt.number}
                      </Button>
                    </td>
                    <td className="register__party">{receipt.partyName}</td>
                    <td className="ledger-table__date">{formatDate(receipt.date)}</td>
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

            <RegisterPager
              offset={page * PAGE_SIZE}
              rowsOnPage={rows.length}
              total={total}
              hasPrevious={page > 0}
              hasNext={hasMore}
              onPrevious={() => setPage((current) => Math.max(0, current - 1))}
              onNext={() => setPage((current) => current + 1)}
            />
          </div>
        )}
      </div>
    </ScreenFrame>
  )
}

/*
 * One registration per kind, from the kind table — the same shape the document registers
 * take, and four of them since 0015. What a new kind has to supply on this side is a nav
 * ORDER, because that table is keyed by kind and is the one thing here a new row does not
 * fill in by itself.
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
