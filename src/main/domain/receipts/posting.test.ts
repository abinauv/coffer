/*
 * The receipt and payment posting rules.
 *
 * Pure, so each test is a receipt written down beside the entry it must produce. The
 * properties the assertions exist for:
 *
 *   - the entry balances, both ways round;
 *   - the control account moves by exactly what the receipt says;
 *   - the party's id is on the control line AND ON NO OTHER, which is what `outstanding`
 *     depends on and the only thing in here that is easy to break without noticing;
 *   - the bank account is the one the receipt names, never the one a role points at.
 */

import { describe, expect, it } from 'vitest'

import { D, ZERO, type Decimal } from '@main/domain/money'
import {
  isPostingError,
  type AccountRef,
  type AccountResolver,
  type PostingContext,
} from '@main/domain/ledger'

import {
  paymentRule,
  receiptPostingRuleFor,
  receiptRule,
  refundReceivedRule,
  refundRule,
} from './posting'
import { RECEIPT_KINDS, type PostableReceipt, type ReceiptKind } from './types'

const ACCOUNTS: Record<string, AccountRef> = {
  receivable: { id: 'a-recv', code: '1300', name: 'Accounts Receivable', type: 'asset' },
  payable: { id: 'a-pay', code: '2100', name: 'Accounts Payable', type: 'liability' },
  /* Two banks, because one is what makes the "chosen, not derived" rule testable. */
  bank: { id: 'a-bank', code: '1210', name: 'Bank Account', type: 'asset' },
  otherBank: { id: 'a-bank-2', code: '1211', name: 'Second Bank', type: 'asset' },
  cash: { id: 'a-cash', code: '1100', name: 'Cash in Hand', type: 'asset' },
}

function resolver(without: readonly string[] = []): AccountResolver {
  const roles: Record<string, AccountRef | undefined> = {
    'accounts-receivable': ACCOUNTS['receivable'],
    'accounts-payable': ACCOUNTS['payable'],
    /* Mapped, and every test below proves the rules do not read it. */
    bank: ACCOUNTS['bank'],
    cash: ACCOUNTS['cash'],
  }
  const byId = new Map(Object.values(ACCOUNTS).map((account) => [account.id, account]))

  return {
    byId: (id) => byId.get(id) ?? null,
    byCode: (code) => Object.values(ACCOUNTS).find((account) => account.code === code) ?? null,
    forRole: (role) => (without.includes(role) ? null : (roles[role] ?? null)),
    forTaxComponent: () => null,
  }
}

function context(without: readonly string[] = []): PostingContext {
  return {
    accounts: resolver(without),
    period: {
      id: 'p-1',
      fiscalYearLabel: '2026-27',
      index: 1,
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      status: 'open',
    },
    homeJurisdictionCode: null,
  }
}

function receipt(over: Partial<PostableReceipt> = {}): PostableReceipt {
  return {
    id: 'r-1',
    kind: 'receipt',
    number: 'RCT/2026-27/0001',
    date: '2026-04-20',
    partyId: 'party-1',
    amount: D('11800.00'),
    accountId: ACCOUNTS['bank']!.id,
    reference: 'UTR12345',
    narration: '',
    ...over,
  }
}

const totalOf = (values: readonly Decimal[]): Decimal =>
  values.reduce<Decimal>((total, value) => total.plus(value), ZERO)

describe('a receipt', () => {
  it('debits the bank and credits receivables, carrying the customer', () => {
    const entry = receiptRule.toEntry(receipt(), context())

    expect(entry.lines).toEqual([
      { accountId: 'a-bank', debit: D('11800.00'), credit: ZERO },
      {
        accountId: 'a-recv',
        debit: ZERO,
        credit: D('11800.00'),
        partyId: 'party-1',
      },
    ])
  })

  it('balances', () => {
    const entry = receiptRule.toEntry(receipt(), context())
    expect(
      totalOf(entry.lines.map((line) => line.debit)).equals(
        totalOf(entry.lines.map((line) => line.credit)),
      ),
    ).toBe(true)
  })

  /*
   * The property `outstanding` is built on. If the bank line ever grew a party id, a
   * customer's balance would count the money twice — once on the control account and once
   * on a bank account that is nobody's — and the aged report would silently halve.
   */
  it('names the party on the control line and on no other', () => {
    const entry = receiptRule.toEntry(receipt(), context())
    const named = entry.lines.filter((line) => line.partyId !== undefined)

    expect(named).toHaveLength(1)
    expect(named[0]?.accountId).toBe('a-recv')
  })

  it('posts as of the receipt date, not any other', () => {
    expect(receiptRule.toEntry(receipt({ date: '2026-05-02' }), context()).date).toBe('2026-05-02')
  })

  it('carries its own number back to the ledger for the drill-through', () => {
    expect(receiptRule.toEntry(receipt(), context()).source).toEqual({
      type: 'receipt',
      id: 'r-1',
      number: 'RCT/2026-27/0001',
    })
  })
})

