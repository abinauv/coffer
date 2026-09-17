/*
 * The posting rules — all four of them.
 *
 * These are the tests that catch a change in accounting treatment. The rules are pure, so
 * every one of them is a document written down beside the entry it must produce — no
 * database, no clock, and nothing to arrange except the chart.
 *
 * The properties worth stating, because they are what the assertions below are for:
 *
 *   - the entry balances, always, for every shape of document;
 *   - the party's control account moves by exactly what the document says at the bottom;
 *   - value moves by the taxable amount and never by the tax;
 *   - the sum of the tax lines equals the sum of the printed tax summary, even though
 *     the two are grouped differently.
 *
 * THE FIRST TWO THIRDS OF THIS FILE ARE ALL SALES INVOICE, and that is not an oversight.
 * They were written when it was the only rule, they pin the properties above in more
 * shapes than the other three are exercised in — every rounding policy, an empty
 * document, a rebate line, an account named on a line — and they all still pass, unedited,
 * against the engine that replaced the function they were written for. That is the useful
 * thing about them now: they are the evidence the refactor changed no behaviour.
 *
 * `the four treatments` is where the other three live, and it works differently on
 * purpose. It asserts the TABLE in the header of ./posting.ts, one column at a time
 * across all four kinds, because what can be wrong about a treatment built out of `side`
 * and `direction` is not a shape of document — it is a sign or an account, in one cell.
 */

import { describe, expect, it } from 'vitest'

import { D, ZERO, sum, type Decimal } from '@main/domain/money'
import type { AccountRef, AccountResolver, PostingContext } from '@main/domain/ledger'
import { isPostingError } from '@main/domain/ledger'

import {
  controlRoleFor,
  creditNoteRule,
  debitNoteRule,
  postingRuleFor,
  purchaseBillRule,
  salesInvoiceRule,
  type PostableDocument,
} from './posting'
import { documentTotals } from './totals'
import {
  DOCUMENT_KINDS,
  postsToLedger,
  sourceTypeOf,
  type DocumentLine,
  type DocumentLineTax,
} from './types'

// ---- The chart these tests post into ---------------------------------------

const ACCOUNTS: Record<string, AccountRef> = {
  receivable: { id: 'a-recv', code: '1300', name: 'Accounts Receivable', type: 'asset' },
  sales: { id: 'a-sales', code: '4100', name: 'Sales', type: 'income' },
  freight: { id: 'a-freight', code: '6500', name: 'Freight Outward', type: 'expense' },
  roundOff: { id: 'a-round', code: '4900', name: 'Round Off', type: 'income' },
  cgst: { id: 'a-cgst', code: '2210', name: 'Output CGST', type: 'liability' },
  sgst: { id: 'a-sgst', code: '2211', name: 'Output SGST', type: 'liability' },
  igst: { id: 'a-igst', code: '2212', name: 'Output IGST', type: 'liability' },
  exports: { id: 'a-exports', code: '4200', name: 'Export Sales', type: 'income' },

  /* The other side of the trade, and the two contra accounts a return posts to. Named
   * here rather than in a second chart so that a test can assert a credit note and an
   * invoice touch DIFFERENT accounts — which is the whole claim being made. */
  payable: { id: 'a-pay', code: '2100', name: 'Accounts Payable', type: 'liability' },
  purchases: { id: 'a-purch', code: '5100', name: 'Purchases', type: 'expense' },
  salesReturns: { id: 'a-sret', code: '4210', name: 'Sales Returns', type: 'income' },
  purchaseReturns: { id: 'a-pret', code: '5200', name: 'Purchase Returns', type: 'expense' },
  freightIn: { id: 'a-fin', code: '5400', name: 'Freight Inward', type: 'expense' },
  cgstIn: { id: 'a-cgst-in', code: '1510', name: 'Input CGST', type: 'asset' },
  sgstIn: { id: 'a-sgst-in', code: '1511', name: 'Input SGST', type: 'asset' },
  igstIn: { id: 'a-igst-in', code: '1512', name: 'Input IGST', type: 'asset' },
}

interface ChartOptions {
  /** Roles to leave unmapped, to prove what the rule refuses. */
  without?: readonly string[]
  /** Tax components to leave without an account. */
  withoutTax?: readonly string[]
}

function resolver({ without = [], withoutTax = [] }: ChartOptions = {}): AccountResolver {
  const roles: Record<string, AccountRef | undefined> = {
    'accounts-receivable': ACCOUNTS['receivable'],
    sales: ACCOUNTS['sales'],
    'freight-outward': ACCOUNTS['freight'],
    'round-off': ACCOUNTS['roundOff'],
    'accounts-payable': ACCOUNTS['payable'],
    purchases: ACCOUNTS['purchases'],
    'sales-returns': ACCOUNTS['salesReturns'],
    'purchase-returns': ACCOUNTS['purchaseReturns'],
    'freight-inward': ACCOUNTS['freightIn'],
  }
  /* Two accounts per component on opposite sides of the balance sheet, exactly as
   * `tax-accounts.ts` seeds them. A resolver that answered the same account for both
   * directions would let a rule post input tax to a liability and no test would see it. */
  const taxes: Record<string, Record<string, AccountRef | undefined>> = {
    output: { CGST: ACCOUNTS['cgst'], SGST: ACCOUNTS['sgst'], IGST: ACCOUNTS['igst'] },
    input: { CGST: ACCOUNTS['cgstIn'], SGST: ACCOUNTS['sgstIn'], IGST: ACCOUNTS['igstIn'] },
  }
  const byId = new Map(Object.values(ACCOUNTS).map((account) => [account.id, account]))

  return {
    byId: (id) => byId.get(id) ?? null,
    byCode: (code) => Object.values(ACCOUNTS).find((account) => account.code === code) ?? null,
    forRole: (role) => (without.includes(role) ? null : (roles[role] ?? null)),
    forTaxComponent: (code, direction) =>
      withoutTax.includes(code) ? null : (taxes[direction]?.[code] ?? null),
  }
}

const context = (options?: ChartOptions): PostingContext => ({
  accounts: resolver(options),
  /* Present because `PostingContext` carries it, and deliberately unused: this rule does
   * not look at whether the period is open. That is the repository's, inside the one
   * transaction that issues a document — see the header. */
  period: {
    id: 'p-1',
    fiscalYearLabel: '2026-27',
    index: 1,
    startDate: '2026-04-01',
    endDate: '2026-04-30',
    status: 'open',
  },
  homeJurisdictionCode: '33',
})

// ---- Documents -------------------------------------------------------------

function tax(code: string, ratePct: string, amount: string): DocumentLineTax {
  return { code, label: `${code} @ ${ratePct}%`, ratePct: D(ratePct), amount: D(amount) }
}

