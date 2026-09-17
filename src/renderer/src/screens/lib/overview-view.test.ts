/*
 * What the Overview decides before it draws anything.
 *
 * EVERY FIXTURE DATE IS IN 2019, which the real clock cannot be in. A fixture whose value
 * coincides with the real world tests nothing about where the value came from.
 *
 * EVERY ORDERED FIXTURE DISAGREES WITH ITS EXPECTED OUTPUT. The worst overdue item is never
 * the one at the top of the first report, and the party owed longest is never the largest
 * debt. An input already in the answer's order cannot tell a sort from a slice.
 */

import { describe, expect, it } from 'vitest'
import type {
  AgedItem,
  AgedPartyRow,
  AgedReport,
  CompanySummary,
  DocumentListRow,
  Result,
} from '@shared/dto'
import {
  ageLabel,
  ageTone,
  asAtLine,
  attentionItems,
  ATTENTION_TONES,
  BADGE_TONES,
  cashNote,
  firstRunSteps,
  isAttentionComplete,
  isNewCompany,
  monthNote,
  mostOverdue,
  nextFirstRunStep,
  oldestOwed,
  outstandingNote,
  overdueRowsIn,
  panelFrom,
  stepLabel,
  stepState,
  stepTone,
  STEP_STATES,
  type AttentionSources,
  type Panel,
} from './overview-view'

// ---- Fixtures ---------------------------------------------------------------

const BUCKETS = [
  { label: 'Not yet due', fromDays: null, toDays: 0 },
  { label: '1-30 days', fromDays: 1, toDays: 30 },
  { label: 'Over 30 days', fromDays: 31, toDays: null },
]

function item(over: Partial<AgedItem> = {}): AgedItem {
  return {
    source: 'document',
    sourceId: 'document-1',
    kind: 'sales-invoice',
    number: 'INV/2019-20/0001',
    date: '2019-04-02',
    dueDate: '2019-05-02',
    daysOverdue: 30,
    bucket: 1,
    amount: '1000.00',
    ...over,
  }
}

function party(over: Partial<AgedPartyRow> = {}): AgedPartyRow {
  return {
    partyId: 'party-1',
    partyName: 'Sunrise Components',
    buckets: ['0.00', '1000.00', '0.00'],
    onAccount: '0.00',
    total: '1000.00',
    items: [item()],
    ...over,
  }
}

function report(over: Partial<AgedReport> = {}): AgedReport {
  return {
    side: 'sales',
    asAtDate: '2019-07-31',
    accountId: 'account-1',
    accountCode: '1300',
    accountName: 'Accounts Receivable',
    buckets: BUCKETS,
    parties: [party()],
    totals: {
      buckets: ['0.00', '1000.00', '0.00'],
      onAccount: '0.00',
      overdue: '1000.00',
      total: '1000.00',
    },
    controlBalance: '1000.00',
    ties: true,
    ...over,
  }
}

function draft(over: Partial<DocumentListRow> = {}): DocumentListRow {
  return {
    id: 'draft-1',
    kind: 'credit-note',
    status: 'draft',
    number: null,
    date: '2019-07-20',
    dueDate: null,
    partyId: 'party-1',
    partyName: 'Sunrise Components',
    grandTotal: '1180.00',
    settlement: null,
    ...over,
  }
}

const ready = <T>(data: T): Panel<T> => ({ state: 'ready', data })

/** A day count back from now, as a timestamp. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

/** The open company, with its last backup at a time the test chooses. */
function companyBackedUp(at: string | null): CompanySummary {
  return {
    id: 'acme',
    displayName: 'Acme Traders',
    filePath: '/books/acme.coffer',
    vaultPath: '/books/acme.coffer.vault',
    lastOpenedAt: null,
    createdAt: new Date().toISOString(),
    availability: 'ok',
    lastBackup: at === null ? null : { at, path: '/backups/acme.zip', sizeBytes: 2048 },
    remindsAboutBackups: true,
  }
}
const failure: Panel<never> = {
  state: 'failed',
  error: { code: 'NO_COMPANY_OPEN', message: 'No company is open.' },
}
const loadingPanel: Panel<never> = { state: 'loading' }

/** Books with nothing to say: every read answered, nothing late, no drafts, codes in hand. */
function quiet(over: Partial<AttentionSources> = {}): AttentionSources {
  const nothingOwed = report({ parties: [], totals: { ...report().totals, total: '0.00' } })
  return {
    receivables: ready(nothingOwed),
    payables: ready({ ...nothingOwed, side: 'purchase' }),
    draftCount: ready(0),
    newestDraft: ready([]),
    recoveryCodesRemaining: 5,
    /* Backed up this morning, so the backup line has nothing to say either. */
    company: companyBackedUp(new Date().toISOString()),
    taxReturnsDue: ready([]),
    ...over,
  }
}