describe('a payment', () => {
  const outgoing = () =>
    receipt({ kind: 'payment', number: 'PAY/2026-27/0001', amount: D('4500.00') })

  it('debits payables and credits the bank, the debit first', () => {
    const entry = paymentRule.toEntry(outgoing(), context())

    expect(entry.lines).toEqual([
      {
        accountId: 'a-pay',
        debit: D('4500.00'),
        credit: ZERO,
        partyId: 'party-1',
      },
      { accountId: 'a-bank', debit: ZERO, credit: D('4500.00') },
    ])
  })

  it('names the vendor on the control line and on no other', () => {
    const named = paymentRule
      .toEntry(outgoing(), context())
      .lines.filter((line) => line.partyId !== undefined)

    expect(named).toHaveLength(1)
    expect(named[0]?.accountId).toBe('a-pay')
  })

  it('records itself as a payment', () => {
    expect(paymentRule.toEntry(outgoing(), context()).source.type).toBe('payment')
  })
})

describe('a refund', () => {
  const back = () => receipt({ kind: 'refund', number: 'REF/2026-27/0001', amount: D('900.00') })

  /*
   * THE ASSERTION THE KIND EXISTS FOR, and the one a payment cannot be made to satisfy. A
   * refund is money OUT like a payment and it moves RECEIVABLES like a receipt — the two
   * facts a single `kind ===` test can never hold at once, which is why the rule reads
   * `direction` for the sides and `controlRole` for the account.
   */
  it('debits receivables and credits the bank, the debit first', () => {
    const entry = refundRule.toEntry(back(), context())

    expect(entry.lines).toEqual([
      { accountId: 'a-recv', debit: D('900.00'), credit: ZERO, partyId: 'party-1' },
      { accountId: 'a-bank', debit: ZERO, credit: D('900.00') },
    ])
  })

  /* The exact mirror of a receipt on the same account, which is what makes an allocation
   * between the two mean anything: one puts money on receivables and the other takes it
   * off, and 0015's trigger is that sentence as a constraint. */
  it('moves the same account a receipt moves, the other way', () => {
    const taken = receiptRule.toEntry(receipt({ amount: D('900.00') }), context())
    const given = refundRule.toEntry(back(), context())

    const takenControl = taken.lines.find((line) => line.accountId === 'a-recv')
    const givenControl = given.lines.find((line) => line.accountId === 'a-recv')

    expect(takenControl).toMatchObject({ debit: ZERO, credit: D('900.00') })
    expect(givenControl).toMatchObject({ debit: D('900.00'), credit: ZERO })
  })

  it('names the customer on the control line and on no other', () => {
    const named = refundRule
      .toEntry(back(), context())
      .lines.filter((line) => line.partyId !== undefined)

    expect(named).toHaveLength(1)
    expect(named[0]?.accountId).toBe('a-recv')
  })

  it('records itself as a refund rather than as a payment', () => {
    expect(refundRule.toEntry(back(), context()).source.type).toBe('refund')
  })

  /* And the purchase-side mirror: money IN that moves payables, which is the corner of
   * the square a vendor refunding us falls in. */
  it('has a mirror that credits payables and debits the bank', () => {
    const entry = refundReceivedRule.toEntry(
      receipt({ kind: 'refund-received', number: 'RRV/2026-27/0001', amount: D('900.00') }),
      context(),
    )

    expect(entry.lines).toEqual([
      { accountId: 'a-bank', debit: D('900.00'), credit: ZERO },
      { accountId: 'a-pay', debit: ZERO, credit: D('900.00'), partyId: 'party-1' },
    ])
  })
})