function line(over: Partial<DocumentLine> & Pick<DocumentLine, 'lineNumber'>): DocumentLine {
  return {
    id: `l-${String(over.lineNumber)}`,
    itemId: null,
    description: 'Ball bearing 6203',
    quantity: D('1'),
    unitCode: 'NOS',
    unitPrice: D('1000.00'),
    discount: ZERO,
    taxableAmount: D('1000.00'),
    ratePct: D('18'),
    classificationCode: '8482',
    isCharge: false,
    accountId: null,
    /* Nothing recorded, which is what every line written before migration 0021 carries
     * and what the posting rule has to keep treating as eligible. The tests that care
     * about a blocked credit say so on the line. */
    itcEligibility: null,
    taxes: [tax('CGST', '9', '90.00'), tax('SGST', '9', '90.00')],
    ...over,
  }
}

function invoice(over: Partial<PostableDocument> = {}): PostableDocument {
  return {
    id: 'd-1',
    kind: 'sales-invoice',
    status: 'issued',
    number: 'INV/2026-27/0001',
    date: '2026-04-15',
    partyReference: null,
    partyId: 'party-1',
    placeOfSupply: { jurisdictionCode: '33', countryCode: 'in' },
    roundingPolicy: 'none',
    narration: '',
    isReverseCharge: false,
    exportTaxPayment: null,
    lines: [line({ lineNumber: 1 })],
    ...over,
  }
}

// ---- Reading the entry back ------------------------------------------------

const post = (document: PostableDocument, options?: ChartOptions) =>
  salesInvoiceRule.toEntry(document, context(options))

/** What one account moved by, as a signed debit-minus-credit figure. */
function movementOn(
  document: PostableDocument,
  account: AccountRef,
  options?: ChartOptions,
): Decimal {
  const entry = post(document, options)
  return sum(
    entry.lines
      .filter((entryLine) => entryLine.accountId === account.id)
      .map((entryLine) => entryLine.debit.minus(entryLine.credit)),
  )
}

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return isPostingError(error) ? error.code : `not a PostingError: ${String(error)}`
  }
  return 'no error thrown'
}

// ---- The rule itself -------------------------------------------------------

describe('what the rule is', () => {
  it('posts as a sales invoice and says so', () => {
    expect(salesInvoiceRule.source).toBe('sales-invoice')
    expect(post(invoice()).source).toEqual({
      type: 'sales-invoice',
      id: 'd-1',
      number: 'INV/2026-27/0001',
    })
  })

  /* The date the document bears, never "now". A document dated differently from its
   * entry is a register and a ledger falling in different months. */
  it('posts as of the document date', () => {
    expect(post(invoice({ date: '2026-04-30' })).date).toBe('2026-04-30')
  })

  /* Loud rather than silently producing a wrong entry. Not a PostingError, because no
   * user can act on the wrong rule having been called. */
  it('refuses a document it does not post', () => {
    expect(() => post(invoice({ kind: 'purchase-bill' }))).toThrow(/purchase bill/i)
  })
})

describe('the entry a plain invoice makes', () => {
  it('debits receivable with what the customer owes, and nothing else', () => {
    const document = invoice()
    const entry = post(document)
    /* `greaterThan(0)`, not `isPositive()`. decimal.js gives zero a positive sign, so
     * `isPositive()` is true for '0.00' and this filter would return every line. Measured
     * — and the same trap had already produced a real bug in the year-end close. */
    const debits = entry.lines.filter((entryLine) => entryLine.debit.greaterThan(0))

    expect(debits).toHaveLength(1)
    expect(debits[0]?.accountId).toBe(ACCOUNTS['receivable']?.id)
    expect(debits[0]?.debit.toString()).toBe('1180')
    expect(documentTotals(document).grandTotal.toString()).toBe('1180')
  })

  /* The line that makes a receivables ledger a grouping of the same rows the balance
   * sheet totals, rather than a second set of books (migration 0005). */
  it('names the customer on the receivable line and on no other', () => {
    const withParty = post(invoice()).lines.filter((entryLine) => entryLine.partyId != null)

    expect(withParty).toHaveLength(1)
    expect(withParty[0]?.accountId).toBe(ACCOUNTS['receivable']?.id)
    expect(withParty[0]?.partyId).toBe('party-1')
  })

  /*
   * Turnover is what was charged for the supply, not what was collected. A business that
   * credited sales with the tax would overstate its turnover by the rate of GST — and
   * would do it consistently, so nothing would look wrong.
   */
  it('credits revenue with the taxable value and never with the tax', () => {
    expect(movementOn(invoice(), ACCOUNTS['sales']!).toString()).toBe('-1000')
  })

  it('credits each tax component to its own account', () => {
    expect(movementOn(invoice(), ACCOUNTS['cgst']!).toString()).toBe('-90')
    expect(movementOn(invoice(), ACCOUNTS['sgst']!).toString()).toBe('-90')
  })

  it('balances', () => {
    const entry = post(invoice())
    const debits = sum(entry.lines.map((entryLine) => entryLine.debit))
    const credits = sum(entry.lines.map((entryLine) => entryLine.credit))

    expect(debits.toString()).toBe(credits.toString())
  })

  /* Invariant 5. A both-zero line balances, passes every total, and says nothing. */
  it('writes no line that is neither a debit nor a credit', () => {
    for (const entryLine of post(invoice()).lines) {
      expect(entryLine.debit.isZero()).not.toBe(entryLine.credit.isZero())
      expect(entryLine.debit.isNegative()).toBe(false)
      expect(entryLine.credit.isNegative()).toBe(false)
    }
  })
})

describe('inter-state, where the components change', () => {
  /*
   * The same total, a different split. Nothing in this rule knows what IGST is — it asks
   * the resolver for whatever the document says it carries, which is what lets a second
   * regime with different components post through the same code.
   */
  it('posts IGST exactly as it posts CGST and SGST', () => {
    const interState = invoice({
      placeOfSupply: { jurisdictionCode: '29', countryCode: 'in' },
      lines: [line({ lineNumber: 1, taxes: [tax('IGST', '18', '180.00')] })],
    })

    expect(movementOn(interState, ACCOUNTS['igst']!).toString()).toBe('-180')
    expect(movementOn(interState, ACCOUNTS['receivable']!).toString()).toBe('1180')
    expect(movementOn(interState, ACCOUNTS['cgst']!).toString()).toBe('0')
  })

  /* An export is zero-rated: value, no tax, and no tax line rather than a zero one. */
  it('makes no tax line at all for a nil-rated supply', () => {
    const zeroRated = invoice({
      placeOfSupply: { jurisdictionCode: null, countryCode: 'ae' },
      lines: [line({ lineNumber: 1, ratePct: ZERO, taxes: [] })],
    })
    const entry = post(zeroRated)

    expect(entry.lines).toHaveLength(2)
    expect(movementOn(zeroRated, ACCOUNTS['receivable']!).toString()).toBe('1000')
    expect(movementOn(zeroRated, ACCOUNTS['sales']!).toString()).toBe('-1000')
  })
})

