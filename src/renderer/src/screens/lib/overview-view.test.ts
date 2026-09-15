/*
 * What the dashboard decides before it draws anything.
 *
 * EVERY FIXTURE DATE IS IN 2019, which the real clock cannot be in. A fixture whose value
 * coincides with the real world tests nothing about where the value came from: a screen
 * that printed `new Date()` under a heading would pass against a fixture set near today,
 * and this project has been caught by exactly that twice.
 *
 * EVERY ORDERED FIXTURE DISAGREES WITH ITS EXPECTED OUTPUT. The newest document is never
 * first, the latest activity is a RECEIPT rather than a document, and the worst overdue
 * item is never the one at the top of the first report. An input already in the answer's
 * order cannot tell a sort from a slice.
 */

import { describe, expect, it } from 'vitest'
import { TRADE_SIDES } from '@shared/documents'
import type {
  AgedItem,
  AgedPartyRow,
  AgedReport,
  DocumentSummary,
  ReceiptSummary,
  Result,
} from '@shared/dto'
import { agedTitle } from './ageing-view'
import {
  activityLabel,
  activityStatusLabel,
  activityTarget,
  activityTone,
  ACTIVITY_SOURCES,
  BADGE_TONES,
  bucketFigures,
  documentActivity,
  DRAFT_NUMBER_LABEL,
  firstRunSteps,
  nextFirstRunStep,
  isNewCompany,
  mostOverdue,
  outstandingLinkLabel,
  outstandingTitle,
  overdueRowsIn,
  pageOf,
  panelFrom,
  receiptActivity,
  recentActivity,
  stepLabel,
  stepState,
  stepTone,
  STEP_STATES,
  type ActivityRow,
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

function document(over: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    id: 'document-1',
    kind: 'sales-invoice',
    status: 'issued',
    number: 'INV/2019-20/0001',
    date: '2019-04-02',
    dueDate: '2019-05-02',
    partyId: 'party-1',
    partyName: 'Sunrise Components',
    grandTotal: '1180.00',
    ...over,
  }
}

function receipt(over: Partial<ReceiptSummary> = {}): ReceiptSummary {
  return {
    id: 'receipt-1',
    kind: 'receipt',
    status: 'posted',
    number: 'RC/2019-20/0001',
    date: '2019-04-05',
    partyId: 'party-1',
    partyName: 'Sunrise Components',
    amount: '500.00',
    allocated: '500.00',
    unallocated: '0.00',
    ...over,
  }
}

const ready = <T>(data: T): Panel<T> => ({ state: 'ready', data })
const failure: Panel<never> = {
  state: 'failed',
  error: { code: 'NO_COMPANY_OPEN', message: 'No company is open.' },
}
const loadingPanel: Panel<never> = { state: 'loading' }

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
 * Four conditions, four tests, and each input is the one that ONLY its own condition
 * excludes. Dropping any of the four leaves a rule the suite cannot see: two of them are
 * about emptiness and two are about whether the answer is known at all, and the dangerous
 * direction is the second — a failed read read as an empty company greets a business of
 * ten years with "add your first customer".
 */