// ---- A read, in the state it is in ------------------------------------------

describe('panelFrom', () => {
  it('carries the data through when the read succeeded', () => {
    const result: Result<number> = { ok: true, data: 7 }
    expect(panelFrom(result)).toEqual({ state: 'ready', data: 7 })
  })

  it('keeps the error rather than collapsing a failure into an empty answer', () => {
    const error = { code: 'ROLE_UNMAPPED', message: 'No account is mapped to receivable.' }
    const result: Result<number> = { ok: false, error }
    expect(panelFrom(result)).toEqual({ state: 'failed', error })
  })
})

// ---- Is this company started at all? ----------------------------------------

/*
 * Each input is the one that ONLY its own condition excludes. The dangerous direction is a
 * failed count read as nought: it greets a business of ten years with "add your first
 * customer".
 */
describe('isNewCompany', () => {
  it('is true when both counts answered nought', () => {
    expect(isNewCompany(ready(0), ready(0))).toBe(true)
  })

  it('is false when there is a document', () => {
    expect(isNewCompany(ready(1), ready(0))).toBe(false)
  })

  it('is false when there is a receipt and no document', () => {
    /* Money on account before anything was invoiced. */
    expect(isNewCompany(ready(0), ready(3))).toBe(false)
  })

  it('is false when either count failed, however empty the other one is', () => {
    expect(isNewCompany(failure, ready(0))).toBe(false)
    expect(isNewCompany(ready(0), failure)).toBe(false)
  })

  it('is false while either count is still in flight', () => {
    expect(isNewCompany(loadingPanel, ready(0))).toBe(false)
    expect(isNewCompany(ready(0), loadingPanel)).toBe(false)
  })
})

// ---- What to do first -------------------------------------------------------

describe('stepState', () => {
  it("is done when the panel's data satisfies the test", () => {
    expect(stepState(ready(['a']), (value) => value.length > 0)).toBe('done')
  })

  it('is to do when it answered and does not', () => {
    expect(stepState(ready([]), (value) => value.length > 0)).toBe('todo')
  })

  it('is unknown when the read failed, rather than claiming the step is undone', () => {
    expect(stepState(failure, () => true)).toBe('unknown')
  })

  it('is unknown while the read is in flight', () => {
    expect(stepState(loadingPanel, () => true)).toBe('unknown')
  })
})

describe('the step badge', () => {
  it.each(STEP_STATES)('gives %s a tone the Badge atom styles', (state) => {
    expect(BADGE_TONES).toContain(stepTone(state))
  })

  it('says a different word for each state', () => {
    const labels = STEP_STATES.map(stepLabel)
    expect(new Set(labels).size).toBe(STEP_STATES.length)
  })
})

describe('firstRunSteps', () => {
  const steps = firstRunSteps({ profile: 'done', parties: 'todo', documents: 'unknown' })

  it('puts the business details before the party and the party before the invoice', () => {
    expect(steps.map((step) => step.id)).toEqual(['profile', 'parties', 'first-document'])
  })

  it('gives each step the state of its own read', () => {
    expect(steps.map((step) => step.state)).toEqual(['done', 'todo', 'unknown'])
  })

  it('names the screen each step goes to, the last being the editor', () => {
    expect(steps.map((step) => step.screenId)).toEqual([
      'company-profile',
      'customers',
      'sales-invoice',
    ])
  })

  it('offers the first step not yet known to be done', () => {
    expect(nextFirstRunStep(steps)?.id).toBe('parties')
    expect(
      nextFirstRunStep(firstRunSteps({ profile: 'unknown', parties: 'done', documents: 'todo' }))
        ?.id,
    ).toBe('profile')
    expect(
      nextFirstRunStep(firstRunSteps({ profile: 'done', parties: 'done', documents: 'done' })),
    ).toBeNull()
  })
})

// ---- What is late -----------------------------------------------------------