describe('charges, which are not turnover', () => {
  const withFreight = () =>
    invoice({
      lines: [
        line({ lineNumber: 1 }),
        line({
          lineNumber: 2,
          description: 'Freight',
          isCharge: true,
          taxableAmount: D('200.00'),
          unitPrice: D('200.00'),
          unitCode: null,
          taxes: [tax('CGST', '9', '18.00'), tax('SGST', '9', '18.00')],
        }),
      ],
    })

  /*
   * The rule this test exists for: freight recovered from a customer is not a sale. Put
   * it in `sales` and turnover is overstated in every report and in the return, by an
   * amount that looks entirely plausible.
   */
  it('keeps a charge out of sales', () => {
    expect(movementOn(withFreight(), ACCOUNTS['sales']!).toString()).toBe('-1000')
    expect(movementOn(withFreight(), ACCOUNTS['freight']!).toString()).toBe('-200')
  })

  it('taxes a charge like anything else', () => {
    expect(movementOn(withFreight(), ACCOUNTS['cgst']!).toString()).toBe('-108')
    expect(movementOn(withFreight(), ACCOUNTS['receivable']!).toString()).toBe('1416')
  })

  /* An explicit account on the line beats both defaults — it is a decision somebody made
   * about this line, and the default is only what to do when nobody did. */
  it('lets a line name its own account', () => {
    const named = invoice({
      lines: [line({ lineNumber: 1, accountId: ACCOUNTS['exports']!.id })],
    })

    expect(movementOn(named, ACCOUNTS['exports']!).toString()).toBe('-1000')
    expect(movementOn(named, ACCOUNTS['sales']!).toString()).toBe('0')
  })

  it('refuses a line naming an account that has gone', () => {
    const dangling = invoice({ lines: [line({ lineNumber: 1, accountId: 'a-deleted' })] })

    expect(codeOf(() => post(dangling))).toBe('ACCOUNT_NOT_FOUND')
  })
})

describe('lines that are not a plain positive sale', () => {
  /*
   * A trade discount given on the invoice reduces the value of the supply itself, so it
   * is already out of `taxableAmount` and the tax was charged on the reduced figure. The
   * rule must post the taxable amount and nothing else — adding the discount back would
   * report turnover the customer was never charged, and the entry would not balance.
   */
  it('credits revenue net of a discount, because the tax was charged that way', () => {
    const discounted = invoice({
      lines: [
        line({
          lineNumber: 1,
          unitPrice: D('1200.00'),
          discount: D('200.00'),
          taxableAmount: D('1000.00'),
        }),
      ],
    })

    expect(documentTotals(discounted).totalDiscount.toString()).toBe('200')
    expect(movementOn(discounted, ACCOUNTS['sales']!).toString()).toBe('-1000')
    expect(movementOn(discounted, ACCOUNTS['receivable']!).toString()).toBe('1180')
  })

  /*
   * A line worth nothing — a free sample listed so the customer knows it was sent. It
   * must produce no posting line at all: a zero credit is a both-zero line, which
   * invariant 5 refuses, and the whole entry would be rejected because of a row that
   * said nothing.
   */
  it('writes no line for an account whose lines come to nothing', () => {
    const withFreebie = invoice({
      lines: [
        line({ lineNumber: 1 }),
        line({
          lineNumber: 2,
          description: 'Sample, free of charge',
          accountId: ACCOUNTS['exports']!.id,
          unitPrice: ZERO,
          taxableAmount: ZERO,
          taxes: [],
        }),
      ],
    })
    const entry = post(withFreebie)

    expect(entry.lines.some((l) => l.accountId === ACCOUNTS['exports']?.id)).toBe(false)
    expect(movementOn(withFreebie, ACCOUNTS['receivable']!).toString()).toBe('1180')
  })

  /*
   * A rebate shown as a line rather than as a discount, which is how a business records
   * one agreed after the price was quoted. Its account goes negative, and a credit of
   * minus something is a line invariant 5 refuses — so it becomes a debit.
   */
  it('turns an account with a negative total into a debit', () => {
    const withRebate = invoice({
      lines: [
        line({ lineNumber: 1 }),
        line({
          lineNumber: 2,
          description: 'Agreed rebate',
          accountId: ACCOUNTS['exports']!.id,
          unitPrice: D('-200.00'),
          taxableAmount: D('-200.00'),
          taxes: [],
        }),
      ],
    })
    const entry = post(withRebate)
    const rebate = entry.lines.find((l) => l.accountId === ACCOUNTS['exports']?.id)

    expect(rebate?.debit.toString()).toBe('200')
    expect(rebate?.credit.toString()).toBe('0')
    expect(movementOn(withRebate, ACCOUNTS['receivable']!).toString()).toBe('980')

    /* And it still balances, which is the thing a negative credit would have broken. */
    expect(sum(entry.lines.map((l) => l.debit)).toString()).toBe(
      sum(entry.lines.map((l) => l.credit)).toString(),
    )
  })
})

/*
 * An invoice that comes to nothing with real lines on it — a rebate cancelling exactly
 * the goods line it corrects. The customer owes nothing, so receivables must not move,
 * and a zero debit is not "no movement": invariant 5 refuses a line that is neither a
 * debit nor a credit, so it is an `AMBIGUOUS_LINE` refusal arriving at a user who was
 * told their invoice would not post, with no line on it to point at.
 *
 * The same bug the year-end close had, and found the same way. A `Buckets` entry that
 * comes to nothing is already skipped; the receivable line was written before that and
 * had to learn it.
 */
describe('an invoice that comes to nothing', () => {
  const nothingDue = () =>
    invoice({
      lines: [
        line({ lineNumber: 1, taxes: [] }),
        line({
          lineNumber: 2,
          description: 'Agreed rebate, in full',
          accountId: ACCOUNTS['exports']!.id,
          unitPrice: D('-1000.00'),
          taxableAmount: D('-1000.00'),
          taxes: [],
        }),
      ],
    })

  it('writes no receivable line', () => {
    expect(documentTotals(nothingDue()).grandTotal.toString()).toBe('0')
    expect(post(nothingDue()).lines.some((l) => l.accountId === ACCOUNTS['receivable']?.id)).toBe(
      false,
    )
  })

  /* What is left is a real entry: the sale and the rebate, against each other. It
   * balances without the receivable line precisely because the figure that line would
   * have carried is zero. */
  it('still posts what did happen, and balances', () => {
    const entry = post(nothingDue())

    expect(entry.lines).toHaveLength(2)
    expect(sum(entry.lines.map((l) => l.debit)).toString()).toBe('1000')
    expect(sum(entry.lines.map((l) => l.credit)).toString()).toBe('1000')
  })

  /* Every line on it is neither a debit nor a credit — which is what invariant 5 calls
   * ambiguous, and what a zero receivable line would have been. */
  it('leaves no line that is neither a debit nor a credit', () => {
    for (const entryLine of post(nothingDue()).lines) {
      expect(entryLine.debit.isZero() && entryLine.credit.isZero()).toBe(false)
    }
  })
})

/*
 * WHICH KINDS HAVE A RULE. One null, where there used to be two: a kind either has a
 * `sourceType` and therefore a rule, or it has neither. The quotation is the only kind
 * without one, and it is without one permanently rather than until somebody writes it.
 */
