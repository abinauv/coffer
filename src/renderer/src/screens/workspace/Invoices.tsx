/*
 * The invoice register.
 *
 * Every sales invoice these books have raised, drafts included. The screen a user lives
 * in, so what it owes them is an honest answer to "where is that one" — which is filter,
 * search, and a status they can read at a glance.
 *
 * INVOICE-ONLY, ON PURPOSE. `documents` is one table for five kinds and a quotation is
 * issuable today, but a register that mixed a quotation into a list of invoices would
 * invite reading it as a sales figure. `kind` is fixed here rather than offered as a
 * filter; the other kinds get their own screens when they get their own posting rules.
 *
 * IT PAGES, AND SAYS SO. `listDocuments` caps at MAX_DOCUMENT_PAGE (500) whatever it is
 * asked for, so a register with no paging would show the first page of a busy year and
 * look complete. This asks for one more row than it draws and uses the extra as the
 * answer to "is there another page" — no count query, and no way to be off by one.
 *
 * NO TOTAL FOR THE PAGE. Every figure here is a document's own, sent by main. A sum
 * across the rows would be renderer arithmetic (CONVENTIONS §1.7), and worse, it would be
 * the total of a PAGE — a number that changes when you press Next and means nothing in
 * either position.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Badge, Button, Input } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { makeRoute } from '@renderer/lib/routing'
import { registerScreens, type ScreenContext } from '@renderer/lib/screens'
import { useRegisterCommands } from '@renderer/store/commands'
import { useNumberFormat } from '@renderer/store/regime'
import type { AppError, DocumentStatusDto, DocumentSummary } from '@shared/dto'
import { FailureNotice } from '../components/FailureNotice'
import { Notice } from '../components/Notice'
import { ScreenFrame } from '../components/ScreenFrame'
import { formatAmount } from '../lib/ledger-format'
import {
  INVOICE_KIND,
  PAGE_SIZE,
  statusFilters,
  statusLabel,
  statusTone,
} from '../lib/invoice-view'

export function Invoices({ navigate }: ScreenContext): JSX.Element {
  const format = useNumberFormat()

  /* One place that knows where the editor lives. No id is a new invoice — the editor
   * creates nothing until it is asked to. */
  const openInvoice = useCallback(
    (id?: string) => navigate(makeRoute('workspace', 'invoice', id === undefined ? {} : { id })),
    [navigate],
  )

  const [rows, setRows] = useState<DocumentSummary[] | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [status, setStatus] = useState<DocumentStatusDto | ''>('')
  const [search, setSearch] = useState('')
  /* What was actually asked for, as distinct from what is in the box. The register is
   * fetched per page and per filter, and re-fetching on every keystroke of a search
   * would put a query on the books for each letter. */
  const [applied, setApplied] = useState('')
  const [page, setPage] = useState(0)
  const [hasMore, setMore] = useState(false)

  const load = useCallback(async () => {
    const result = await callApi((api) =>
      api.documents.list({
        kind: INVOICE_KIND,
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
  }, [applied, page, status])

  useEffect(() => {
    void load()
  }, [load])

  /* Any change to what is being looked for starts again at the first page. Staying on
   * page 4 of a filter that now matches six documents shows an empty register and reads
   * as "there are none". */
  const refine = useCallback((change: () => void) => {
    setPage(0)
    change()
  }, [])

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: 'documents.invoice-new',
          title: 'New invoice',
          section: 'Sales',
          keywords: ['invoice', 'draft', 'create', 'sales'],
          run: () => openInvoice(),
        },
        {
          id: 'documents.invoices-refresh',
          title: 'Refresh the invoice register',
          section: 'Sales',
          keywords: ['invoice', 'documents', 'reload'],
          run: () => void load(),
        },
      ],
      [load, openInvoice],
    ),
  )

  const isFiltered = status !== '' || applied.trim() !== ''

  return (
    <ScreenFrame
      isInset
      width="list"
      title="Invoices"
      lede="Every invoice these books have raised, and every draft not yet issued."
      actions={
        <Button icon="plus" variant="primary" onClick={() => openInvoice()}>
          New invoice
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
              placeholder="Search by number, party or narration"
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
          <Notice tone="info" title={isFiltered ? 'Nothing matches that' : 'No invoices yet'}>
            <p>
              {isFiltered
                ? 'No invoice on this page matches. Clearing the search or the status filter will show the rest.'
                : 'An invoice needs a customer and the business details filled in — both are in the sidebar. Then New invoice starts one.'}
            </p>
          </Notice>
        ) : (
          <table className="ledger-table ledger-table--figures">
            <thead>
              <tr>
                <th scope="col">Number</th>
                <th scope="col">Date</th>
                <th scope="col">Customer</th>
                <th scope="col">Status</th>
                <th scope="col" className="ledger-table__figure">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((document) => (
                <tr key={document.id} className="ledger-table__row">
                  {/* A draft has no number and must not borrow one. Saying "Draft" where
                      the number goes is the honest answer — a blank cell reads as a
                      number that failed to load. */}
                  <td className="ledger-table__code">
                    <Button variant="ghost" size="sm" onClick={() => openInvoice(document.id)}>
                      {document.number ?? 'Draft'}
                    </Button>
                  </td>
                  <td className="ledger-table__code">{document.date}</td>
                  <td>{document.partyName}</td>
                  <td>
                    <Badge tone={statusTone(document.status)}>{statusLabel(document.status)}</Badge>
                  </td>
                  <td className="ledger-table__figure">
                    {formatAmount(document.grandTotal, format)}
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

registerScreens([
  {
    id: 'invoices',
    title: 'Invoices',
    area: 'workspace',
    nav: { label: 'Invoices', icon: 'ledger', group: 'sales', order: 1 },
    render: (context) => <Invoices {...context} />,
  },
])
