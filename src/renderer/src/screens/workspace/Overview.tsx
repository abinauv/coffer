/*
 * The workspace landing screen — the first thing anybody sees after unlocking their books.
 *
 * FOUR FIGURES, THEN THE TWO LISTS THAT MAKE TOMORROW'S WORK (Screens §02). What is owed
 * to the business, what it owes, what is in the bank, and how the month is going; then who
 * has owed the longest, and the handful of things that need somebody's attention. Nothing
 * here is a chart for the sake of one.
 *
 * NOT ONE FIGURE ON THIS PAGE IS WORKED OUT HERE (CONVENTIONS §1.7). "Owed to you" is the
 * sales aged report's own total, "You owe" the purchase one's, and "Cash and bank" and
 * "This month, net" come from `reports.overviewFigures`, which exists because no other
 * channel answered them. Counting invoices and naming days is not money, and is all
 * `overview-view.ts` does.
 *
 * SEVEN INDEPENDENT READS, AND NO ONE OF THEM CAN TAKE THE SCREEN DOWN. Each holds its own
 * `Panel<T>` — loading, ready, or failed with the reason — so an ageing report that cannot
 * resolve its control account leaves the cash figure and the attention list where they
 * were, and says what went wrong in its own box.
 *
 * AN EMPTY COMPANY READS AS A BEGINNING. A file made this morning has no documents and no
 * receipts, and four noughts over two empty lists is the least useful thing to show
 * somebody on their first day. `isNewCompany` swaps them for the three things that have to
 * happen first, each marked with whether it is already done.
 *
 * WHAT MOVED OFF THIS SCREEN IN 5b is the company's own housekeeping. The file path is in
 * the status bar on every screen, Back up now is in the rail's footer, and changing the
 * passphrase and closing the company are in the palette. They were here because this was
 * the only screen there was; it is the business's screen now.
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { Badge, Button } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { makeRoute } from '@renderer/lib/routing'
import { describeLocation, registerScreens, type ScreenContext } from '@renderer/lib/screens'
import { todayISO } from '@renderer/lib/today'
import { useRegisterCommands } from '@renderer/store/commands'
import { useCompany } from '@renderer/store/company'
import { useCurrentFinancialYear } from '@renderer/store/financial-year'
import { useNumberFormat } from '@renderer/store/regime'
import { useScreens } from '@renderer/store/screens'
import type {
  AgedReport,
  AppError,
  CompanyProfile,
  DocumentListRow,
  OverviewFigures,
  PartySummary,
} from '@shared/dto'
import { EmptyState } from '../components/EmptyState'
import { FailureNotice } from '../components/FailureNotice'
import { ScreenFrame } from '../components/ScreenFrame'
import { agedScreenId, agedTitle } from '../lib/ageing-view'
import { editorScreenId as documentEditorScreenId } from '../lib/document-view'
import { formatAmount, isNegativeAmount } from '../lib/ledger-format'
import {
  ageLabel,
  ageTone,
  asAtLine,
  attentionItems,
  cashNote,
  firstRunSteps,
  isAttentionComplete,
  isNewCompany,
  monthNote,
  nextFirstRunStep,
  oldestOwed,
  outstandingNote,
  panelFrom,
  stepLabel,
  stepState,
  stepTone,
  type AttentionSources,
  type Panel,
} from '../lib/overview-view'
import { editorScreenId as receiptEditorScreenId } from '../lib/receipt-view'

/** Every panel starts here. Not `null`, which would read as "nothing to show". */
const LOADING = { state: 'loading' } as const

