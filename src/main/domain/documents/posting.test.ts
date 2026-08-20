/*
 * The sales invoice posting rule.
 *
 * These are the tests that catch a change in accounting treatment. The rule is pure, so
 * every one of them is a document written down beside the entry it must produce — no
 * database, no clock, and nothing to arrange except the chart.
 *
 * The properties worth stating, because they are what the assertions below are for:
 *
 *   - the entry balances, always, for every shape of document;
 *   - receivables moves by exactly what the invoice says at the bottom;
 *   - revenue moves by the taxable value and never by the tax;
 *   - the sum of the tax lines equals the sum of the printed tax summary, even though
 *     the two are grouped differently.
 */

import { describe, expect, it } from 'vitest'

import { D, ZERO, sum, type Decimal } from '@main/domain/money'
import type { AccountRef, AccountResolver, PostingContext } from '@main/domain/ledger'
import { isPostingError } from '@main/domain/ledger'

import { postingRuleFor, salesInvoiceRule, type PostableDocument } from './posting'
import { documentTotals } from './totals'
import { DOCUMENT_KINDS, postsToLedger, type DocumentLine, type DocumentLineTax } from './types'

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
  }
  const taxes: Record<string, AccountRef | undefined> = {
    CGST: ACCOUNTS['cgst'],
    SGST: ACCOUNTS['sgst'],
    IGST: ACCOUNTS['igst'],
  }
  const byId = new Map(Object.values(ACCOUNTS).map((account) => [account.id, account]))

  return {
    byId: (id) => byId.get(id) ?? null,
    byCode: (code) => Object.values(ACCOUNTS).find((account) => account.code === code) ?? null,
    forRole: (role) => (without.includes(role) ? null : (roles[role] ?? null)),
    forTaxComponent: (code, direction) => {
      if (direction !== 'output') return null
      return withoutTax.includes(code) ? null : (taxes[code] ?? null)
    },
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
 * WHICH KINDS HAVE A RULE. Two different nulls come back from here and the caller has to
 * tell them apart — a quotation has no rule because it never posts, a credit note has no
 * rule because nobody has written it yet. `postsToLedger` is the fact that separates
 * them, and the repository says different sentences for each.
 */
describe('postingRuleFor', () => {
  it('gives the sales rule for a sales invoice', () => {
    expect(postingRuleFor('sales-invoice')).toBe(salesInvoiceRule)
  })

  it('gives nothing for a kind whose rule is not written yet', () => {
    expect(postingRuleFor('credit-note')).toBeNull()
    expect(postingRuleFor('purchase-bill')).toBeNull()
    expect(postingRuleFor('debit-note')).toBeNull()
  })

  it('gives nothing for a quotation, which never posts at all', () => {
    expect(postingRuleFor('quotation')).toBeNull()
    expect(postsToLedger('quotation')).toBe(false)
  })

  /* A rule that exists posts what its kind says it posts. The day a second rule is
   * written, this is what catches it being registered under the wrong kind — which
   * would put a purchase in the sales register and balance perfectly. */
  it('never returns a rule whose source disagrees with the kind it was asked for', () => {
    for (const definition of DOCUMENT_KINDS) {
      const rule = postingRuleFor(definition.kind)
      if (rule !== null) {
        expect(rule.source).toBe(definition.sourceType)
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