describe('postingRuleFor', () => {
  it('gives the sales rule for a sales invoice', () => {
    expect(postingRuleFor('sales-invoice')).toBe(salesInvoiceRule)
  })

  /* The claim that "a kind that posts has a rule" made mechanically rather than by
   * listing four kinds — a sixth that posts and is not registered fails here. */
  it('gives a rule for every kind that reaches the ledger', () => {
    for (const definition of DOCUMENT_KINDS.filter((each) => postsToLedger(each.kind))) {
      expect(postingRuleFor(definition.kind)).not.toBeNull()
    }
  })

  it('gives nothing for a quotation, which never posts at all', () => {
    expect(postingRuleFor('quotation')).toBeNull()
    expect(postsToLedger('quotation')).toBe(false)
  })

  /* Absence here means exactly "does not post", which is the property that let the
   * repository stop telling two nulls apart. */
  it('has a rule for exactly the kinds that post', () => {
    for (const definition of DOCUMENT_KINDS) {
      expect(postingRuleFor(definition.kind) === null).toBe(!postsToLedger(definition.kind))
    }
  })

  /* A rule that exists posts what its kind says it posts. The day a second rule is
   * written, this is what catches it being registered under the wrong kind — which
   * would put a purchase in the sales register and balance perfectly. */
  it('never returns a rule whose source disagrees with the kind it was asked for', () => {
    for (const definition of DOCUMENT_KINDS) {
      const rule = postingRuleFor(definition.kind)
      if (rule !== null) {
        expect(rule.source).toBe(sourceTypeOf(definition.kind))
      }
    }
  })
})

describe('many lines', () => {
  const threeLines = () =>
    invoice({
      lines: [
        line({ lineNumber: 1 }),
        line({
          lineNumber: 2,
          taxableAmount: D('500.00'),
          taxes: [tax('CGST', '9', '45.00'), tax('SGST', '9', '45.00')],
        }),
        line({
          lineNumber: 3,
          taxableAmount: D('300.00'),
          ratePct: D('5'),
          taxes: [tax('CGST', '2.5', '7.50'), tax('SGST', '2.5', '7.50')],
        }),
      ],
    })

  /*
   * One credit to sales, not three. The document holds the line detail; repeating it in
   * the ledger makes the day book unreadable and tells a reader nothing the invoice does
   * not already say.
   */
  it('gathers lines sharing an account into one posting line', () => {
    const entry = post(threeLines())
    const toSales = entry.lines.filter((entryLine) => entryLine.accountId === ACCOUNTS['sales']?.id)

    expect(toSales).toHaveLength(1)
    expect(toSales[0]?.credit.toString()).toBe('1800')
  })

  /*
   * The property that keeps the printed document and the ledger honest. The summary is
   * keyed by component AND rate so an invoice can print `CGST @ 9%` and `CGST @ 2.5%`
   * separately; the ledger groups by component alone. Two questions, same figures.
   */
  it('posts one line per component however many rates fed it, summing to the printed block', () => {
    const document = threeLines()
    const entry = post(document)
    const cgstLines = entry.lines.filter(
      (entryLine) => entryLine.accountId === ACCOUNTS['cgst']?.id,
    )
    const printedCgst = documentTotals(document).taxSummary.filter((row) => row.code === 'CGST')

    expect(printedCgst).toHaveLength(2)
    expect(cgstLines).toHaveLength(1)
    expect(cgstLines[0]?.credit.toString()).toBe(
      sum(printedCgst.map((row) => row.amount)).toString(),
    )
    expect(cgstLines[0]?.credit.toString()).toBe('142.5')
  })

  it('still balances', () => {
    const entry = post(threeLines())
    expect(sum(entry.lines.map((l) => l.debit)).toString()).toBe(
      sum(entry.lines.map((l) => l.credit)).toString(),
    )
  })
})

describe('rounding', () => {
  const odd = (roundingPolicy: 'whole-unit' | 'none') =>
    invoice({
      roundingPolicy,
      lines: [
        line({
          lineNumber: 1,
          taxableAmount: D('1000.30'),
          taxes: [tax('CGST', '9', '90.03'), tax('SGST', '9', '90.03')],
        }),
      ],
    })

  it('posts the adjustment to round-off and leaves the entry balanced', () => {
    const document = odd('whole-unit')
    const totals = documentTotals(document)

    expect(totals.netTotal.toString()).toBe('1180.36')
    expect(totals.grandTotal.toString()).toBe('1180')
    expect(movementOn(document, ACCOUNTS['receivable']!).toString()).toBe('1180')
    /* Rounding down means the customer pays less than the lines add up to, so the
     * difference is a debit — a cost, which is what rounding in the customer's favour is. */
    expect(movementOn(document, ACCOUNTS['roundOff']!).toString()).toBe('0.36')
  })

  it('rounds the other way with the same arithmetic', () => {
    const up = invoice({
      roundingPolicy: 'whole-unit',
      lines: [
        line({
          lineNumber: 1,
          taxableAmount: D('1000.60'),
          taxes: [tax('CGST', '9', '90.05'), tax('SGST', '9', '90.05')],
        }),
      ],
    })

    expect(documentTotals(up).grandTotal.toString()).toBe('1181')
    expect(movementOn(up, ACCOUNTS['roundOff']!).toString()).toBe('-0.3')
  })

  /* `none` is not "round by zero" — no line at all, so a round-off account that nothing
   * touched stays off the trial balance. */
  it('writes no round-off line when the document does not round', () => {
    const entry = post(odd('none'))

    expect(entry.lines.some((l) => l.accountId === ACCOUNTS['roundOff']?.id)).toBe(false)
    expect(movementOn(odd('none'), ACCOUNTS['receivable']!).toString()).toBe('1180.36')
  })

  /*
   * The policy is the document's own, frozen when it was issued. Reading it from a
   * setting that has changed since would silently restate an invoice already sent.
   */
  it('takes the policy from the document rather than from anywhere else', () => {
    expect(movementOn(odd('whole-unit'), ACCOUNTS['receivable']!).toString()).toBe('1180')
    expect(movementOn(odd('none'), ACCOUNTS['receivable']!).toString()).toBe('1180.36')
  })
})