export function Overview({ navigate }: ScreenContext): JSX.Element {
  const { company, recoveryCodesRemaining } = useCompany()
  const year = useCurrentFinancialYear(company?.id ?? null)
  const [asAtDate, setAsAtDate] = useState(todayISO)

  const [receivables, setReceivables] = useState<Panel<AgedReport>>(LOADING)
  const [payables, setPayables] = useState<Panel<AgedReport>>(LOADING)
  const [figures, setFigures] = useState<Panel<OverviewFigures>>(LOADING)
  const [documentCount, setDocumentCount] = useState<Panel<number>>(LOADING)
  const [receiptCount, setReceiptCount] = useState<Panel<number>>(LOADING)
  const [draftCount, setDraftCount] = useState<Panel<number>>(LOADING)
  const [newestDraft, setNewestDraft] = useState<Panel<readonly DocumentListRow[]>>(LOADING)
  const [profile, setProfile] = useState<Panel<CompanyProfile | null>>(LOADING)
  const [parties, setParties] = useState<Panel<readonly PartySummary[]>>(LOADING)

  /*
   * EVERY READ AT ONCE, AND EACH LANDS ON ITS OWN PANEL. One combined result would mean a
   * single failure emptying every panel. The date is taken once so both ageing reports and
   * the cash figure are as at the same day — asking three times could straddle midnight.
   */
  const load = useCallback(async () => {
    const date = todayISO()
    setAsAtDate(date)
    const [sales, purchases, overview, documents, receipts, drafts, newest] = await Promise.all([
      callApi((api) => api.reports.aged({ side: 'sales', asAtDate: date })),
      callApi((api) => api.reports.aged({ side: 'purchase', asAtDate: date })),
      callApi((api) => api.reports.overviewFigures({ asAtDate: date })),
      callApi((api) => api.documents.count()),
      callApi((api) => api.receipts.count()),
      callApi((api) => api.documents.count({ status: 'draft' })),
      callApi((api) => api.documents.list({ status: 'draft', limit: 1 })),
    ])
    setReceivables(panelFrom(sales))
    setPayables(panelFrom(purchases))
    setFigures(panelFrom(overview))
    setDocumentCount(panelFrom(documents))
    setReceiptCount(panelFrom(receipts))
    setDraftCount(panelFrom(drafts))
    setNewestDraft(panelFrom(newest))
  }, [])

  /*
   * NOTHING IS READ UNTIL A COMPANY IS OPEN. Every channel above needs one and answers
   * `NO_COMPANY_OPEN` without it, so firing them in the frame between closing a company
   * and the shell returning to the picker would fill the page with failures nobody is meant
   * to see.
   */
  const companyId = company?.id ?? null

  useEffect(() => {
    if (companyId !== null) void load()
  }, [companyId, load])

  const isNew = isNewCompany(documentCount, receiptCount)

  /*
   * THE CHECKLIST'S TWO READS HAPPEN ONLY WHEN THE BOOKS TURN OUT TO BE EMPTY. `parties.list`
   * has no limit and answers with every party there is, so asking on every visit would pull
   * the whole party master to say nothing.
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

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: 'company.refresh-overview',
          title: 'Refresh the overview',
          section: 'Accounts',
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

  const open = (screenId: string, params: Record<string, string> = {}): void =>
    navigate(makeRoute('workspace', screenId, params))

  return (
    <ScreenFrame
      isInset
      width="list"
      title="Overview"
      lede={asAtLine(asAtDate, year)}
      actions={
        isNew ? undefined : (
          <>
            <Button onClick={() => open(receiptEditorScreenId('receipt'))}>Record receipt</Button>
            <Button
              variant="primary"
              icon="plus"
              onClick={() => open(documentEditorScreenId('sales-invoice'))}
            >
              New sales invoice
            </Button>
          </>
        )
      }
    >
      {isNew ? (
        <FirstRun
          profile={profile}
          parties={parties}
          documents={documentCount}
          navigate={navigate}
        />
      ) : (
        <div className="stack">
          <Failures panels={[receivables, payables, figures, draftCount]} />

          <dl className="figures">
            <Figure
              label="Owed to you"
              panel={receivables}
              value={(report) => report.totals.total}
              note={(report) => outstandingNote('sales', report)}
            />
            <Figure
              label="You owe"
              panel={payables}
              value={(report) => report.totals.total}
              note={(report) => outstandingNote('purchase', report)}
            />
            <Figure
              label="Cash and bank"
              panel={figures}
              value={(data) => data.cashAndBank.total}
              note={(data) => cashNote(data.cashAndBank.accounts.length)}
            />
            <Figure
              label="This month, net"
              panel={figures}
              value={(data) => data.monthToDate.netProfit}
              note={(data) => monthNote(data.monthToDate.fromDate, data.monthToDate.toDate)}
            />
          </dl>

          <div className="overview-columns">
            <Owed panel={receivables} onOpenReport={() => open(agedScreenId('sales'))} />
            <Attention
              sources={{
                receivables,
                payables,
                draftCount,
                newestDraft,
                recoveryCodesRemaining,
              }}
              onOpen={open}
            />
          </div>
        </div>
      )}
    </ScreenFrame>
  )
}

// ---- The frame each panel sits in -------------------------------------------

/**
 * A titled card of the dashboard.
 *
 * A landmark with its heading as the accessible name, rather than a bare `div`: without
 * regions a screen reader reads two unrelated lists as one run of text, and it is what lets
 * a test scope an assertion to the panel it is about.
 */
function DashboardPanel({
  title,
  aside,
  children,
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
}): JSX.Element {
  const headingId = useId()
  return (
    <section className="panel" aria-labelledby={headingId}>
      <header className="panel__head">
        <h2 id={headingId} className="panel__title">
          {title}
        </h2>
        {aside}
      </header>
      {children}
    </section>
  )
}

/** Each read that failed, said once, above the figures it would have filled. */
function Failures({ panels }: { panels: ReadonlyArray<Panel<unknown>> }): JSX.Element {
  const errors = panels.flatMap((panel) => (panel.state === 'failed' ? [panel.error] : []))
  /* The same refusal from four channels — a company closed under them — is one message. */
  const distinct = errors.filter(
    (error, index) =>
      errors.findIndex((other) => other.code === error.code && other.message === error.message) ===
      index,
  )
  return (
    <>
      {distinct.map((error: AppError) => (
        <FailureNotice key={`${error.code}:${error.message}`} error={error} context="ledger" />
      ))}
    </>
  )
}

// ---- The four figures ---------------------------------------------------------

/**
 * One figure, as main sent it, with the line that says what it is made of.
 *
 * A term and its definitions, so the label and the figure are read together. The figure
 * keeps its sign and takes the negative ink below nought (design.md §6): a month that lost
 * money says so in the figure, not only in a colour.
 */
function Figure<T>({
  label,
  panel,
  value,
  note,
}: {
  label: string
  panel: Panel<T>
  value: (data: T) => string
  note: (data: T) => string
}): JSX.Element {
  const format = useNumberFormat()

  return (
    <div className="figure-card">
      <dt className="figure-card__label">{label}</dt>
      {panel.state === 'ready' ? (
        <>
          <dd
            className="figure-card__value"
            data-tone={isNegativeAmount(value(panel.data)) ? 'negative' : undefined}
          >
            {formatAmount(value(panel.data), format)}
          </dd>
          <dd className="figure-card__note">{note(panel.data)}</dd>
        </>
      ) : panel.state === 'loading' ? (
        <dd className="figure-card__value" aria-busy="true">
          <span className="skeleton__bar figure-card__skeleton" aria-hidden="true" />
          <span className="visually-hidden">Reading</span>
        </dd>
      ) : (
        <>
          <dd className="figure-card__value">—</dd>
          <dd className="figure-card__note">Could not be read</dd>
        </>
      )}
    </div>
  )
}

// ---- Owed to you, oldest first ------------------------------------------------

/*
 * Who has owed the longest. The amount is each party's own total from the report; the age
 * is their oldest charge's. A party with nothing owed is not on it.
 */
function Owed({
  panel,
  onOpenReport,
}: {
  panel: Panel<AgedReport>
  onOpenReport: () => void
}): JSX.Element {
  const format = useNumberFormat()
  const rows = panel.state === 'ready' ? oldestOwed(panel.data) : []

  return (
    <DashboardPanel
      title="Owed to you, oldest first"
      aside={
        <Button variant="ghost" size="sm" iconEnd="arrow-right" onClick={onOpenReport}>
          {agedTitle('sales')}
        </Button>
      }
    >
      {panel.state === 'loading' && <p className="panel__empty">Reading the aged receivables…</p>}
      {panel.state === 'failed' && (
        <p className="panel__empty">The aged receivables could not be read.</p>
      )}
      {panel.state === 'ready' &&
        (rows.length === 0 ? (
          <p className="panel__empty">Nobody owes you anything today.</p>
        ) : (
          <table className="panel-table">
            <thead className="visually-hidden">
              <tr>
                <th scope="col">Customer</th>
                <th scope="col">How late</th>
                <th scope="col">Owed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td className="panel-table__name">{row.partyName}</td>
                  <td>
                    <Badge tone={ageTone(row.daysOverdue)}>{ageLabel(row.daysOverdue)}</Badge>
                  </td>
                  <td className="panel-table__figure">{formatAmount(row.total, format)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </DashboardPanel>
  )
}

// ---- Needs your attention -------------------------------------------------------

function Attention({
  sources,
  onOpen,
}: {
  sources: AttentionSources
  onOpen: (screenId: string, params?: Record<string, string>) => void
}): JSX.Element {
  const items = attentionItems(sources)
  const isComplete = isAttentionComplete(sources)

  return (
    <DashboardPanel
      title="Needs your attention"
      aside={
        items.length > 0 ? (
          <span className="panel__count">
            {items.length} {items.length === 1 ? 'item' : 'items'}
          </span>
        ) : undefined
      }
    >
      {items.length > 0 ? (
        <ul className="attention">
          {items.map((item) => (
            <li key={item.id} className="attention__item" data-tone={item.tone}>
              <span className="attention__dot" aria-hidden="true" />
              <div className="attention__text">
                <p className="attention__title">{item.title}</p>
                <p className="attention__note">{item.note}</p>
              </div>
              {item.target !== undefined && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const target = item.target
                    if (target !== undefined) onOpen(target.screenId, { ...target.params })
                  }}
                >
                  {item.actionLabel}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : isComplete ? (
        <p className="panel__empty">
          Nothing needs your attention. Nothing is past its due date and no draft is waiting.
        </p>
      ) : sources.receivables.state === 'loading' || sources.draftCount.state === 'loading' ? (
        <p className="panel__empty">Reading the books…</p>
      ) : (
        <p className="panel__empty">
          Part of the books could not be read, so nothing can be said about what needs attention.
        </p>
      )}
    </DashboardPanel>
  )
}

// ---- A company with nothing in it yet ---------------------------------------

/**
 * What to do first, on books that hold nothing.
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
  documents: Panel<number>
  navigate: ScreenContext['navigate']
}): JSX.Element {
  const screens = useScreens()
  const headingId = useId()
  const steps = firstRunSteps({
    profile: stepState(profile, (value) => value !== null),
    parties: stepState(parties, (value) => value.length > 0),
    documents: stepState(documents, (value) => value > 0),
  })
  const next = nextFirstRunStep(steps)

  return (
    <section className="stack" aria-labelledby={headingId}>
      <h2 id={headingId} className="caps-label">
        Start here
      </h2>
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
    </section>
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
