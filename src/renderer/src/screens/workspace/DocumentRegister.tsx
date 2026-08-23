/*
 * The document registers — one component, registered once per kind.
 *
 * Every document of one kind these books hold, drafts included. The screen a user lives
 * in, so what it owes them is an honest answer to "where is that one" — which is filter,
 * search, and a status they can read at a glance.
 *
 * ONE KIND PER SCREEN, STILL ON PURPOSE. `documents` is one table for five kinds and this
 * does not mix them: a register showing quotations beside invoices invites reading the
 * page as a sales figure, and one showing purchases beside sales invites reading it as
 * anything at all. `kind` is fixed per registration rather than offered as a filter.
 *
 * WHAT CHANGED IN 0013-2 IS THE COUNT, NOT THE RULE. This was `Invoices.tsx`, and its
 * header said the other kinds would get their own screens when they got their own posting
 * rules. They have them as of 0013-1, so they get their screens — from the same component,
 * because a register differs by kind in its title, its party column and its empty state,
 * and in nothing else. Five copies would be five places to fix the next paging bug.
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
import { registerScreens, type ScreenContext, type ScreenDefinition } from '@renderer/lib/screens'
import { useRegisterCommands } from '@renderer/store/commands'
import { useNumberFormat } from '@renderer/store/regime'
import { definitionOf, DOCUMENT_KINDS, type DocumentKind } from '@shared/documents'
import type { AppError, DocumentStatusDto, DocumentSummary } from '@shared/dto'
import { FailureNotice } from '../components/FailureNotice'
import { Notice } from '../components/Notice'
import { ScreenFrame } from '../components/ScreenFrame'
import { formatAmount } from '../lib/ledger-format'
import {
  editorScreenId,
  emptyRegisterSentence,
  PAGE_SIZE,
  partyLabel,
  registerLede,
  registerNav,
  registerScreenId,
  statusFilters,
  statusLabel,
  statusTone,
} from '../lib/document-view'

export function DocumentRegister({
  kind,
  navigate,
}: ScreenContext & { kind: DocumentKind }): JSX.Element {
  const format = useNumberFormat()
  const definition = definitionOf(kind)

  /* One place that knows where the editor lives. No id is a new document — the editor
   * creates nothing until it is asked to. */
  const openDocument = useCallback(
    (id?: string) =>
      navigate(makeRoute('workspace', editorScreenId(kind), id === undefined ? {} : { id })),
    [kind, navigate],
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
   * page 4 of a filter that now matches six documents shows an empty register and reads
   * as "there are none". */
  const refine = useCallback((change: () => void) => {
    setPage(0)
    change()
  }, [])

  /*
   * TWO COMMANDS PER KIND, AND THE IDS CARRY THE KIND. Every register mounts its own, so
   * ids built from a fixed string would collide the moment two of these screens have
   * been visited — and the palette would offer one "New invoice" that raised a debit
   * note. The section is the sidebar group, so a purchase command files under Purchases.
   */
  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: `documents.${kind}.new`,
          title: `New ${definition.label.toLowerCase()}`,
          section: definition.side === 'sales' ? 'Sales' : 'Purchases',
          keywords: [...definition.label.toLowerCase().split(' '), 'draft', 'create'],
          run: () => openDocument(),
        },
        {
          id: `documents.${kind}.refresh`,
          title: `Refresh the ${definition.label.toLowerCase()} register`,
          section: definition.side === 'sales' ? 'Sales' : 'Purchases',
          keywords: [...definition.label.toLowerCase().split(' '), 'documents', 'reload'],
          run: () => void load(),
        },
      ],
      [definition, kind, load, openDocument],
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
        <Button icon="plus" variant="primary" onClick={() => openDocument()}>
          New {definition.label.toLowerCase()}
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
                    <Button variant="ghost" size="sm" onClick={() => openDocument(document.id)}>
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

/*
 * FIVE REGISTRATIONS FROM THE KIND TABLE, not five hand-written entries. A sixth kind
 * added to `@shared/documents` gets a register and a sidebar entry with no edit here —
 * which is the same property `DOCUMENT_KINDS` gives the posting engine, arriving in the
 * renderer for the first time.
 */
export const documentRegisterScreens: readonly ScreenDefinition[] = DOCUMENT_KINDS.map(
  (definition) => ({
    id: registerScreenId(definition.kind),
    title: definition.pluralLabel,
    area: 'workspace' as const,
    nav: registerNav(definition.kind),
    render: (context: ScreenContext) => <DocumentRegister {...context} kind={definition.kind} />,
  }),
)

registerScreens(documentRegisterScreens)
