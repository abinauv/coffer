import { describe, expect, it } from 'vitest'
import type { BadgeTone } from '@renderer/components/atoms'
import type { NumberFormat, PeriodStatus } from '@shared/dto'
import {
  accountTypeLabel,
  accountTypeRank,
  formatAmount,
  formatAmountOrBlank,
  groupDigits,
  isNegativeAmount,
  isZeroAmount,
  periodStatusLabel,
  periodStatusTone,
} from './ledger-format'

/*
 * THREE RULES, AND THE SECOND TWO ARE WHY THIS FILE CHANGED.
 *
 * Until 2.2e-2 the grouping was the Indian one, hard-coded, and every assertion below
 * read `12,34,567` because that was the only answer the code could give. A suite in which
 * the wrong answer is unrepresentable proves nothing about the right one, so the same
 * figures are now asserted under all three rules — and Portugal is the case that catches
 * a separator hard-coded to a comma, because it swaps both of them.
 */
const INDIA: NumberFormat = {
  groupSizes: [3, 2],
  decimalSeparator: '.',
  groupSeparator: ',',
  currencyCode: 'INR',
  currencySymbol: '₹',
}

const BRITAIN: NumberFormat = {
  groupSizes: [3],
  decimalSeparator: '.',
  groupSeparator: ',',
  currencyCode: 'GBP',
  currencySymbol: '£',
}

/** Both separators are the other way round, which is the interesting case. */
const PORTUGAL: NumberFormat = {
  groupSizes: [3],
  decimalSeparator: ',',
  groupSeparator: '.',
  currencyCode: 'EUR',
  currencySymbol: '€',
}

describe('groupDigits', () => {
  it('groups the last three, then twos, when the rule says so', () => {
    expect(groupDigits('1234567', INDIA)).toBe('12,34,567')
    expect(groupDigits('123456789', INDIA)).toBe('12,34,56,789')
  })

  it('repeats the last size, so [3] is plain thousands', () => {
    expect(groupDigits('1234567', BRITAIN)).toBe('1,234,567')
    expect(groupDigits('123456789', BRITAIN)).toBe('123,456,789')
  })

  it('uses the separator the rule names', () => {
    expect(groupDigits('1234567', PORTUGAL)).toBe('1.234.567')
  })

  it('leaves short runs alone', () => {
    expect(groupDigits('1', INDIA)).toBe('1')
    expect(groupDigits('123', INDIA)).toBe('123')
    expect(groupDigits('123', BRITAIN)).toBe('123')
  })

  it('handles the boundary where the first group is a single digit', () => {
    expect(groupDigits('1234', INDIA)).toBe('1,234')
    expect(groupDigits('12345', INDIA)).toBe('12,345')
    expect(groupDigits('123456', INDIA)).toBe('1,23,456')
    expect(groupDigits('1234', BRITAIN)).toBe('1,234')
  })

  /*
   * A malformed rule must not take the window with it — and WHICH rule is malformed was
   * measured rather than guessed. The first version of this test used `[0]` and passed
   * against a formatter with no guard at all, because `slice(0, -0)` is `''` and the
   * loop drains normally. A NEGATIVE size is the one that hangs: the remainder never
   * shrinks and the render never returns.
   *
   * The rule arrives from main, over IPC, out of a compliance pack Phase 5 loads at
   * runtime. Ungrouped is the right answer to all of these; hanging is not.
   */
  it('does not spin on a rule that cannot be grouped by', () => {
    const negative: NumberFormat = { ...BRITAIN, groupSizes: [-2] }
    expect(groupDigits('1234567', negative)).toBe('1234567')

    const zero: NumberFormat = { ...BRITAIN, groupSizes: [0] }
    expect(groupDigits('1234567', zero)).toBe('1234567')

    const empty: NumberFormat = { ...BRITAIN, groupSizes: [] }
    expect(groupDigits('1234567', empty)).toBe('1234567')
  })
})

describe('formatAmount', () => {
  it('always shows two places', () => {
    expect(formatAmount('1000', INDIA)).toBe('1,000.00')
    expect(formatAmount('1000.5', INDIA)).toBe('1,000.50')
    expect(formatAmount('0.00', INDIA)).toBe('0.00')
  })

  it('keeps the sign in front of the grouping', () => {
    expect(formatAmount('-1234567.89', INDIA)).toBe('-12,34,567.89')
  })

  /* THE ASSERTION THIS BATCH EXISTS FOR: one figure, three regimes, three answers. */
  it('writes the same amount the way each regime writes it', () => {
    expect(formatAmount('1234567.89', INDIA)).toBe('12,34,567.89')
    expect(formatAmount('1234567.89', BRITAIN)).toBe('1,234,567.89')
    expect(formatAmount('1234567.89', PORTUGAL)).toBe('1.234.567,89')
  })

  /* The minus stays ASCII whatever the regime does with the separators — lib/figures.ts
   * reads it back off this string to colour the cell. */
  it('keeps the minus sign the one figures.ts looks for', () => {
    expect(formatAmount('-1234567.89', PORTUGAL)).toBe('-1.234.567,89')
  })

  /*
   * The reason nothing here parses. 9007199254740993 is the first integer a JS number
   * cannot represent — via `Number` it comes back as ...992, and a books figure that
   * changed by one on its way to the screen is the failure this file exists to rule out.
   */
  it('formats an amount larger than a JS number represents exactly', () => {
    expect(formatAmount('9007199254740993.01', INDIA)).toBe('9,00,71,99,25,47,40,993.01')
    /* Via a number the last digits come back as ...992, which is the whole point. */
    expect(String(Number('9007199254740993'))).not.toBe('9007199254740993')
  })

  it('returns anything it does not recognise untouched', () => {
    expect(formatAmount('not an amount', INDIA)).toBe('not an amount')
    expect(formatAmount('1e5', INDIA)).toBe('1e5')
  })
})