describe('overdueRowsIn', () => {
  it('keeps an item that is past its due date', () => {
    const rows = overdueRowsIn('sales', report())
    expect(rows.map((row) => row.item.number)).toEqual(['INV/2019-20/0001'])
  })

  it("drops money standing to the party's credit, however old it is", () => {
    const rows = overdueRowsIn(
      'sales',
      report({
        parties: [party({ items: [item({ bucket: null, daysOverdue: 200, amount: '-500.00' })] })],
      }),
    )
    expect(rows).toEqual([])
  })

  it('drops an item that falls due today', () => {
    /* Nought is not late. An invoice on thirty-day terms is not in default on day thirty. */
    const rows = overdueRowsIn(
      'sales',
      report({ parties: [party({ items: [item({ daysOverdue: 0 })] })] }),
    )
    expect(rows).toEqual([])
  })

  it('keys a row by the side it came from, so both sides can be listed together', () => {
    const sales = overdueRowsIn('sales', report())
    const purchase = overdueRowsIn('purchase', report())
    expect(sales[0]?.key).not.toBe(purchase[0]?.key)
  })
})

describe('mostOverdue', () => {
  const rows = overdueRowsIn(
    'sales',
    report({
      parties: [
        party({
          items: [
            item({ sourceId: 'a', number: 'A', daysOverdue: 5 }),
            item({ sourceId: 'b', number: 'B', daysOverdue: 90 }),
            item({ sourceId: 'c', number: 'C', daysOverdue: 40 }),
          ],
        }),
      ],
    }),
  )

  it('puts the latest first, and leaves the list it was given alone', () => {
    expect(mostOverdue(rows).map((row) => row.item.number)).toEqual(['B', 'C', 'A'])
    expect(rows.map((row) => row.item.number)).toEqual(['A', 'B', 'C'])
  })
})

// ---- The four figures ---------------------------------------------------------

describe('the lines under the figures', () => {
  it('counts what is unpaid and what is late, and not what stands to a credit', () => {
    const books = report({
      parties: [
        party({
          items: [
            item({ sourceId: 'a', daysOverdue: 40 }),
            item({ sourceId: 'b', daysOverdue: -3, bucket: 0 }),
            item({ sourceId: 'c', bucket: null, daysOverdue: 100, amount: '-200.00' }),
          ],
        }),
      ],
    })
    expect(outstandingNote('sales', books)).toBe('2 unpaid · 1 overdue')
  })

  it('says nothing is outstanding rather than "0 unpaid"', () => {
    expect(outstandingNote('purchase', report({ parties: [] }))).toBe('Nothing outstanding')
  })

  it('says how many accounts cash and bank is made of, and when there are none', () => {
    expect(cashNote(3)).toBe('across 3 accounts')
    expect(cashNote(1)).toBe('across 1 account')
    expect(cashNote(0)).toBe('No account fills the cash or bank role')
  })

  it('names the days the month so far covers', () => {
    expect(monthNote('2019-07-01', '2019-07-13')).toBe('1–13 Jul · income less expenses')
  })

  it('writes the date as the app writes dates, and the year once it is known', () => {
    expect(asAtLine('2019-07-13', '2019-20')).toBe('As at 13 Jul 2019 · financial year 2019-20')
    expect(asAtLine('2019-07-13', null)).toBe('As at 13 Jul 2019')
  })
})

// ---- Owed to you, oldest first ------------------------------------------------

describe('oldestOwed', () => {
  const books = report({
    parties: [
      /* The largest debt, and not the oldest: the report's order, which this list reverses. */
      party({
        partyId: 'big',
        partyName: 'Big and recent',
        total: '90000.00',
        items: [item({ daysOverdue: 3 })],
      }),
      party({
        partyId: 'old',
        partyName: 'Small and old',
        total: '400.00',
        items: [item({ daysOverdue: 12 }), item({ sourceId: 'x', daysOverdue: 61, bucket: 2 })],
      }),
      party({
        partyId: 'credit',
        partyName: 'In credit',
        total: '-500.00',
        items: [item({ bucket: null, daysOverdue: 300, amount: '-500.00' })],
      }),
      party({
        partyId: 'early',
        partyName: 'Not due yet',
        total: '700.00',
        items: [item({ daysOverdue: -10, bucket: 0 })],
      }),
    ],
  })

  it('puts the party whose oldest charge is latest first, and leaves out a party in credit', () => {
    expect(oldestOwed(books).map((row) => row.partyName)).toEqual([
      'Small and old',
      'Big and recent',
      'Not due yet',
    ])
  })

  it("takes each party's own total and the age of their oldest charge", () => {
    expect(oldestOwed(books)[0]).toMatchObject({ total: '400.00', daysOverdue: 61 })
  })

  it('keeps only as many as the list draws', () => {
    expect(oldestOwed(books, 2)).toHaveLength(2)
  })

  it('does not count a credit that is older than the charges', () => {
    const mixed = report({
      parties: [
        party({
          total: '600.00',
          items: [
            item({ bucket: null, daysOverdue: 400, amount: '-400.00' }),
            item({ sourceId: 'y', daysOverdue: 8 }),
          ],
        }),
      ],
    })
    expect(oldestOwed(mixed)[0]?.daysOverdue).toBe(8)
  })
})