describe('the rule a kind is routed to', () => {
  /*
   * A TERNARY UNTIL 0015 — `kind === 'receipt' ? receiptRule : paymentRule` — and correct
   * for exactly as long as there were two kinds. With four it would have handed both
   * refunds to the payment rule, posting a customer's refund to accounts payable where no
   * statement of theirs would ever have shown it.
   *
   * Nothing caught it except the rule's OWN kind guard, which throws a plain Error about
   * wiring rather than anything a user could act on — so this asserts the routing itself,
   * not that the wrong route complains.
   */
  it('gives every kind its own rule, and no two kinds the same one', () => {
    const sources = RECEIPT_KINDS.map((definition) => receiptPostingRuleFor(definition.kind).source)

    expect(new Set(sources).size).toBe(sources.length)
    expect(sources).toEqual(RECEIPT_KINDS.map((definition) => definition.kind))
  })

  it('routes each kind to a rule that accepts it', () => {
    for (const definition of RECEIPT_KINDS) {
      const rule = receiptPostingRuleFor(definition.kind)
      expect(() => rule.toEntry(receipt({ kind: definition.kind }), context())).not.toThrow()
    }
  })

  /* A kind off a company file a newer build wrote gets the sentence written for it,
   * rather than an index answering undefined and a TypeError naming neither the kind nor
   * the file. The same two lines `receiptTreatmentOf` is. */
  it('refuses a kind this build does not know', () => {
    expect(() => receiptPostingRuleFor('advance' as ReceiptKind)).toThrow(/newer Coffer/)
  })
})

describe('the money account', () => {
  /*
   * The rule that stops every receipt landing in one bank. A business has one cash
   * account and several banks; `account_roles` holds one of each, so a rule reading the
   * role would post everything to whichever one it points at — and no report would look
   * wrong until somebody reconciled a statement.
   */
  it('is the one the receipt names, not the one the bank role points at', () => {
    const entry = receiptRule.toEntry(receipt({ accountId: ACCOUNTS['otherBank']!.id }), context())
    expect(entry.lines[0]?.accountId).toBe('a-bank-2')
  })

  it('still posts when no bank or cash role is mapped at all', () => {
    expect(() => receiptRule.toEntry(receipt(), context(['bank', 'cash']))).not.toThrow()
  })

  it('is refused when it is not in the chart', () => {
    try {
      receiptRule.toEntry(receipt({ accountId: 'a-gone' }), context())
      expect.unreachable('a missing account should be refused')
    } catch (error) {
      expect(isPostingError(error)).toBe(true)
      if (isPostingError(error)) {
        expect(error.code).toBe('ACCOUNT_NOT_FOUND')
        expect(error.details).toMatchObject({ accountId: 'a-gone' })
        /* The sentence as well as the code. A user whose bank account was deleted needs
         * to be told to point the receipt at another one, and a code alone says nothing
         * they can act on (CONVENTIONS §5). */
        expect(error.message).toMatch(/Point it at another one/)
      }
    }
  })
})

describe('what the rules refuse', () => {
  it('refuses to post when the control role is unmapped', () => {
    for (const [kind, role] of [
      ['receipt', 'accounts-receivable'],
      ['payment', 'accounts-payable'],
    ] as const) {
      try {
        receiptPostingRuleFor(kind).toEntry(receipt({ kind }), context([role]))
        expect.unreachable(`${kind} should not post without ${role}`)
      } catch (error) {
        expect(isPostingError(error)).toBe(true)
        if (isPostingError(error)) {
          expect(error.code).toBe('ROLE_UNMAPPED')
          expect(error.message).toContain(role)
        }
      }
    }
  })

  /*
   * A plain Error and not a `PostingError`, because no `LedgerErrorCode` says "the wrong
   * rule was called" — that is a wiring mistake nobody can act on and no screen should
   * offer to fix. Same line the sales invoice rule draws.
   */
  it('refuses a receipt handed to the payment rule, as a programmer error', () => {
    expect(() => paymentRule.toEntry(receipt(), context())).toThrow(/payment posting rule/)

    try {
      paymentRule.toEntry(receipt(), context())
    } catch (error) {
      expect(isPostingError(error)).toBe(false)
    }
  })
})

describe('receiptPostingRuleFor', () => {
  /*
   * Never null, where `postingRuleFor` in domain/documents can be. That difference is
   * the contract: every receipt kind posts, so a null would ask every caller to handle a
   * case the type system has already closed.
   */
  it('answers for every kind, and never with null', () => {
    for (const kind of ['receipt', 'payment'] as ReceiptKind[]) {
      const rule = receiptPostingRuleFor(kind)
      expect(rule).not.toBeNull()
      expect(rule.source).toBe(kind)
    }
  })
})

describe('the narration', () => {
  it('is the one the user wrote, when they wrote one', () => {
    expect(receiptRule.toEntry(receipt({ narration: 'Part payment' }), context()).narration).toBe(
      'Part payment',
    )
  })

  it('names the kind and the number when they did not', () => {
    expect(receiptRule.toEntry(receipt({ narration: '   ' }), context()).narration).toBe(
      'Receipt RCT/2026-27/0001',
    )
    expect(
      paymentRule.toEntry(
        receipt({ kind: 'payment', number: 'PAY/2026-27/0009', narration: '' }),
        context(),
      ).narration,
    ).toBe('Payment PAY/2026-27/0009')
  })
})
