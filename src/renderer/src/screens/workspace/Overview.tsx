/*
 * The workspace landing screen — the first thing anybody sees after unlocking their books.
 *
 * IT WAS A PLACEHOLDER AND IT SAID SO, promising accounts, invoices, purchases and
 * reports "in the next phase". All of that shipped, so the notice was a lie printed on
 * the one screen every session starts on. What is here now is a dashboard: the four
 * questions a small business actually opens its books to ask, in the order they are
 * asked.
 *
 *   WHAT AM I OWED, AND WHAT DO I OWE. Both sides of `reports.aged`, as at today, with
 *   the report's own columns. For most users this IS the dashboard.
 *   WHAT NEEDS ATTENTION. What is late, worst first, across both sides; and the drafts
 *   nobody has issued. Every row opens the thing itself.
 *   WHAT HAS HAPPENED LATELY. The last few documents and vouchers as one sequence.
 *   AND THE COMPANY'S OWN STATE, which is what this screen has always been for.
 *
 * NOT ONE FIGURE ON THIS PAGE IS WORKED OUT HERE (CONVENTIONS §1.7). A dashboard is
 * where that rule is most tempting to break — "total overdue" is one addition away, and
 * so is "net position" — and every one of those additions is money arithmetic in the
 * renderer. What is shown is what main sent: a side's `totals.total`, a column's own
 * figure, an item's own amount. Where a figure would have to be computed to exist, the
 * page does without it. `overview-view.ts` holds the selection and ordering that is left,
 * and nothing else.
 *
 * SEVEN INDEPENDENT READS, AND NO ONE OF THEM CAN TAKE THE SCREEN DOWN. Each panel holds
 * its own `Panel<T>` — loading, ready, or failed with the reason — so an ageing report
 * that cannot resolve its control account leaves the drafts, the activity and the backup
 * button exactly where they were, and says what went wrong in its own box. A dashboard
 * that went blank because one query failed would be worse than no dashboard.
 *
 * AN EMPTY COMPANY READS AS A BEGINNING. A file made this morning has no documents and no
 * parties, and six zeroes over an empty table is the least useful thing to show somebody
 * on their first day. `isNewCompany` swaps the figures for the three things that have to
 * happen first, each marked with whether it is already done — and the two reads behind
 * that checklist are only made when the books turn out to be empty.
 *
 * WHAT DID NOT CHANGE IS THE PART THAT CANNOT WAIT FOR ANY OF IT: proof the right company
 * is open, the backup that makes the encryption survivable, a way to change the
 * passphrase, and a way to close. Backup is the one that matters most. A company is a
 * database and a sidecar vault (ARCHITECTURE §6.3), so copying the file alone produces
 * something nobody can ever open again — `companies.backup` writes one archive holding
 * both, and this screen still never suggests any other way of keeping a copy.
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { Badge, Button, Dialog } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { makeRoute } from '@renderer/lib/routing'
import { describeLocation, registerScreens, type ScreenContext } from '@renderer/lib/screens'
import { useBackup } from '@renderer/store/backup'
import { useRegisterCommands } from '@renderer/store/commands'
import { useScreens } from '@renderer/store/screens'
import { useCompany } from '@renderer/store/company'
import { useNumberFormat } from '@renderer/store/regime'
import { useToasts } from '@renderer/store/toasts'
import type { TradeSide } from '@shared/documents'
import type {
  AgedReport,
  AppError,
  CompanyProfile,
  DocumentSummary,
  PartySummary,
  PassphraseStrength,
  ReceiptSummary,
} from '@shared/dto'
import { EmptyState } from '../components/EmptyState'
import { FailureNotice } from '../components/FailureNotice'
import { Notice } from '../components/Notice'
import { PassphraseField } from '../components/PassphraseField'
import { ScreenFrame } from '../components/ScreenFrame'
import { StrengthMeter } from '../components/StrengthMeter'
import {
  agedEmptySentence,
  agedScreenId,
  agedTotalLabel,
  itemNumberLabel,
  itemSourceLabel,
  itemTarget,
  overdueLabel,
} from '../lib/ageing-view'
import { describeCreated, describeLastOpened } from '../lib/dates'
import { validateChangePassphrase } from '../lib/forms'
import { formatAmount, formatAmountOrBlank } from '../lib/ledger-format'
import { failureTitle } from '../lib/messages'
import { NO_RESET_WARNING } from '../lib/passphrase-meter'
import {
  activityIsStruck,
  activityLabel,
  activityStatusLabel,
  activityTarget,
  activityTone,
  ACTIVITY_LIMIT,
  ATTENTION_LIMIT,
  bucketFigures,
  documentActivity,
  firstRunSteps,
  isNewCompany,
  nextFirstRunStep,
  LINKED_SCREENS,
  mostOverdue,
  outstandingLinkLabel,
  outstandingTitle,
  overdueRowsIn,
  pageOf,
  panelFrom,
  recentActivity,
  stepLabel,
  stepState,
  stepTone,
  type ActivityRow,
  type Panel,
} from '../lib/overview-view'
import { todayISO } from '../lib/report-view'

/** Every panel starts here. Not `null`, which would read as "nothing to show". */
const LOADING = { state: 'loading' } as const