describe('the age badge', () => {
  it('says how late, or that it is not due', () => {
    expect(ageLabel(61)).toBe('61 days overdue')
    expect(ageLabel(1)).toBe('1 day overdue')
    expect(ageLabel(0)).toBe('Not yet due')
    expect(ageLabel(-4)).toBe('Not yet due')
  })

  it('turns negative past thirty days, where the first bucket ends', () => {
    expect(ageTone(31)).toBe('negative')
    expect(ageTone(30)).toBe('warning')
    expect(ageTone(1)).toBe('warning')
    expect(ageTone(0)).toBe('neutral')
  })

  it('only ever answers a tone the Badge atom styles', () => {
    for (const days of [-1, 0, 1, 30, 31, 365]) expect(BADGE_TONES).toContain(ageTone(days))
  })
})

// ---- Needs your attention -------------------------------------------------------

describe('attentionItems', () => {
  it('has nothing to say about quiet books, and says the list is complete', () => {
    expect(attentionItems(quiet())).toEqual([])
    expect(isAttentionComplete(quiet())).toBe(true)
  })

  it('does not claim completeness while a read is missing', () => {
    expect(isAttentionComplete(quiet({ payables: failure }))).toBe(false)
    expect(isAttentionComplete(quiet({ draftCount: loadingPanel }))).toBe(false)
  })

  it('counts the late invoices and names the oldest', () => {
    const books = report({
      parties: [
        party({ partyName: 'Recent', items: [item({ sourceId: 'a', daysOverdue: 12 })] }),
        party({ partyName: 'Kaveri Polymers', items: [item({ sourceId: 'b', daysOverdue: 61 })] }),
      ],
    })

    const [late] = attentionItems(quiet({ receivables: ready(books) }))

    expect(late).toMatchObject({
      tone: 'negative',
      title: '2 invoices are past the due date',
      note: 'Oldest is 61 days · Kaveri Polymers',
      target: { screenId: 'aged-sales', params: {} },
    })
  })

  it('calls a late opening balance an amount, not an invoice', () => {
    const books = report({
      parties: [party({ items: [item({ source: 'journal', kind: null, daysOverdue: 9 })] })],
    })
    expect(attentionItems(quiet({ receivables: ready(books) }))[0]?.title).toBe(
      '1 amount is past the due date',
    )
  })

  it('calls the purchase side bills, a warning rather than an alarm', () => {
    const bills = report({
      side: 'purchase',
      parties: [party({ items: [item({ daysOverdue: 5 })] })],
    })
    expect(attentionItems(quiet({ payables: ready(bills) }))[0]).toMatchObject({
      tone: 'warning',
      title: '1 bill is past the due date',
      target: { screenId: 'aged-purchase', params: {} },
    })
  })

  it('says when a report does not agree with its account', () => {
    const broken = report({ parties: [], ties: false })
    expect(attentionItems(quiet({ receivables: ready(broken) }))[0]).toMatchObject({
      tone: 'negative',
      title: 'What customers owe does not agree with 1300 · Accounts Receivable',
    })
  })

  it('warns as the recovery codes run low, and alarms when none are left', () => {
    expect(attentionItems(quiet({ recoveryCodesRemaining: 2 }))[0]).toMatchObject({
      tone: 'warning',
      title: 'Only 2 recovery codes left',
    })
    expect(attentionItems(quiet({ recoveryCodesRemaining: 1 }))[0]?.title).toBe(
      'Only 1 recovery code left',
    )
    expect(attentionItems(quiet({ recoveryCodesRemaining: 0 }))[0]).toMatchObject({
      tone: 'negative',
      title: 'No recovery codes remain',
    })
    expect(attentionItems(quiet({ recoveryCodesRemaining: 3 }))).toEqual([])
  })

  /* The line used to say what was true and offer nothing, because nothing could be done
   * about it. Company → Recovery codes is where a new set is issued. */
  it('sends the reader somewhere they can act', () => {
    expect(attentionItems(quiet({ recoveryCodesRemaining: 1 }))[0]).toMatchObject({
      target: { screenId: 'recovery-codes', params: {} },
      actionLabel: 'Issue new codes',
    })
    expect(attentionItems(quiet({ recoveryCodesRemaining: 0 }))[0]).toMatchObject({
      target: { screenId: 'recovery-codes', params: {} },
    })
  })

  it('counts the drafts and opens the newest in the editor for its own kind', () => {
    const [drafts] = attentionItems(quiet({ draftCount: ready(4), newestDraft: ready([draft()]) }))
    expect(drafts).toMatchObject({
      tone: 'info',
      title: '4 drafts not yet issued',
      note: 'The newest is a credit note for Sunrise Components, dated 20 Jul 2019',
      target: { screenId: 'credit-note', params: { id: 'draft-1' } },
    })
  })

  it('still counts the drafts when the newest could not be read, and goes nowhere', () => {
    const [drafts] = attentionItems(quiet({ draftCount: ready(1), newestDraft: failure }))
    expect(drafts?.title).toBe('1 draft not yet issued')
    expect(drafts?.target).toBeUndefined()
  })

  it('lists the worst first, whatever order they were found in', () => {
    const items = attentionItems(
      quiet({
        draftCount: ready(1),
        newestDraft: ready([draft()]),
        recoveryCodesRemaining: 1,
        receivables: ready(report()),
      }),
    )
    expect(items.map((entry) => entry.tone)).toEqual(['negative', 'warning', 'info'])
    for (const entry of items) expect(ATTENTION_TONES).toContain(entry.tone)
  })

  it('says nothing about a report whose read failed', () => {
    expect(attentionItems(quiet({ receivables: failure, payables: loadingPanel }))).toEqual([])
  })
})