describe('what a missing account does', () => {
  /* Fatal, and it has to be: an invoice with nowhere to put the receivable is an invoice
   * that cannot post, and posting it anywhere else would be inventing a debtor. */
  it('refuses when receivables is unmapped', () => {
    expect(codeOf(() => post(invoice(), { without: ['accounts-receivable'] }))).toBe(
      'ROLE_UNMAPPED',
    )
  })

  it('refuses when sales is unmapped', () => {
    expect(codeOf(() => post(invoice(), { without: ['sales'] }))).toBe('ROLE_UNMAPPED')
  })

  /*
   * Refused rather than quietly sent to sales. Tax posted to revenue is turnover
   * overstated and a liability understated, in a way every report agrees with.
   */
  it('refuses when a tax component has no account', () => {
    const failure = codeOf(() => post(invoice(), { withoutTax: ['SGST'] }))
    expect(failure).toBe('ROLE_UNMAPPED')
  })

  it('names the component so the message can be acted on', () => {
    try {
      post(invoice(), { withoutTax: ['SGST'] })
      expect.unreachable('it should have refused')
    } catch (error) {
      expect(isPostingError(error)).toBe(true)
      expect((error as Error).message).toContain('SGST')
      expect((error as { details: Record<string, unknown> }).details).toMatchObject({
        componentCode: 'SGST',
        levy: 'output',
      })
    }
  })

  /* Only asked for when the document actually rounds, so books with no round-off account
   * can still issue every invoice that does not need one. */
  it('only needs round-off when there is rounding to post', () => {
    expect(() => post(invoice(), { without: ['round-off'] })).not.toThrow()
    expect(
      codeOf(() =>
        post(
          invoice({
            roundingPolicy: 'whole-unit',
            lines: [line({ lineNumber: 1, taxableAmount: D('1000.30') })],
          }),
          {
            without: ['round-off'],
          },
        ),
      ),
    ).toBe('ROLE_UNMAPPED')
  })

  /* Only asked for when a charge line has no account of its own. */
  it('only needs freight when a charge has no account named on it', () => {
    expect(() => post(invoice(), { without: ['freight-outward'] })).not.toThrow()
  })
})

describe('the narration', () => {
  it('says what the person who raised it wanted said', () => {
    expect(post(invoice({ narration: 'Against PO 4471' })).narration).toBe('Against PO 4471')
  })

  /* The number, because that is what somebody scanning a day book is looking for. */
  it('falls back to the invoice number when there is nothing to say', () => {
    expect(post(invoice()).narration).toBe('Sales invoice INV/2026-27/0001')
    expect(post(invoice({ narration: '   ' })).narration).toBe('Sales invoice INV/2026-27/0001')
  })
})