export function Overview({ navigate }: ScreenContext): JSX.Element {
  const { company, recoveryCodesRemaining, close } = useCompany()
  const { show } = useToasts()
  const { backUp: backup, isBackingUp } = useBackup()
  const [isPassphraseOpen, setPassphraseOpen] = useState(false)
  const [isBusy, setBusy] = useState(false)

  const [receivables, setReceivables] = useState<Panel<AgedReport>>(LOADING)
  const [payables, setPayables] = useState<Panel<AgedReport>>(LOADING)
  const [drafts, setDrafts] = useState<Panel<readonly DocumentSummary[]>>(LOADING)
  const [documents, setDocuments] = useState<Panel<readonly DocumentSummary[]>>(LOADING)
  const [receipts, setReceipts] = useState<Panel<readonly ReceiptSummary[]>>(LOADING)
  const [profile, setProfile] = useState<Panel<CompanyProfile | null>>(LOADING)
  const [parties, setParties] = useState<Panel<readonly PartySummary[]>>(LOADING)

  /*
   * FIVE READS AT ONCE, AND EACH LANDS ON ITS OWN PANEL.
   *
   * `Promise.all` for the round trips and five separate `setState`s for the answers: one
   * combined result object would mean a single failure emptying every panel, which is
   * exactly the collapse this screen is built not to have. The date is taken once so
   * both ageing reports are drawn as at the same day — asking twice could straddle
   * midnight and put a receivable and a payable on different dates.
   */
  const load = useCallback(async () => {
    setBusy(true)
    const asAtDate = todayISO()
    const [sales, purchases, draftList, documentList, receiptList] = await Promise.all([
      callApi((api) => api.reports.aged({ side: 'sales', asAtDate })),
      callApi((api) => api.reports.aged({ side: 'purchase', asAtDate })),
      /* One row more than is drawn. The extra row is the whole of "and there are more". */
      callApi((api) => api.documents.list({ status: 'draft', limit: ATTENTION_LIMIT + 1 })),
      callApi((api) => api.documents.list({ limit: ACTIVITY_LIMIT })),
      callApi((api) => api.receipts.list({ limit: ACTIVITY_LIMIT })),
    ])
    setReceivables(panelFrom(sales))
    setPayables(panelFrom(purchases))
    setDrafts(panelFrom(draftList))
    setDocuments(panelFrom(documentList))
    setReceipts(panelFrom(receiptList))
    setBusy(false)
  }, [])

  /*
   * NOTHING IS READ UNTIL A COMPANY IS OPEN. Every channel above needs one and answers
   * `NO_COMPANY_OPEN` without it, so firing them during the frame between closing a
   * company and the shell returning to the picker would fill the dashboard with five
   * failure notices nobody is meant to see.
   */
  const companyId = company?.id ?? null

  useEffect(() => {
    if (companyId !== null) void load()
  }, [companyId, load])

  const isNew = isNewCompany(documents, receipts)

  /*
   * THE CHECKLIST'S TWO READS HAPPEN ONLY WHEN THE BOOKS TURN OUT TO BE EMPTY.
   *
   * `parties.list` has no limit in its input and answers with every party there is, so a
   * dashboard that asked for it every time would pull the whole party master on every
   * visit to say nothing. On an empty company the answer is an empty array, and that is
   * the only company that needs it.
   */
  const loadFirstRun = useCallback(async () => {
    const [profileResult, partyList] = await Promise.all([
      callApi((api) => api.companyProfile.get()),
      callApi((api) => api.parties.list()),
    ])
    setProfile(panelFrom(profileResult))
    setParties(panelFrom(partyList))
  }, [])

  useEffect(() => {
    if (isNew) void loadFirstRun()
  }, [isNew, loadFirstRun])

  const closeCompany = useCallback(async () => {
    const result = await close()
    if (!result.ok) {
      show({
        tone: 'danger',
        title: failureTitle(result.error),
        body: result.error.message,
      })
    }
  }, [close, show])

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: 'company.change-passphrase',
          title: 'Change the passphrase',
          section: 'Company',
          keywords: ['password', 'key', 'security'],
          run: () => setPassphraseOpen(true),
        },
        {
          id: 'company.refresh-overview',
          title: 'Refresh the overview',
          section: 'Company',
          keywords: ['dashboard', 'reload', 'outstanding', 'overdue'],
          run: () => void load(),
        },
      ],
      [load],
    ),
  )

  if (company === null) {
    /* The shell returns to the picker when no company is open, so this is a frame between
     * one state and the next rather than a state a user sits in. */
    return (
      <ScreenFrame title="No company is open" isInset>
        <p className="prose prose--muted">Returning to your companies…</p>
      </ScreenFrame>
    )
  }

  return (
    <ScreenFrame
      isInset
      width="list"
      title={company.displayName}
      lede="Open, decrypted in memory only, and readable by nothing else while it is."
      actions={
        <>
          <Button icon="refresh" onClick={() => void load()} isBusy={isBusy}>
            Refresh
          </Button>
          <Button
            variant="primary"
            icon="archive"
            onClick={() => void backup()}
            isBusy={isBackingUp}
          >
            Back up now
          </Button>
          <Button icon="lock" onClick={() => setPassphraseOpen(true)}>
            Change passphrase
          </Button>
          <Button icon="close" onClick={() => void closeCompany()}>
            Close company
          </Button>
        </>
      }
    >
      <div className="stack">
        {recoveryCodesRemaining === 0 && (
          <Notice tone="warning" title="No recovery codes remain">
            <p>
              Every code issued for this company has been spent. The passphrase is now the only way
              in, and nobody can reset it. Keep a backup, and keep the passphrase somewhere you will
              still have it in a year.
            </p>
          </Notice>
        )}

        {isNew ? (
          <FirstRun profile={profile} parties={parties} documents={documents} navigate={navigate} />
        ) : (
          <>
            <div className="report-columns">
              <Outstanding side="sales" panel={receivables} navigate={navigate} />
              <Outstanding side="purchase" panel={payables} navigate={navigate} />
            </div>

            <div className="report-columns">
              <Overdue receivables={receivables} payables={payables} navigate={navigate} />
              <Drafts panel={drafts} navigate={navigate} />
            </div>

            <Activity documents={documents} receipts={receipts} navigate={navigate} />
          </>
        )}

        <DashboardPanel title="This company">
          <section className="facts">
            <Fact label="Company file" value={company.filePath} isPath />
            <Fact label="Key vault" value={company.vaultPath} isPath />
            <Fact label="Last opened" value={describeLastOpened(company.lastOpenedAt)} />
            <Fact label="Created" value={describeCreated(company.createdAt)} />
            <Fact
              label="Recovery codes left"
              value={
                recoveryCodesRemaining === 0
                  ? 'None — the passphrase is the only way in'
                  : `${recoveryCodesRemaining} unused`
              }
              badge={
                recoveryCodesRemaining === 0 ? (
                  <Badge tone="negative">None left</Badge>
                ) : recoveryCodesRemaining <= 2 ? (
                  <Badge tone="warning">Running low</Badge>
                ) : null
              }
            />
          </section>

          {/* The one thing on this screen that is about surviving a disaster rather than
              running a business, and it keeps its own box for that reason. */}
          <Notice
            tone="info"
            title="A copy of the file alone opens nothing"
            icon="archive"
            actions={
              <Button size="sm" icon="archive" onClick={() => void backup()} isBusy={isBackingUp}>
                Back up now
              </Button>
            }
          >
            <p>
              These books are a database and a separate key vault. Copying one without the other
              leaves an archive nobody can ever open — not you, and not us. Back up now writes a
              single file holding both, and it is the only way of keeping a copy this screen will
              ever suggest.
            </p>
          </Notice>
        </DashboardPanel>
      </div>

      <ChangePassphraseDialog
        key={isPassphraseOpen ? 'open' : 'closed'}
        isOpen={isPassphraseOpen}
        onClose={() => setPassphraseOpen(false)}
      />
    </ScreenFrame>
  )
}