// ---- The tones that exist ---------------------------------------------------

describe('the backup line', () => {
  /* A fact about this machine, not about the user's diligence. */
  it('says how long it has been, and where to go about it', () => {
    const items = attentionItems(quiet({ company: companyBackedUp(daysAgo(9)) }))
    const backup = items.find((item) => item.id === 'backup')

    expect(backup?.title).toBe('No backup for 9 days')
    expect(backup?.tone).toBe('warning')
    expect(backup?.target).toEqual({ screenId: 'backups', params: {} })
  })

  it('says nothing about a company backed up this week', () => {
    const items = attentionItems(quiet({ company: companyBackedUp(daysAgo(3)) }))
    expect(items.map((item) => item.id)).not.toContain('backup')
  })

  it('says nothing at all when the company asked not to be reminded', () => {
    const company = { ...companyBackedUp(daysAgo(40)), remindsAboutBackups: false }
    expect(attentionItems(quiet({ company })).map((item) => item.id)).not.toContain('backup')
  })

  /* Before the company is open there is nothing to be late about. */
  it('says nothing with no company', () => {
    expect(attentionItems(quiet({ company: null })).map((item) => item.id)).not.toContain('backup')
  })
})

describe('BADGE_TONES', () => {
  it('names every tone the atom styles and nothing else', () => {
    expect([...BADGE_TONES].sort()).toEqual([
      'accent',
      'negative',
      'neutral',
      'positive',
      'warning',
    ])
  })
})

describe('a return nobody has opened', () => {
  const due = {
    form: { id: 'gstr-1', label: 'GSTR-1', description: 'Outward supplies.' },
    period: { from: '2026-08-01', to: '2026-08-31', label: 'August 2026' },
    documentCount: 12,
  }

  it('names the form and the month in main words, and opens that return', () => {
    const [item] = attentionItems(quiet({ taxReturnsDue: ready([due]) }))

    expect(item).toMatchObject({
      id: 'tax-return-gstr-1',
      tone: 'info',
      title: 'GSTR-1 for August 2026 has not been looked at',
      target: {
        screenId: 'tax-returns',
        params: { form: 'gstr-1', from: '2026-08-01', to: '2026-08-31' },
      },
      actionLabel: 'Open GSTR-1',
    })
    expect(item?.note).toContain('12 documents are dated then')
  })

  /* It is a nudge, not a failure: a read that did not land says nothing rather than
   * something alarming, and nothing due says nothing at all. */
  it('says nothing when nothing is due, or when the read failed', () => {
    expect(attentionItems(quiet({ taxReturnsDue: ready([]) }))).toEqual([])
    expect(attentionItems(quiet({ taxReturnsDue: failure }))).toEqual([])
    expect(attentionItems(quiet({ taxReturnsDue: loadingPanel }))).toEqual([])
  })
})