describe('formatAmountOrBlank', () => {
  it('leaves a zero cell empty, as a printed trial balance does', () => {
    expect(formatAmountOrBlank('0.00', INDIA)).toBe('')
    expect(formatAmountOrBlank('-0.00', INDIA)).toBe('')
    expect(formatAmountOrBlank('0', INDIA)).toBe('')
  })

  it('shows anything else, under the regime it was given', () => {
    expect(formatAmountOrBlank('0.01', INDIA)).toBe('0.01')
    expect(formatAmountOrBlank('1234.56', PORTUGAL)).toBe('1.234,56')
  })
})

describe('isZeroAmount and isNegativeAmount', () => {
  it('recognises every spelling of zero', () => {
    for (const value of ['0', '0.00', '-0.00', '000.0']) {
      expect(isZeroAmount(value), value).toBe(true)
    }
    expect(isZeroAmount('0.01')).toBe(false)
  })

  it('does not call a negative zero negative', () => {
    expect(isNegativeAmount('-0.00')).toBe(false)
    expect(isNegativeAmount('-0.01')).toBe(true)
    expect(isNegativeAmount('0.01')).toBe(false)
  })
})

describe('the ledger vocabulary', () => {
  it('gives each account type a plural heading', () => {
    expect(accountTypeLabel('asset')).toBe('Assets')
    expect(accountTypeLabel('liability')).toBe('Liabilities')
    expect(accountTypeLabel('equity')).toBe('Equity')
  })

  it('falls back to the raw value rather than showing nothing', () => {
    expect(accountTypeLabel('mystery')).toBe('mystery')
  })

  it('orders the balance sheet before the profit and loss', () => {
    const order = ['asset', 'liability', 'equity', 'income', 'expense']
    const ranks = order.map(accountTypeRank)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    expect(accountTypeRank('asset')).toBeLessThan(accountTypeRank('income'))
  })

  it('sorts an unknown type last rather than first', () => {
    expect(accountTypeRank('mystery')).toBeGreaterThan(accountTypeRank('expense'))
  })

  it('names the three period states, and does not call a lock a warning', () => {
    /*
     * THIS TEST PINNED `'info'` UNTIL 0016 AND `'info'` WAS NEVER A TONE — `.badge--info`
     * has no rule in atoms.css, so the assertion enshrined an unstyled pill as correct.
     * It is a Record now for two reasons: the value type makes the compiler refuse a
     * tone the atom does not have, which is the recurrence this is guarding against, and
     * the key type makes a fourth period state stop this file compiling until somebody
     * says how it reads.
     */
    const expected: Record<PeriodStatus, { label: string; tone: BadgeTone }> = {
      open: { label: 'Open', tone: 'positive' },
      closed: { label: 'Closed', tone: 'neutral' },
      locked: { label: 'Locked', tone: 'neutral' },
    }

    for (const [status, { label, tone }] of Object.entries(expected)) {
      expect(periodStatusLabel(status), status).toBe(label)
      expect(periodStatusTone(status), status).toBe(tone)
    }

    /* Closed and locked share the quiet tone deliberately, so the WORD is the only
     * thing separating them — assert that the words do differ, or the badge says the
     * same thing about two states a user must be able to tell apart. */
    expect(new Set(Object.values(expected).map((each) => each.label)).size).toBe(3)
    /* And that the tone is not one constant: an open period reads differently from a
     * shut one, which is the only distinction the colour is carrying. */
    expect(periodStatusTone('open')).not.toBe(periodStatusTone('closed'))
  })

  it('answers a status it has never heard of with a tone the badge actually has', () => {
    /* The parameter is `string`, so a period state from a migration this build predates
     * reaches here. Quiet rather than absent: an unknown tone renders an unstyled pill,
     * which is the failure the `'info'` bug shipped. */
    expect(periodStatusTone('sealed')).toBe('neutral')
    expect(periodStatusLabel('sealed')).toBe('sealed')
  })
})
