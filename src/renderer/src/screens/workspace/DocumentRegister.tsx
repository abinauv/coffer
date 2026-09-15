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
 * ONE BADGE PER ROW, AND IT IS THE ANSWER A READER SCANS FOR (5b). An issued invoice that
 * has been settled says Paid, one partly settled says Part paid, one past its due date with
 * money still on it says Overdue 31d; otherwise the row says what its status is. The state
 * is main's (`DocumentListRow.settlement`, from the aged report's own figures) and
 * `settlementBadge` only names it — "late" is a date comparison, not money. The due column
 * went with the redesign: the badge says when a date matters, and the editor shows it.
 *
 * IT PAGES, AND SAYS WHERE. `listDocuments` caps at MAX_DOCUMENT_PAGE (500) whatever it is
 * asked for, so a register with no paging would show the first page of a busy year and
 * look complete. This asks for one more row than it draws and uses the extra as the answer
 * to "is there another page", and asks `documents.count` how many there are in all.
 *
 * NO TOTAL FOR THE PAGE. Every figure here is a document's own, sent by main. A sum across
 * the rows would be renderer arithmetic (CONVENTIONS §1.7), and worse, the total of a PAGE —
 * a number that changes when you press Next and means nothing in either position.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Badge, Button } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { makeRoute } from '@renderer/lib/routing'
import { registerScreens, type ScreenContext, type ScreenDefinition } from '@renderer/lib/screens'
import { todayISO } from '@renderer/lib/today'
import { useRegisterCommands } from '@renderer/store/commands'
import { useNumberFormat } from '@renderer/store/regime'
import { definitionOf, DOCUMENT_KINDS, type DocumentKind } from '@shared/documents'
import type { AppError, DocumentListRow, DocumentStatusDto } from '@shared/dto'
import { FailureNotice } from '../components/FailureNotice'
import { RegisterPager } from '../components/RegisterPager'
import { RegisterSkeleton } from '../components/RegisterSkeleton'
import { RegisterEmpty, RegisterToolbar } from '../components/RegisterToolbar'
import { ScreenFrame } from '../components/ScreenFrame'
import { formatDate } from '../lib/dates'
import { formatAmount } from '../lib/ledger-format'
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
  settlementBadge,
  statusFilters,
  statusLabel,
  statusTone,
} from '../lib/document-view'

/* The real table's columns, so the skeleton holds the grid the rows arrive into. */
const SKELETON_COLUMNS = [
  { width: '10rem' },
  { width: '1fr' },
  { width: '7rem' },
  { width: '7rem' },
  { width: '8rem', align: 'end' },
] as const

export function DocumentRegister({
  kind,
  navigate,
}: ScreenContext & { kind: DocumentKind }): JSX.Element {
  const format = useNumberFormat()
  const definition = definitionOf(kind)
  const label = definition.label.toLowerCase()

  /* One place that knows where the editor lives. No id is a new document — the editor
   * creates nothing until it is asked to. */
  const openDocument = useCallback(
    (id?: string) =>
      navigate(makeRoute('workspace', editorScreenId(kind), id === undefined ? {} : { id })),
    [kind, navigate],
  )

  const [rows, setRows] = useState<DocumentListRow[] | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [status, setStatus] = useState<DocumentStatusDto | ''>('')
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
        api.documents.list({
          ...filter,
          /* One more than is drawn. The extra row is the whole paging mechanism. */
          limit: PAGE_SIZE + 1,
          offset: page * PAGE_SIZE,
        }),
      ),
      callApi((api) => api.documents.count(filter)),
    ])
    /* A count that failed leaves "of N" off the line; the page is still the answer. */
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
   * note. The section is the rail's section, so a purchase command files under Purchases.
   */
  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: `documents.${kind}.new`,
          title: `New ${label}`,
          section: definition.side === 'sales' ? 'Sales' : 'Purchases',
          keywords: [...label.split(' '), 'draft', 'create'],
          run: () => openDocument(),
        },
        {
          id: `documents.${kind}.refresh`,
          title: `Refresh the ${label} register`,
          section: definition.side === 'sales' ? 'Sales' : 'Purchases',
          keywords: [...label.split(' '), 'documents', 'reload'],
          run: () => void load(),
        },
      ],
      [definition, kind, label, load, openDocument],
    ),
  )

  const isFiltered = status !== '' || applied.trim() !== ''
  const today = todayISO()

  return (
    <ScreenFrame
      isInset
      width="list"
      title={definition.pluralLabel}
      lede={registerLede(kind)}
      actions={
        <Button icon="plus" variant="primary" onClick={() => openDocument()}>
          New {label}
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
            newLabel={`New ${label}`}
            onNew={() => openDocument()}
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
                </tr>
              </thead>
              <tbody>
                {rows.map((document) => {
                  const settled = settlementBadge(document, today)
                  return (
                    <tr key={document.id} className="ledger-table__row">
                      {/* A draft has no number and must not borrow one. Saying "Draft" where
                          the number goes is the honest answer — a blank cell reads as a
                          number that failed to load. */}
                      <td className="register__number">
                        <Button
                          variant="ghost"
                          size="sm"
                          isIdentifier={document.number !== null}
                          onClick={() => openDocument(document.id)}
                        >
                          {document.number ?? 'Draft'}
                        </Button>
                      </td>
                      <td className="register__party">{document.partyName}</td>
                      <td className="ledger-table__date">{formatDate(document.date)}</td>
                      <td>
                        {settled === null ? (
                          <Badge
                            tone={statusTone(document.status)}
                            isStruck={isStruckStatus(document.status)}
                          >
                            {statusLabel(document.status)}
                          </Badge>
                        ) : (
                          <Badge tone={settled.tone}>{settled.label}</Badge>
                        )}
                      </td>
                      <td className="ledger-table__figure">
                        {formatAmount(document.grandTotal, format)}
                      </td>
                    </tr>
                  )
                })}
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
 * FIVE REGISTRATIONS FROM THE KIND TABLE, not five hand-written entries. A sixth kind
 * added to `@shared/documents` gets a register and a rail entry with no edit here.
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