describe('isNewCompany', () => {
  it('is true when both reads answered and both are empty', () => {
    expect(isNewCompany(ready([]), ready([]))).toBe(true)
  })

  it('is false when there is a document', () => {
    expect(isNewCompany(ready([document()]), ready([]))).toBe(false)
  })

  it('is false when there is a receipt and no document', () => {
    /* Money on account before anything was invoiced. Without this condition the checklist
     * would tell a business that has already banked a deposit to start from nothing. */
    expect(isNewCompany(ready([]), ready([receipt()]))).toBe(false)
  })

  it('is false when the document read failed, however empty the other one is', () => {
    expect(isNewCompany(failure, ready([]))).toBe(false)
  })

  it('is false when the receipt read failed, however empty the other one is', () => {
    expect(isNewCompany(ready([]), failure)).toBe(false)
  })

  it('is false while either read is still in flight', () => {
    expect(isNewCompany(loadingPanel, ready([]))).toBe(false)
    expect(isNewCompany(ready([]), loadingPanel)).toBe(false)
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
  /* Iterated rather than written out. `.badge--info` has no rule in atoms.css and a tone
   * outside the union renders an unstyled pill instead of throwing, so the only way to
   * see it is to check every member against the list of tones that exist. */
  it.each(STEP_STATES)('gives %s a tone the Badge atom styles', (state) => {
    expect(BADGE_TONES).toContain(stepTone(state))
  })

  it.each(STEP_STATES)('gives %s a label of its own', (state) => {
    expect(stepLabel(state)).not.toBe('')
  })

  it('says a different word for each state', () => {
    const labels = STEP_STATES.map(stepLabel)
    expect(new Set(labels).size).toBe(STEP_STATES.length)
  })
})

describe('firstRunSteps', () => {
  const steps = firstRunSteps({ profile: 'done', parties: 'todo', documents: 'unknown' })

  it('puts the business details before the party and the party before the invoice', () => {
    /* A dependency, not a preference: a document cannot be created without the profile
     * (`COMPANY_PROFILE_MISSING`) and has nobody to be addressed to without a party. */
    expect(steps.map((step) => step.id)).toEqual(['profile', 'parties', 'first-document'])
  })

  it('gives each step the state of its own read', () => {
    expect(steps.map((step) => step.state)).toEqual(['done', 'todo', 'unknown'])
  })

  it('sends the last step to the editor rather than to the register', () => {
    /* The invitation is "raise one", so it opens a new document. The register would be a
     * list of the nothing this company has. */
    expect(steps[2]?.screenId).toBe('sales-invoice')
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

  it('names the screen each step goes to', () => {
    expect(steps.map((step) => step.screenId)).toEqual([
      'company-profile',
      'customers',
      'sales-invoice',
    ])
  })
})

// ---- What is owed -----------------------------------------------------------

describe('outstanding wording', () => {
  it.each(TRADE_SIDES)('has a heading of its own for %s', (side) => {
    expect(outstandingTitle(side)).not.toBe('')
  })

  it('does not call both sides the same thing', () => {
    const titles = TRADE_SIDES.map(outstandingTitle)
    expect(new Set(titles).size).toBe(TRADE_SIDES.length)
  })

  it.each(TRADE_SIDES)("builds the link out of the report's own name for %s", (side) => {
    expect(outstandingLinkLabel(side)).toBe(`Open the ${agedTitle(side).toLowerCase()}`)
  })
})

describe('bucketFigures', () => {
  it("pairs each column with the figure in that position, in the report's own order", () => {
    const figures = bucketFigures(
      report({
        totals: {
          buckets: ['10.00', '20.00', '30.00'],
          onAccount: '0.00',
          overdue: '50.00',
          total: '60.00',
        },
      }),
    )

    expect(figures).toEqual([
      { label: 'Not yet due', figure: '10.00' },
      { label: '1-30 days', figure: '20.00' },
      { label: 'Over 30 days', figure: '30.00' },
    ])
  })

  it('leaves a hole rather than borrowing the previous column when a figure is missing', () => {
    /* A nought would be a figure and would total correctly; a hole is visibly a hole. */
    const figures = bucketFigures(
      report({
        totals: { buckets: ['10.00'], onAccount: '0.00', overdue: '0.00', total: '10.00' },
      }),
    )

    expect(figures.map((column) => column.figure)).toEqual(['10.00', null, null])
  })
})

// ---- What is late -----------------------------------------------------------

describe('overdueRowsIn', () => {
  it('keeps an item that is past its due date', () => {
    const rows = overdueRowsIn('sales', report())
    expect(rows.map((row) => row.item.number)).toEqual(['INV/2019-20/0001'])
  })

  it("drops money standing to the party's credit, however old it is", () => {
    /* A credit note raised two hundred days ago has two hundred days on it and is owed by
     * nobody. `bucket` being null is what says so, and a test on the days alone would put
     * the loudest badge on the customer's own money. */
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

  it('carries the name of the party the item was listed under', () => {
    const rows = overdueRowsIn(
      'purchase',
      report({
        parties: [
          party({ partyId: 'party-1', partyName: 'Sunrise Components' }),
          party({
            partyId: 'party-2',
            partyName: 'Halide Metals',
            items: [item({ sourceId: 'document-2', number: 'BILL/9' })],
          }),
        ],
      }),
    )

    expect(rows.map((row) => [row.item.number, row.partyName])).toEqual([
      ['INV/2019-20/0001', 'Sunrise Components'],
      ['BILL/9', 'Halide Metals'],
    ])
    expect(rows.every((row) => row.side === 'purchase')).toBe(true)
  })

  it('keys a row by the side it came from, so both sides can be listed together', () => {
    const sales = overdueRowsIn('sales', report())
    const purchase = overdueRowsIn('purchase', report())
    expect(sales[0]?.key).not.toBe(purchase[0]?.key)
  })
})

describe('mostOverdue', () => {
  /* Deliberately not in the answer's order: the worst is in the middle. An input already
   * sorted cannot tell a sort from an identity. */
  const rows = [
    ...overdueRowsIn(
      'sales',
      report({
        parties: [party({ items: [item({ sourceId: 'a', number: 'A', daysOverdue: 5 })] })],
      }),
    ),
    ...overdueRowsIn(
      'purchase',
      report({
        parties: [party({ items: [item({ sourceId: 'b', number: 'B', daysOverdue: 90 })] })],
      }),
    ),
    ...overdueRowsIn(
      'sales',
      report({
        parties: [party({ items: [item({ sourceId: 'c', number: 'C', daysOverdue: 40 })] })],
      }),
    ),
  ]

  it('puts the latest first, across both sides', () => {
    expect(mostOverdue(rows, 5).map((row) => row.item.number)).toEqual(['B', 'C', 'A'])
  })

  it('keeps only as many as the panel draws', () => {
    expect(mostOverdue(rows, 2).map((row) => row.item.number)).toEqual(['B', 'C'])
  })

  it('leaves the list it was given alone', () => {
    /* `sort` is in place, and these rows are derived from screen state. */
    mostOverdue(rows, 5)
    expect(rows.map((row) => row.item.number)).toEqual(['A', 'B', 'C'])
  })
})

// ---- What has happened lately -----------------------------------------------

describe('documentActivity', () => {
  it("takes the document's own total, not a figure of its own", () => {
    const rows = documentActivity([document({ grandTotal: '1180.00' })])
    expect(rows[0]?.amount).toBe('1180.00')
  })

  it('names a draft rather than leaving the number blank', () => {
    const rows = documentActivity([document({ status: 'draft', number: null })])
    expect(rows[0]?.numberLabel).toBe(DRAFT_NUMBER_LABEL)
  })

  it('keeps the number a document has', () => {
    expect(documentActivity([document()])[0]?.numberLabel).toBe('INV/2019-20/0001')
  })
})

describe('receiptActivity', () => {
  it("takes the voucher's own amount", () => {
    expect(receiptActivity([receipt({ amount: '500.00' })])[0]?.amount).toBe('500.00')
  })

  it('marks the row as a receipt, so it cannot open a document editor', () => {
    expect(receiptActivity([receipt()])[0]?.source).toBe('receipt')
  })
})

describe('recentActivity', () => {
  /*
   * ORDERED SO THAT THE ANSWER IS NOT THE INPUT. The newest thing in these books is a
   * RECEIPT and it is listed last of the receipts, so a screen that took the first
   * document, or the first row of either list, gets a different answer from this one.
   */
  const documents = [
    document({ id: 'd1', number: 'INV/1', date: '2019-04-02' }),
    document({ id: 'd2', number: 'INV/2', date: '2019-06-30' }),
    document({ id: 'd3', number: 'INV/3', date: '2019-05-11' }),
  ]
  const receipts = [
    receipt({ id: 'r1', number: 'RC/1', date: '2019-03-15' }),
    receipt({ id: 'r2', number: 'RC/2', date: '2019-07-20' }),
  ]

  it('interleaves documents and vouchers, newest first', () => {
    expect(recentActivity(documents, receipts, 6).map((row) => row.numberLabel)).toEqual([
      'RC/2',
      'INV/2',
      'INV/3',
      'INV/1',
      'RC/1',
    ])
  })

  it('keeps only as many rows as the panel draws', () => {
    expect(recentActivity(documents, receipts, 2).map((row) => row.numberLabel)).toEqual([
      'RC/2',
      'INV/2',
    ])
  })

  it('lists what there is when one of the two came back empty', () => {
    expect(recentActivity(documents, [], 6).map((row) => row.numberLabel)).toEqual([
      'INV/2',
      'INV/3',
      'INV/1',
    ])
  })
})

// ---- What a row says and where it opens -------------------------------------

const activity = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  key: 'document:document-1',
  source: 'document',
  id: 'document-1',
  kind: 'sales-invoice',
  numberLabel: 'INV/2019-20/0001',
  date: '2019-04-02',
  partyName: 'Sunrise Components',
  status: 'issued',
  amount: '1180.00',
  ...over,
})

describe('activityLabel', () => {
  it("uses the kind's own name from the shared table", () => {
    expect(activityLabel(activity({ kind: 'purchase-bill' }))).toBe('Purchase bill')
  })

  it('names a voucher from the receipt table, not the document one', () => {
    expect(activityLabel(activity({ source: 'receipt', kind: 'refund' }))).toBe('Refund paid')
  })

  it('leaves a kind this build has never heard of under its own name', () => {
    /* A company file written by a newer build. Its own word is more use to the reader
     * than one invented here, and it says plainly what has happened. */
    expect(activityLabel(activity({ kind: 'delivery-challan' }))).toBe('delivery-challan')
  })
})

describe('activityStatusLabel', () => {
  it("reads a document's status from the document vocabulary", () => {
    expect(activityStatusLabel(activity({ status: 'draft' }))).toBe('Draft')
  })

  it("reads a voucher's status from the receipt vocabulary", () => {
    expect(activityStatusLabel(activity({ source: 'receipt', status: 'posted' }))).toBe('Posted')
  })
})

describe('activityTone', () => {
  it.each(ACTIVITY_SOURCES)('gives every %s status a tone the Badge atom styles', (source) => {
    for (const status of ['draft', 'issued', 'posted', 'cancelled', 'from-a-newer-build']) {
      expect(BADGE_TONES).toContain(activityTone(activity({ source, status })))
    }
  })

  it('does not draw a posted voucher in the tone a cancelled one wears', () => {
    /* The document table answers `neutral` for anything it does not recognise, and
     * `posted` is one of those. Lending it to a receipt would grey out every voucher in
     * the books. */
    const posted = activityTone(activity({ source: 'receipt', status: 'posted' }))
    const cancelled = activityTone(activity({ source: 'receipt', status: 'cancelled' }))
    expect(posted).not.toBe(cancelled)
  })
})

describe('activityTarget', () => {
  it('opens a document in its own editor', () => {
    expect(activityTarget(activity({ kind: 'credit-note', id: 'document-9' }))).toEqual({
      screenId: 'credit-note',
      params: { id: 'document-9' },
    })
  })

  it('opens a voucher in its own editor', () => {
    expect(
      activityTarget(activity({ source: 'receipt', kind: 'payment', id: 'receipt-9' })),
    ).toEqual({ screenId: 'payment', params: { id: 'receipt-9' } })
  })

  it('reads the source and not only the kind', () => {
    /* The two kind tables are separate lists of strings and nothing stops one naming the
     * other's member. A lookup that only asked "is this a document kind" would send a
     * voucher to the invoice editor, which would then fetch a document that is not there. */
    expect(activityTarget(activity({ source: 'receipt', kind: 'sales-invoice' }))).toBeNull()
  })

  it('goes nowhere for a kind this build does not know', () => {
    expect(activityTarget(activity({ kind: 'delivery-challan' }))).toBeNull()
  })
})

// ---- How much of a list is shown --------------------------------------------

describe('pageOf', () => {
  it('says there is no more when the extra row did not arrive', () => {
    expect(pageOf([1, 2, 3], 3)).toEqual({ rows: [1, 2, 3], hasMore: false })
  })

  it('drops the extra row and says there is more when it did', () => {
    expect(pageOf([1, 2, 3, 4], 3)).toEqual({ rows: [1, 2, 3], hasMore: true })
  })
})

// ---- The tones that exist ---------------------------------------------------

describe('BADGE_TONES', () => {
  it('names every tone the atom styles and nothing else', () => {
    /* Derived from a total record over `BadgeTone`, so this list cannot silently fall
     * behind the atom. Pinned by value, so the derivation cannot silently empty either. */
    expect([...BADGE_TONES].sort()).toEqual([
      'accent',
      'negative',
      'neutral',
      'positive',
      'warning',
    ])
  })
})