// ---- The frame each panel sits in -------------------------------------------

/**
 * A titled block of the dashboard.
 *
 * A landmark with its heading as the accessible name, rather than a bare `div`: this page
 * is half a dozen unrelated tables, and without regions a screen reader reads them as one
 * undifferentiated run of figures. It is also what lets a test scope an assertion to the
 * panel it is about instead of to the page.
 */
function DashboardPanel({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  const headingId = useId()
  return (
    <section className="stack stack--tight" aria-labelledby={headingId}>
      <h2 id={headingId} className="caps-label">
        {title}
      </h2>
      {children}
    </section>
  )
}

/** A way out of a panel to the screen that holds all of it. */
function PanelLink({
  label,
  screenId,
  navigate,
}: {
  label: string
  screenId: string
  navigate: ScreenContext['navigate']
}): JSX.Element {
  return (
    <div className="actions">
      <Button
        variant="ghost"
        size="sm"
        iconEnd="arrow-right"
        onClick={() => navigate(makeRoute('workspace', screenId))}
      >
        {label}
      </Button>
    </div>
  )
}

// ---- What is owed, each way -------------------------------------------------

/*
 * One side's ageing report, reduced to its foot.
 *
 * "LESS ON ACCOUNT" IS THE HEADING, NOT "ON ACCOUNT" — the same rule the aged report
 * itself follows (CONVENTIONS §1.7). `totals.total` is the columns LESS what is on
 * account, and main sends the on-account figure as a positive quantity, so a reader
 * adding down a column headed "On account" would be out by twice it. The heading carries
 * the sign because the renderer may not: flipping one is arithmetic on money.
 *
 * THE DATE SHOWN IS THE REPORT'S OWN, not this screen's clock. They agree, and stating
 * main's answer is what makes the agreement checkable rather than assumed.
 */
function Outstanding({
  side,
  panel,
  navigate,
}: {
  side: TradeSide
  panel: Panel<AgedReport>
  navigate: ScreenContext['navigate']
}): JSX.Element {
  const format = useNumberFormat()

  return (
    <DashboardPanel title={outstandingTitle(side)}>
      {panel.state === 'loading' && <p className="prose prose--muted">Reading the account…</p>}
      {panel.state === 'failed' && <FailureNotice error={panel.error} context="ledger" />}
      {panel.state === 'ready' && (
        <>
          <p className="prose prose--muted">
            As at {panel.data.asAtDate} · {panel.data.accountCode} · {panel.data.accountName}
          </p>

          {!panel.data.ties && (
            <Notice tone="danger" title="This does not agree with the account">
              <p>
                What is behind this figure does not come to the balance on {panel.data.accountCode}{' '}
                · {panel.data.accountName}. {outstandingLinkLabel(side)} to see the rows — the
                difference is somewhere among them.
              </p>
            </Notice>
          )}

          {panel.data.parties.length === 0 ? (
            <Notice tone="info" title="Nothing outstanding">
              <p>{agedEmptySentence(side)}</p>
            </Notice>
          ) : (
            <table className="ledger-table ledger-table--figures report-table">
              <tbody>
                {bucketFigures(panel.data).map((column, index) => (
                  <tr key={index}>
                    <td>{column.label}</td>
                    <td className="ledger-table__figure">
                      {column.figure === null ? '' : formatAmountOrBlank(column.figure, format)}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td>Less on account</td>
                  <td className="ledger-table__figure">
                    {formatAmountOrBlank(panel.data.totals.onAccount, format)}
                  </td>
                </tr>
              </tbody>
              <tfoot>
                <tr className="ledger-table__total">
                  <td>{agedTotalLabel(side)}</td>
                  <td className="ledger-table__figure">
                    {formatAmount(panel.data.totals.total, format)}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}

          <PanelLink
            label={outstandingLinkLabel(side)}
            screenId={agedScreenId(side)}
            navigate={navigate}
          />
        </>
      )}
    </DashboardPanel>
  )
}

// ---- What needs attention ---------------------------------------------------

/*
 * What is late, across both sides, worst first.
 *
 * IT READS TWO PANELS AND SAYS SO WHEN IT HAS ONLY ONE. "Nothing is overdue" is a claim
 * about the whole business, and a side whose report failed cannot support half of it —
 * so the reassuring sentence is shown only when both reports answered, and a partial
 * answer is labelled as one. The alternative is a green tick over a query that never ran.
 */
function Overdue({
  receivables,
  payables,
  navigate,
}: {
  receivables: Panel<AgedReport>
  payables: Panel<AgedReport>
  navigate: ScreenContext['navigate']
}): JSX.Element {
  const format = useNumberFormat()
  const sides: ReadonlyArray<{ side: TradeSide; panel: Panel<AgedReport> }> = [
    { side: 'sales', panel: receivables },
    { side: 'purchase', panel: payables },
  ]
  const isComplete = sides.every(({ panel }) => panel.state === 'ready')
  const isReading = sides.some(({ panel }) => panel.state === 'loading')
  const rows = mostOverdue(
    sides.flatMap(({ side, panel }) =>
      panel.state === 'ready' ? overdueRowsIn(side, panel.data) : [],
    ),
    ATTENTION_LIMIT,
  )

  return (
    <DashboardPanel title="Overdue">
      {rows.length > 0 ? (
        <>
          <table className="ledger-table ledger-table--figures report-table">
            <thead>
              <tr>
                <th scope="col">Number</th>
                <th scope="col">Who</th>
                <th scope="col">How late</th>
                <th scope="col" className="ledger-table__figure">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const target = itemTarget(row.item)
                const late = overdueLabel(row.item)
                return (
                  <tr key={row.key} className="ledger-table__row">
                    <td className="ledger-table__code">
                      {target === null ? (
                        itemNumberLabel(row.item)
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            navigate(makeRoute('workspace', target.screenId, target.params))
                          }
                        >
                          {itemNumberLabel(row.item)}
                        </Button>
                      )}
                    </td>
                    <td>{row.partyName}</td>
                    <td>
                      {/* Never null on a row `isOverdue` let through, and spelled as a
                          fallback rather than asserted: the badge is what the reader
                          scans, and an empty pill would be worse than a plain word. */}
                      {late === null ? (
                        itemSourceLabel(row.item)
                      ) : (
                        <Badge tone="negative">{late}</Badge>
                      )}
                    </td>
                    <td className="ledger-table__figure">
                      {formatAmount(row.item.amount, format)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {!isComplete && (
            <p className="prose prose--muted">
              One of the two ageing reports could not be read, so this is what the other holds.
            </p>
          )}
        </>
      ) : isReading ? (
        <p className="prose prose--muted">Reading the ageing reports…</p>
      ) : isComplete ? (
        <Notice tone="positive" title="Nothing is overdue">
          <p>
            Every charge in these books is either settled or not yet due. What is due later is in
            the two panels above.
          </p>
        </Notice>
      ) : (
        <p className="prose prose--muted">
          An ageing report could not be read, so nothing can be said about what is overdue. The
          panels above say what went wrong.
        </p>
      )}
    </DashboardPanel>
  )
}

/** Documents that have been started and never issued. Each row opens its own editor. */
function Drafts({
  panel,
  navigate,
}: {
  panel: Panel<readonly DocumentSummary[]>
  navigate: ScreenContext['navigate']
}): JSX.Element {
  const page = panel.state === 'ready' ? pageOf(panel.data, ATTENTION_LIMIT) : null

  return (
    <DashboardPanel title="Drafts not yet issued">
      {panel.state === 'loading' && <p className="prose prose--muted">Reading the registers…</p>}
      {panel.state === 'failed' && <FailureNotice error={panel.error} context="ledger" />}
      {page !== null &&
        (page.rows.length === 0 ? (
          <Notice tone="info" title="No drafts are waiting">
            <p>
              Nothing has been started and left. A draft is in nobody&rsquo;s books until it is
              issued, so this is the list worth being empty.
            </p>
          </Notice>
        ) : (
          <>
            <ActivityTable rows={documentActivity(page.rows)} navigate={navigate} />
            {page.hasMore && (
              <p className="prose prose--muted">
                The {ATTENTION_LIMIT} most recent are shown. Each register in the rail lists the
                rest of its own kind.
              </p>
            )}
          </>
        ))}
    </DashboardPanel>
  )
}

// ---- What has happened lately -----------------------------------------------

/**
 * The last few documents and vouchers, as one sequence.
 *
 * TWO READS AND ONE TABLE. Either can fail on its own, and the panel then shows what
 * failed beside the half that answered rather than dropping both — a register that is
 * unreachable does not make the receipts less recent.
 */
function Activity({
  documents,
  receipts,
  navigate,
}: {
  documents: Panel<readonly DocumentSummary[]>
  receipts: Panel<readonly ReceiptSummary[]>
  navigate: ScreenContext['navigate']
}): JSX.Element {
  const rows = recentActivity(
    documents.state === 'ready' ? documents.data : [],
    receipts.state === 'ready' ? receipts.data : [],
    ACTIVITY_LIMIT,
  )
  const isReading = documents.state === 'loading' || receipts.state === 'loading'

  return (
    <DashboardPanel title="Lately">
      {documents.state === 'failed' && <FailureNotice error={documents.error} context="ledger" />}
      {receipts.state === 'failed' && <FailureNotice error={receipts.error} context="ledger" />}

      {rows.length > 0 ? (
        <>
          <ActivityTable rows={rows} navigate={navigate} />
          <PanelLink
            label="Open the day book"
            screenId={LINKED_SCREENS.dayBook}
            navigate={navigate}
          />
        </>
      ) : isReading ? (
        <p className="prose prose--muted">Reading the registers…</p>
      ) : (
        <p className="prose prose--muted">Nothing could be listed. The failures above say why.</p>
      )}
    </DashboardPanel>
  )
}

/** Documents and vouchers in the columns they share. Every number opens its own editor. */
function ActivityTable({
  rows,
  navigate,
}: {
  rows: readonly ActivityRow[]
  navigate: ScreenContext['navigate']
}): JSX.Element {
  const format = useNumberFormat()

  return (
    <table className="ledger-table ledger-table--figures report-table">
      <thead>
        <tr>
          <th scope="col">Number</th>
          <th scope="col">What it is</th>
          <th scope="col">Date</th>
          <th scope="col">Who</th>
          <th scope="col">Status</th>
          <th scope="col" className="ledger-table__figure">
            Total
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const target = activityTarget(row)
          return (
            <tr key={row.key} className="ledger-table__row">
              <td className="ledger-table__code">
                {target === null ? (
                  row.numberLabel
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate(makeRoute('workspace', target.screenId, target.params))}
                  >
                    {row.numberLabel}
                  </Button>
                )}
              </td>
              <td>{activityLabel(row)}</td>
              <td className="ledger-table__code">{row.date}</td>
              <td>{row.partyName}</td>
              <td>
                <Badge tone={activityTone(row)} isStruck={activityIsStruck(row)}>
                  {activityStatusLabel(row)}
                </Badge>
              </td>
              <td className="ledger-table__figure">{formatAmount(row.amount, format)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ---- A company with nothing in it yet ---------------------------------------

/**
 * What to do first, on books that hold nothing.
 *
 * SHOWN INSTEAD OF THE FIGURES, NOT BESIDE THEM. Six zeroes and four empty tables is an
 * accurate description of a company file made this morning and a useless first
 * impression of one. It says the empty state is the right one, and the main button is the
 * next thing to do.
 *
 * THE ORDER IS THE BOOKS', NOT THE DESIGN'S. The design leads with "Raise the first
 * invoice", and on day one that screen cannot work: a document needs the business details
 * and a party first (`firstRunSteps`). So the button offers the first step not yet done,
 * and the cards below say which are done — a step whose read failed says it does not know
 * rather than guessing. Each card names where its screen lives, from the registry.
 */
function FirstRun({
  profile,
  parties,
  documents,
  navigate,
}: {
  profile: Panel<CompanyProfile | null>
  parties: Panel<readonly PartySummary[]>
  documents: Panel<readonly DocumentSummary[]>
  navigate: ScreenContext['navigate']
}): JSX.Element {
  const screens = useScreens()
  const steps = firstRunSteps({
    profile: stepState(profile, (value) => value !== null),
    parties: stepState(parties, (value) => value.length > 0),
    documents: stepState(documents, (value) => value.length > 0),
  })
  const next = nextFirstRunStep(steps)

  return (
    <DashboardPanel title="Start here">
      <EmptyState
        title="The books are empty, which is the correct state on day one"
        titleAs="p"
        action={
          next === null ? undefined : (
            <Button
              variant="primary"
              iconEnd="arrow-right"
              onClick={() => navigate(makeRoute('workspace', next.screenId))}
            >
              {next.title}
            </Button>
          )
        }
      >
        <p>
          A chart of accounts is already in place. Fill in the business details, add a customer and
          raise the first invoice, in that order, and the trial balance and the ledger fill
          themselves in from there.
        </p>
      </EmptyState>

      <ol className="next-steps">
        {steps.map((step) => (
          <li key={step.id} className="next-step">
            <p className="next-step__title">
              {step.title} <Badge tone={stepTone(step.state)}>{stepLabel(step.state)}</Badge>
            </p>
            <p className="next-step__body">{step.body}</p>
            <div className="next-step__action">
              <Button
                variant="ghost"
                size="sm"
                iconEnd="arrow-right"
                onClick={() => navigate(makeRoute('workspace', step.screenId))}
              >
                {describeLocation(screens, 'workspace', step.screenId) ?? step.actionLabel}
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </DashboardPanel>
  )
}

interface FactProps {
  label: string
  value: string
  isPath?: boolean
  badge?: JSX.Element | null
}

function Fact({ label, value, isPath = false, badge }: FactProps): JSX.Element {
  return (
    <div className="fact">
      <span className="fact__label caps-label">{label}</span>
      <span className={`fact__value ${isPath ? 'fact__value--path selectable truncate' : ''}`}>
        {value}
        {badge}
      </span>
    </div>
  )
}

// ---- Changing the passphrase ----------------------------------------------

interface ChangePassphraseDialogProps {
  isOpen: boolean
  onClose: () => void
}

/**
 * Re-wraps the key under a new passphrase.
 *
 * The database is not re-encrypted and the open session stays valid — main only rewrites
 * one slot in the vault. Every recovery code still works afterwards, which is worth
 * saying on screen: users expect changing a password to invalidate everything.
 */
function ChangePassphraseDialog({ isOpen, onClose }: ChangePassphraseDialogProps): JSX.Element {
  const { show } = useToasts()
  const [currentPassphrase, setCurrent] = useState('')
  const [newPassphrase, setNew] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [hasTouchedConfirmation, setTouchedConfirmation] = useState(false)
  const [strength, setStrength] = useState<PassphraseStrength | null>(null)
  const [isBusy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  const form = validateChangePassphrase(
    { currentPassphrase, newPassphrase, confirmation },
    hasTouchedConfirmation,
  )

  const checkStrength = useCallback(async (value: string) => {
    if (value === '') {
      setStrength(null)
      return
    }
    const result = await callApi((api) => api.companies.checkPassphrase(value))
    if (result.ok) setStrength(result.data)
  }, [])

  const submit = useCallback(async () => {
    if (!form.canSubmit || isBusy) return
    setBusy(true)
    setError(null)
    const result = await callApi((api) =>
      api.companies.changePassphrase({ currentPassphrase, newPassphrase }),
    )
    setBusy(false)

    if (!result.ok) {
      setError(result.error)
      return
    }

    setCurrent('')
    setNew('')
    setConfirmation('')
    onClose()
    show({
      tone: 'success',
      title: 'Passphrase changed',
      body: 'Use the new one from now on. Your recovery codes are unaffected — they open this company regardless of which passphrase is set.',
    })
  }, [form.canSubmit, isBusy, currentPassphrase, newPassphrase, onClose, show])

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="Change the passphrase"
      description="This re-wraps the key. The books are not re-encrypted, nothing is re-saved, and every recovery code keeps working."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={!form.canSubmit}
            isBusy={isBusy}
          >
            Change passphrase
          </Button>
        </>
      }
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="change-passphrase" />}

        <PassphraseField
          label="Current passphrase"
          value={currentPassphrase}
          onChange={setCurrent}
          error={form.errors.currentPassphrase}
          isDisabled={isBusy}
        />

        <PassphraseField
          label="New passphrase"
          value={newPassphrase}
          onChange={(value) => {
            setNew(value)
            void checkStrength(value)
          }}
          error={form.errors.newPassphrase}
          isDisabled={isBusy}
        >
          <StrengthMeter strength={strength} passphrase={newPassphrase} />
        </PassphraseField>

        <PassphraseField
          label="New passphrase again"
          value={confirmation}
          onChange={(value) => {
            setConfirmation(value)
            setTouchedConfirmation(true)
          }}
          error={form.errors.confirmation}
          isDisabled={isBusy}
          onSubmit={() => void submit()}
        />

        <Notice tone="warning" title="Still nobody's to reset">
          <p>{NO_RESET_WARNING}</p>
        </Notice>
      </div>
    </Dialog>
  )
}

registerScreens([
  {
    id: 'overview',
    title: 'Overview',
    area: 'workspace',
    nav: { label: 'Overview', icon: 'overview', group: 'accounts', order: 0 },
    render: (context: ScreenContext) => <Overview {...context} />,
  },
])