describe('purity', () => {
  /*
   * Same document, same context, same entry. This is what makes every test above a
   * statement about accounting rather than about a moment in time — and what would break
   * the instant somebody reached for a clock or an id generator in here.
   */
  it('gives the same entry twice', () => {
    const document = invoice({ roundingPolicy: 'whole-unit' })
    const first = post(document)
    const second = post(document)

    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('does not touch the document it was given', () => {
    const document = invoice()
    const before = JSON.stringify(document)
    post(document)

    expect(JSON.stringify(document)).toBe(before)
  })
})

/*
 * ---------------------------------------------------------------------------
 * THE OTHER THREE TREATMENTS
 *
 * The table in the header of ./posting.ts, as assertions. Every one of these is a
 * document written down beside the entry it must produce, and between them they pin all
 * four rows — which is what makes `controlIsDebit` and the three role records safe to
 * read as data rather than as four hand-written functions.
 *
 * The base document is the same 1000.00 of goods carrying 90.00 CGST and 90.00 SGST
 * throughout, so a figure appearing in the wrong place is visible by eye: 1180.00 is
 * always the control account, 1000.00 is always the value, 90.00 is always one tax.
 */

const KIND_RULES = {
  'sales-invoice': salesInvoiceRule,
  'credit-note': creditNoteRule,
  'purchase-bill': purchaseBillRule,
  'debit-note': debitNoteRule,
} as const

type PostingKind = keyof typeof KIND_RULES

const POSTING_KINDS = Object.keys(KIND_RULES) as PostingKind[]

function documentOf(kind: PostingKind, over: Partial<PostableDocument> = {}): PostableDocument {
  return invoice({ kind, number: `${kind}/0001`, ...over })
}

const postAs = (kind: PostingKind, document: PostableDocument, options?: ChartOptions) =>
  KIND_RULES[kind].toEntry(document, context(options))

/** What one account moved by under one kind, signed debit-minus-credit. */
function movedBy(kind: PostingKind, account: AccountRef, over: Partial<PostableDocument> = {}) {
  const entry = postAs(kind, documentOf(kind, over))
  return sum(
    entry.lines
      .filter((entryLine) => entryLine.accountId === account.id)
      .map((entryLine) => entryLine.debit.minus(entryLine.credit)),
  ).toString()
}

const account = (name: string): AccountRef => {
  const found = ACCOUNTS[name]
  if (found === undefined) throw new Error(`No fixture account '${name}'`)
  return found
}

describe('the four treatments', () => {
  /*
   * THE HEADER TABLE, COLUMN BY COLUMN. Signed figures rather than "is a debit", because
   * the sign and the magnitude are the two things that can each be wrong on their own:
   * a rule with the sides swapped still balances, and a rule taking the net total instead
   * of the grand total still faces the right way.
   */
  it('moves the party control account by the grand total, the correct way round', () => {
    expect(movedBy('sales-invoice', account('receivable'))).toBe('1180')
    expect(movedBy('credit-note', account('receivable'))).toBe('-1180')
    expect(movedBy('purchase-bill', account('payable'))).toBe('-1180')
    expect(movedBy('debit-note', account('payable'))).toBe('1180')
  })

  it('moves the value account by the taxable amount, the correct way round', () => {
    expect(movedBy('sales-invoice', account('sales'))).toBe('-1000')
    expect(movedBy('credit-note', account('salesReturns'))).toBe('1000')
    expect(movedBy('purchase-bill', account('purchases'))).toBe('1000')
    expect(movedBy('debit-note', account('purchaseReturns'))).toBe('-1000')
  })

  it('moves the tax account by the tax, the correct way round', () => {
    expect(movedBy('sales-invoice', account('cgst'))).toBe('-90')
    expect(movedBy('credit-note', account('cgst'))).toBe('90')
    expect(movedBy('purchase-bill', account('cgstIn'))).toBe('90')
    expect(movedBy('debit-note', account('cgstIn'))).toBe('-90')
  })

  /*
   * A RETURN IS A CONTRA ACCOUNT, NOT A NEGATIVE SALE. If a credit note debited `sales`
   * the profit would come out identical and turnover would be silently net of returns.
   * This is the assertion that says the two accounts are different on purpose.
   */
  it('keeps a return out of the account it is reducing', () => {
    expect(movedBy('credit-note', account('sales'))).toBe('0')
    expect(movedBy('debit-note', account('purchases'))).toBe('0')
  })

  /*
   * Input tax and output tax are opposite sides of the balance sheet, and a purchase that
   * reached for the output account would net a claim against a liability — the exact
   * thing `tax-accounts.ts` refuses to do, undone one layer up.
   */
  it('never posts a purchase to an output tax account, or a sale to an input one', () => {
    expect(movedBy('purchase-bill', account('cgst'))).toBe('0')
    expect(movedBy('debit-note', account('cgst'))).toBe('0')
    expect(movedBy('sales-invoice', account('cgstIn'))).toBe('0')
    expect(movedBy('credit-note', account('cgstIn'))).toBe('0')
  })

  it('balances for every kind that posts', () => {
    for (const kind of POSTING_KINDS) {
      const entry = postAs(kind, documentOf(kind))
      const debits = sum(entry.lines.map((entryLine) => entryLine.debit))
      const credits = sum(entry.lines.map((entryLine) => entryLine.credit))
      expect(`${kind} ${debits.toString()}/${credits.toString()}`).toBe(`${kind} 1180/1180`)
    }
  })

  /* The control line is the one that carries the party, on every kind — it is what makes
   * an aged report a grouping of the same rows the balance sheet totals. */
  it('carries the party on the control line and on no other', () => {
    for (const kind of POSTING_KINDS) {
      const withParty = postAs(kind, documentOf(kind)).lines.filter(
        (entryLine) => entryLine.partyId !== undefined,
      )
      expect(withParty).toHaveLength(1)
      expect(withParty[0]?.partyId).toBe('party-1')
      expect(withParty[0]?.debit.plus(withParty[0].credit).toString()).toBe('1180')
    }
  })

  it('records each entry as its own source document, with its own number', () => {
    for (const kind of POSTING_KINDS) {
      expect(postAs(kind, documentOf(kind)).source).toEqual({
        type: kind,
        id: 'd-1',
        number: `${kind}/0001`,
      })
    }
  })

  /* The day book says what it is. A ledger full of lines reading "Sales invoice" against
   * a purchase would be wrong in the one place a person actually reads. */
  it('narrates with the label of the kind that posted it', () => {
    expect(postAs('credit-note', documentOf('credit-note')).narration).toBe(
      'Credit note credit-note/0001',
    )
    expect(postAs('purchase-bill', documentOf('purchase-bill')).narration).toBe(
      'Purchase bill purchase-bill/0001',
    )
    expect(postAs('debit-note', documentOf('debit-note')).narration).toBe(
      'Debit note debit-note/0001',
    )
  })

  it('still prefers the narration the user wrote', () => {
    const document = documentOf('purchase-bill', { narration: 'Bearings for the March order' })
    expect(postAs('purchase-bill', document).narration).toBe('Bearings for the March order')
  })
})

describe('charges, on each side of the trade', () => {
  const withFreight = (kind: PostingKind) =>
    documentOf(kind, {
      lines: [
        line({ lineNumber: 1 }),
        line({
          lineNumber: 2,
          description: 'Carriage',
          isCharge: true,
          taxableAmount: D('100.00'),
          taxes: [tax('CGST', '9', '9.00'), tax('SGST', '9', '9.00')],
        }),
      ],
    })

  const accountsTouched = (kind: PostingKind) =>
    postAs(kind, withFreight(kind)).lines.map((entryLine) => entryLine.accountId)

  /*
   * NOT A MIRROR, AND THAT IS THE POINT. Outward freight is a selling cost being
   * recovered; inward freight is part of what the goods cost. The two roles differ
   * because the two facts differ — see the header of ./posting.ts.
   */
  it('sends a sales charge to freight outward and a purchase charge to freight inward', () => {
    expect(accountsTouched('sales-invoice')).toContain(account('freight').id)
    expect(accountsTouched('sales-invoice')).not.toContain(account('freightIn').id)
    expect(accountsTouched('purchase-bill')).toContain(account('freightIn').id)
    expect(accountsTouched('purchase-bill')).not.toContain(account('freight').id)
  })

  /* A charge on a credit note is the same freight the invoice charged, coming back out
   * of the same account. Keyed by side alone for exactly this reason. */
  it('reverses a charge out of the account it went into', () => {
    const note = postAs('credit-note', withFreight('credit-note'))
    const freight = note.lines.find((entryLine) => entryLine.accountId === account('freight').id)

    expect(freight?.debit.toString()).toBe('100')
    expect(freight?.credit.toString()).toBe('0')
  })

  it('refuses a purchase charge when nothing is mapped to freight inward', () => {
    expect(
      codeOf(() =>
        postAs('purchase-bill', withFreight('purchase-bill'), { without: ['freight-inward'] }),
      ),
    ).toBe('ROLE_UNMAPPED')
  })

  it('refuses a purchase bill when nothing is mapped to payables', () => {
    expect(
      codeOf(() =>
        postAs('purchase-bill', documentOf('purchase-bill'), { without: ['accounts-payable'] }),
      ),
    ).toBe('ROLE_UNMAPPED')
  })

  /* The sentence names the side the tax was on. "Collected on sales" against a supplier
   * bill sends the reader to the wrong half of their chart. */
  it('names the input side when a purchase has no tax account', () => {
    let message = ''
    try {
      postAs('purchase-bill', documentOf('purchase-bill'), { withoutTax: ['CGST'] })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('CGST paid on purchases')
    /* A tax account is found by its role, and no screen maps one. Sending somebody to add
     * an account under a group would leave the refusal exactly where it was. */
    expect(message).not.toContain('Add one under')
    expect(message).toContain('please report this')
  })
})

describe('rounding, on a document that faces the other way', () => {
  /*
   * `roundOff` is signed so that adding it to the net total gives the grand total, which
   * means it belongs opposite the control line whichever way that faces. On a purchase
   * bill the control line is a CREDIT, so a positive round-off is a DEBIT — the mirror of
   * the sales case, and the one a rule written by copying the sales rule gets wrong.
   */
  const rounded = (kind: PostingKind, taxable: string, gst: string) =>
    documentOf(kind, {
      roundingPolicy: 'whole-unit',
      lines: [line({ lineNumber: 1, taxableAmount: D(taxable), taxes: [tax('CGST', '9', gst)] })],
    })

  const roundOffLine = (kind: PostingKind, taxable: string, gst: string) =>
    postAs(kind, rounded(kind, taxable, gst)).lines.find(
      (entryLine) => entryLine.accountId === account('roundOff').id,
    )

  /*
   * BOTH DIRECTIONS, because a positive round-off and a negative one are separate
   * arms of the same fold and either can be wrong alone. 1090.44 rounds DOWN, so the
   * sale gives up 0.44 and debits it; 1090.66 rounds UP, so the sale gains 0.34 and
   * credits it. The bill mirrors each.
   */
  it('mirrors a rounding loss across the two sides of the trade', () => {
    const sale = roundOffLine('sales-invoice', '1000.40', '90.04')
    const bill = roundOffLine('purchase-bill', '1000.40', '90.04')

    expect(sale?.debit.toString()).toBe('0.44')
    expect(sale?.credit.toString()).toBe('0')
    expect(bill?.credit.toString()).toBe('0.44')
    expect(bill?.debit.toString()).toBe('0')
  })

  it('mirrors a rounding gain across the two sides of the trade', () => {
    const sale = roundOffLine('sales-invoice', '1000.60', '90.06')
    const bill = roundOffLine('purchase-bill', '1000.60', '90.06')

    expect(sale?.credit.toString()).toBe('0.34')
    expect(sale?.debit.toString()).toBe('0')
    expect(bill?.debit.toString()).toBe('0.34')
    expect(bill?.credit.toString()).toBe('0')
  })

  it('still balances once rounded, on both sides and in both directions', () => {
    for (const kind of ['sales-invoice', 'purchase-bill'] as const) {
      for (const [taxable, gst] of [
        ['1000.40', '90.04'],
        ['1000.60', '90.06'],
      ]) {
        const entry = postAs(kind, rounded(kind, taxable!, gst!))
        expect(sum(entry.lines.map((entryLine) => entryLine.debit)).toString()).toBe(
          sum(entry.lines.map((entryLine) => entryLine.credit)).toString(),
        )
      }
    }
  })
})

describe('a document whose total comes out negative', () => {
  /*
   * A rebate line larger than the goods line it corrects. The control account has to move
   * the OTHER way, as a credit of the magnitude — never as a debit of minus something,
   * which invariant 5 calls ambiguous and refuses. Folded in one place, `place`, so it
   * cannot be right for the buckets and wrong for the control line.
   */
  const upsideDown = () =>
    documentOf('sales-invoice', {
      lines: [
        line({ lineNumber: 1, taxableAmount: D('100.00'), taxes: [tax('CGST', '9', '9.00')] }),
        line({
          lineNumber: 2,
          description: 'Rebate',
          taxableAmount: D('-300.00'),
          taxes: [tax('CGST', '9', '-27.00')],
        }),
      ],
    })

  it('credits the control account rather than debiting a negative figure', () => {
    const control = postAs('sales-invoice', upsideDown()).lines.find(
      (entryLine) => entryLine.accountId === account('receivable').id,
    )

    expect(control?.debit.toString()).toBe('0')
    expect(control?.credit.toString()).toBe('218')
  })

  it('leaves no line that is neither a debit nor a credit', () => {
    for (const entryLine of postAs('sales-invoice', upsideDown()).lines) {
      expect(entryLine.debit.isZero() && entryLine.credit.isZero()).toBe(false)
    }
  })
})

describe('a rule given the wrong kind', () => {
  /*
   * A plain Error, not a `PostingError`. No `LedgerErrorCode` says "the wrong rule was
   * called" — it is a wiring mistake nobody can act on and no UI should offer to fix.
   * It matters more with four rules than it did with one: they all take the same shape of
   * document, and a purchase posted by the sales rule would balance perfectly.
   */
  it('refuses, and says which rule got what', () => {
    expect(
      codeOf(() => salesInvoiceRule.toEntry(documentOf('purchase-bill'), context())),
    ).toContain('not a PostingError')
  })

  it('names the rule and the document it was handed', () => {
    let message = ''
    try {
      salesInvoiceRule.toEntry(documentOf('purchase-bill'), context())
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('sales invoice posting rule was given a purchase bill')
  })

  /* Each of the four refuses each of the other three, rather than one example standing
   * in for twelve. A factory that closed over the wrong definition would post happily. */
  it('refuses every kind but its own, on all four rules', () => {
    for (const ruleKind of POSTING_KINDS) {
      for (const documentKind of POSTING_KINDS) {
        const run = () => KIND_RULES[ruleKind].toEntry(documentOf(documentKind), context())
        if (ruleKind === documentKind) {
          expect(run).not.toThrow()
        } else {
          expect(run).toThrow(/posting rule was given a/)
        }
      }
    }
  })
})

describe('controlRoleFor', () => {
  /*
   * The aged report resolves the account it decomposes through this, so the two rows are
   * pinned BY VALUE rather than by asking the table twice. Swapping them would send every
   * customer's balance to the payables report and nothing else would notice: both answers
   * are valid roles, both resolve to a real account, and both produce a page that ties —
   * to the wrong account.
   */
  it('names the account each side moves', () => {
    expect(controlRoleFor('sales')).toBe('accounts-receivable')
    expect(controlRoleFor('purchase')).toBe('accounts-payable')
  })

  it('agrees with the account the posting rule actually debits', () => {
    const entry = salesInvoiceRule.toEntry(documentOf('sales-invoice'), context())
    const control = entry.lines.find((line) => line.partyId !== null)

    expect(control?.accountId).toBe(ACCOUNTS['receivable']?.id)
  })
})

// ---- The two facts about a supply that are not the tax ----------------------

/** What one account moved by on a document of a stated kind, signed debit-minus-credit. */
function movedOn(kind: PostingKind, document: PostableDocument, name: string): string {
  const entry = postAs(kind, document)
  return sum(
    entry.lines
      .filter((entryLine) => entryLine.accountId === account(name).id)
      .map((entryLine) => entryLine.debit.minus(entryLine.credit)),
  ).toString()
}

function totalsOf(entry: { lines: readonly { debit: Decimal; credit: Decimal }[] }) {
  return {
    debit: sum(entry.lines.map((line) => line.debit)).toString(),
    credit: sum(entry.lines.map((line) => line.credit)).toString(),
  }
}

describe('reverse charge — two postings from one bill, and only on one side', () => {
  /*
   * ON THE PURCHASE SIDE THIS BUSINESS IS THE RECIPIENT. It OWES the output tax to the
   * authority and it MAY CLAIM the same figure as input credit, so the tax lands on both
   * sides of the balance sheet and nets to nothing in profit — which is what a reverse
   * charge does. And the supplier is credited with the VALUE only, because the tax never
   * passes through them.
   */
  it('makes a purchase bill owe the tax and claim it, and pays the supplier the net', () => {
    const bill = documentOf('purchase-bill', { isReverseCharge: true })

    expect(movedOn('purchase-bill', bill, 'payable')).toBe('-1000')
    expect(movedOn('purchase-bill', bill, 'purchases')).toBe('1000')
    /* Claimed. */
    expect(movedOn('purchase-bill', bill, 'cgstIn')).toBe('90')
    expect(movedOn('purchase-bill', bill, 'sgstIn')).toBe('90')
    /* Owed. */
    expect(movedOn('purchase-bill', bill, 'cgst')).toBe('-90')
    expect(movedOn('purchase-bill', bill, 'sgst')).toBe('-90')

    expect(totalsOf(postAs('purchase-bill', bill))).toEqual({ debit: '1180', credit: '1180' })
  })

  /*
   * ON THE SALES SIDE IT IS NOT THE MIRROR. This business supplies and the CUSTOMER
   * discharges, so no figure on the document is this business's liability and no tax posts
   * at all. The value is still turnover — the supply happened.
   */
  it('makes a sales invoice carry the value and no tax whatever', () => {
    const document = documentOf('sales-invoice', { isReverseCharge: true })

    expect(movedOn('sales-invoice', document, 'receivable')).toBe('1000')
    expect(movedOn('sales-invoice', document, 'sales')).toBe('-1000')
    expect(movedOn('sales-invoice', document, 'cgst')).toBe('0')
    expect(movedOn('sales-invoice', document, 'sgst')).toBe('0')

    const entry = postAs('sales-invoice', document)
    expect(totalsOf(entry)).toEqual({ debit: '1000', credit: '1000' })
    /* And there is no tax LINE at all rather than a line of zero — invariant 5 refuses
     * one, so a rule that posted zeroes would fail at the repository instead of here. */
    expect(entry.lines).toHaveLength(2)
  })

  it('reverses both legs on a debit note, so a correction unwinds what the bill did', () => {
    const note = documentOf('debit-note', { isReverseCharge: true })

    expect(movedOn('debit-note', note, 'payable')).toBe('1000')
    expect(movedOn('debit-note', note, 'cgstIn')).toBe('-90')
    expect(movedOn('debit-note', note, 'cgst')).toBe('90')
  })

  it('changes nothing at all when the flag is false', () => {
    for (const kind of POSTING_KINDS) {
      expect(postAs(kind, documentOf(kind, { isReverseCharge: false })), kind).toEqual(
        postAs(kind, documentOf(kind)),
      )
    }
  })

  /*
   * THE CONTROL AMOUNT IS THE GRAND TOTAL LESS THE TAX, WHICH INCLUDES THE ROUNDING. A
   * rule that took the net total instead would be right on an unrounded document and out
   * by the round-off on a rounded one, which is the paisa nobody can find.
   */
  it('still carries the rounding on a reverse-charge document', () => {
    const rounded = documentOf('purchase-bill', {
      isReverseCharge: true,
      roundingPolicy: 'whole-unit',
      lines: [
        line({
          lineNumber: 1,
          taxableAmount: D('1000.40'),
          taxes: [tax('CGST', '9', '90.04'), tax('SGST', '9', '90.04')],
        }),
      ],
    })

    /* 1000.40 + 180.08 is 1180.48, rounded to 1180.00, so the round-off is -0.48 and the
     * payable takes 1180.00 - 180.08 = 999.92. */
    expect(movedOn('purchase-bill', rounded, 'payable')).toBe('-999.92')
    expect(movedOn('purchase-bill', rounded, 'roundOff')).toBe('-0.48')
    const totals = totalsOf(postAs('purchase-bill', rounded))
    expect(totals.debit).toBe(totals.credit)
  })
})

describe('input tax credit eligibility, on the line', () => {
  const blocked = (eligibility: 'ineligible-17-5' | 'ineligible-other') =>
    documentOf('purchase-bill', { lines: [line({ lineNumber: 1, itcEligibility: eligibility })] })

  /*
   * BLOCKED INPUT TAX IS NOT AN ASSET. Input tax reaches the input tax account because it
   * is RECOVERABLE; where credit is blocked it is not, and an account holding it is an
   * asset the business will never realise. It is part of what the thing cost, so it joins
   * the line's own value account.
   */
  for (const eligibility of ['ineligible-17-5', 'ineligible-other'] as const) {
    it(`costs a ${eligibility} line's tax into the expense instead of the asset`, () => {
      const document = blocked(eligibility)

      expect(movedOn('purchase-bill', document, 'cgstIn')).toBe('0')
      expect(movedOn('purchase-bill', document, 'sgstIn')).toBe('0')
      /* 1000 of goods plus 180 of tax nobody can reclaim. */
      expect(movedOn('purchase-bill', document, 'purchases')).toBe('1180')
      expect(movedOn('purchase-bill', document, 'payable')).toBe('-1180')
    })
  }

  it('leaves an eligible line, and a line that says nothing, exactly as they were', () => {
    const stated = documentOf('purchase-bill', {
      lines: [line({ lineNumber: 1, itcEligibility: 'eligible' })],
    })

    expect(postAs('purchase-bill', stated)).toEqual(
      postAs('purchase-bill', documentOf('purchase-bill')),
    )
    expect(movedOn('purchase-bill', stated, 'cgstIn')).toBe('90')
  })

  /*
   * ONE BILL, TWO LINES, TWO ANSWERS — the whole reason the column is on the LINE, and the
   * case a document-level field could not express without the user splitting a real bill
   * into two documents.
   */
  it('splits one bill between the asset and the expense, line by line', () => {
    const mixed = documentOf('purchase-bill', {
      lines: [
        line({ lineNumber: 1, description: 'Laptop', itcEligibility: 'eligible' }),
        line({ lineNumber: 2, description: 'Staff car', itcEligibility: 'ineligible-17-5' }),
      ],
    })

    expect(movedOn('purchase-bill', mixed, 'cgstIn')).toBe('90')
    expect(movedOn('purchase-bill', mixed, 'sgstIn')).toBe('90')
    /* 1000 for the laptop, 1180 for the car. */
    expect(movedOn('purchase-bill', mixed, 'purchases')).toBe('2180')
    expect(movedOn('purchase-bill', mixed, 'payable')).toBe('-2360')
  })

  it('sends a blocked line’s tax to the account the LINE names, not the kind’s default', () => {
    const named = documentOf('purchase-bill', {
      lines: [
        line({
          lineNumber: 1,
          accountId: account('freightIn').id,
          itcEligibility: 'ineligible-other',
        }),
      ],
    })

    expect(movedOn('purchase-bill', named, 'freightIn')).toBe('1180')
    expect(movedOn('purchase-bill', named, 'purchases')).toBe('0')
  })

  /*
   * A SALES DOCUMENT NEVER CONSULTS IT. The levy is output tax, which is owed rather than
   * reclaimed, so no eligibility rule can touch it — and a value on a sales line (which
   * the repository refuses and the database does not) changes nothing here.
   */
  it('is ignored on a sales document, whatever it says', () => {
    const invoiceLine = documentOf('sales-invoice', {
      lines: [line({ lineNumber: 1, itcEligibility: 'ineligible-17-5' })],
    })

    expect(movedOn('sales-invoice', invoiceLine, 'cgst')).toBe('-90')
    expect(movedOn('sales-invoice', invoiceLine, 'sales')).toBe('-1000')
  })

  /*
   * BLOCKED AND UNDER REVERSE CHARGE AT ONCE, which is the interaction and is not a corner
   * case: an imported service on which credit is blocked is an ordinary bill. The output
   * tax is still OWED — no eligibility rule touches a liability to the authority — and the
   * input leg is costed in rather than claimed, so the tax stops netting to nothing and
   * becomes a real cost. Which is precisely what a blocked credit means.
   */
  it('still owes the tax on a blocked reverse-charge bill, and costs the credit in', () => {
    const document = documentOf('purchase-bill', {
      isReverseCharge: true,
      lines: [line({ lineNumber: 1, itcEligibility: 'ineligible-17-5' })],
    })

    expect(movedOn('purchase-bill', document, 'cgst')).toBe('-90')
    expect(movedOn('purchase-bill', document, 'sgst')).toBe('-90')
    expect(movedOn('purchase-bill', document, 'cgstIn')).toBe('0')
    expect(movedOn('purchase-bill', document, 'purchases')).toBe('1180')
    /* The supplier is paid the value only; the 180 owed is a separate liability. */
    expect(movedOn('purchase-bill', document, 'payable')).toBe('-1000')
  })
})
