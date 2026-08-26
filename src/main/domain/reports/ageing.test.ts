/*
 * The ageing arithmetic, with no database anywhere near it.
 *
 * Two things are under test and they fail differently, so they are kept apart.
 *
 * THE COLUMN TABLE. `assertBucketsCover` is a guard against a table the shipped constant
 * cannot be — which is why every test of it hands it a broken one. Its two failures are
 * the ones nobody can see by reading: a GAP loses a figure and leaves the row total short
 * by an amount nothing on the page accounts for, and an OVERLAP counts it twice and
 * leaves the row total RIGHT while both columns are wrong. The second is the dangerous
 * one, because the page then looks consistent exactly where it is not.
 *
 * THE FOLD. `ageItems` decides sign before date, which is what keeps a customer's own
 * money out of "over 90 days". The assertions pin figures BY VALUE rather than asserting
 * that the parts add up: a total that ties is true of a great many wrong answers, and
 * batch 1.1C's surviving mutation was exactly that mistake.
 */

import { describe, expect, it } from 'vitest'

import { D, ZERO } from '../money'
import {
  AGE_BUCKETS,
  ageItems,
  assertBucketsCover,
  bucketIndexIn,
  type AgeBucket,
  type AgeableItem,
} from './ageing'

/** The shipped table's shape, so a test can bend one end at a time. */
const SOUND: readonly AgeBucket[] = [
  { label: 'Not yet due', fromDays: null, toDays: 0 },
  { label: 'Early', fromDays: 1, toDays: 30 },
  { label: 'Late', fromDays: 31, toDays: null },
]

function item(over: Partial<AgeableItem> = {}): AgeableItem {
  return { partyId: 'party-1', amount: D('100.00'), dueDate: '2026-06-30', ...over }
}

// ---- The column table ------------------------------------------------------

describe('AGE_BUCKETS', () => {
  it('covers every age exactly once', () => {
    expect(() => {
      assertBucketsCover(AGE_BUCKETS, 'AGE_BUCKETS')
    }).not.toThrow()
  })

  /*
   * BY VALUE, not by walking the table and re-deriving the answer. A test that computed
   * the expected column from `fromDays` and `toDays` would pass against any contiguous
   * table at all, including one thirty days out — and thirty days out is precisely the
   * mistake that would send a statement chasing money that is not yet late.
   */
  it('starts at not-yet-due and ends open', () => {
    expect(AGE_BUCKETS.map((bucket) => bucket.label)).toEqual([
      'Not yet due',
      '1-30 days',
      '31-60 days',
      '61-90 days',
      'Over 90 days',
    ])
    expect(AGE_BUCKETS[0]?.fromDays).toBeNull()
    expect(AGE_BUCKETS[0]?.toDays).toBe(0)
    expect(AGE_BUCKETS.at(-1)?.fromDays).toBe(91)
    expect(AGE_BUCKETS.at(-1)?.toDays).toBeNull()
  })
})

describe('assertBucketsCover', () => {
  const refusal = (buckets: readonly AgeBucket[]): string => {
    try {
      assertBucketsCover(buckets, 'a table')
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    return 'it did not refuse'
  }

  it('accepts a table with no gap and no overlap', () => {
    expect(() => {
      assertBucketsCover(SOUND, 'a table')
    }).not.toThrow()
  })

  it('refuses a table with no columns at all', () => {
    expect(refusal([])).toContain('there are no columns')
  })

  it('refuses a first column that is closed at the young end', () => {
    const closed = [{ label: 'Not yet due', fromDays: -30, toDays: 0 }, ...SOUND.slice(1)]
    expect(refusal(closed)).toContain('closed at the young end')
  })

  it('refuses a last column that is closed at the old end', () => {
    const closed = [...SOUND.slice(0, -1), { label: 'Late', fromDays: 31, toDays: 90 }]
    expect(refusal(closed)).toContain('closed at the old end')
  })

  /* The one that loses a figure. Nothing covers day 31, so an invoice a month and a day
   * overdue would be in no column and the row would be short by its amount. */
  it('refuses a gap between two columns', () => {
    const gapped = [
      { label: 'Not yet due', fromDays: null, toDays: 0 },
      { label: 'Early', fromDays: 1, toDays: 30 },
      { label: 'Late', fromDays: 32, toDays: null },
    ]
    expect(refusal(gapped)).toContain('Early ends at 30 and Late starts at 32')
  })

  /* The one that counts a figure twice, and leaves the row total right while doing it. */
  it('refuses two columns that overlap', () => {
    const overlapping = [
      { label: 'Not yet due', fromDays: null, toDays: 0 },
      { label: 'Early', fromDays: 1, toDays: 30 },
      { label: 'Late', fromDays: 30, toDays: null },
    ]
    expect(refusal(overlapping)).toContain('Early ends at 30 and Late starts at 30')
  })

  it('refuses a column open at the old end that is not the last', () => {
    const open = [
      { label: 'Not yet due', fromDays: null, toDays: 0 },
      { label: 'Early', fromDays: 1, toDays: null },
      { label: 'Late', fromDays: 31, toDays: null },
    ]
    expect(refusal(open)).toContain('Early is open at the old end but is not the last column')
  })

  it('refuses a column open at the young end that is not the first', () => {
    const open = [
      { label: 'Not yet due', fromDays: null, toDays: 0 },
      { label: 'Early', fromDays: null, toDays: 30 },
      { label: 'Late', fromDays: 31, toDays: null },
    ]
    expect(refusal(open)).toContain('Early is open at the young end but is not the first column')
  })
})

// ---- Which column an age falls in -------------------------------------------

describe('bucketIndexIn', () => {
  /*
   * THE BOUNDARY IS THE TEST. Every one of these is a day either side of an edge, because
   * an off-by-one here is invisible in every other kind of assertion — the figure is in a
   * column, the row totals, and the page looks right while a business chases money a day
   * before it is late.
   */
  it.each([
    [-365, 0, 'a year early'],
    [-1, 0, 'due tomorrow'],
    [0, 0, 'due today, and not late'],
    [1, 1, 'a day late'],
    [30, 1, 'the last day of the first column'],
    [31, 2, 'the first day of the second'],
    [60, 2, 'the last day of the second'],
    [61, 3, 'the first day of the third'],
    [90, 3, 'the last day of the third'],
    [91, 4, 'the first day past ninety'],
    [3650, 4, 'ten years late, and still on the page'],
  ])('puts %i days overdue in column %i (%s)', (daysOverdue, expected) => {
    expect(bucketIndexIn(AGE_BUCKETS, daysOverdue)).toBe(expected)
  })

  /*
   * COUNTED, NOT FOUND. A `.find` would answer 1 here and never mention the second match,
   * which is how an overlapping table becomes "whichever column is listed first".
   */
  it('refuses an age that two columns both claim', () => {
    const overlapping: AgeBucket[] = [
      { label: 'Not yet due', fromDays: null, toDays: 0 },
      { label: 'Early', fromDays: 1, toDays: 40 },
      { label: 'Late', fromDays: 31, toDays: null },
    ]
    expect(() => bucketIndexIn(overlapping, 35)).toThrow('2 columns cover 35 days overdue')
  })

  it('refuses an age no column claims', () => {
    const gapped: AgeBucket[] = [
      { label: 'Not yet due', fromDays: null, toDays: 0 },
      { label: 'Late', fromDays: 31, toDays: null },
    ]
    expect(() => bucketIndexIn(gapped, 15)).toThrow('0 columns cover 15 days overdue')
  })
})

// ---- The fold ---------------------------------------------------------------

describe('ageItems', () => {
  it('has a row for nobody and a foot of zeroes when there is nothing outstanding', () => {
    const ageing = ageItems(AGE_BUCKETS, '2026-06-30', [])

    expect(ageing.parties).toEqual([])
    expect(ageing.totals.buckets).toHaveLength(AGE_BUCKETS.length)
    expect(ageing.totals.buckets.every((amount) => amount.isZero())).toBe(true)
    expect(ageing.totals.total.toFixed(2)).toBe('0.00')
  })

  it('puts a charge in the column its due date earns', () => {
    /* Due on 1 May, read on 30 June: sixty days. The second overdue column. */
    const ageing = ageItems(AGE_BUCKETS, '2026-06-30', [
      item({ amount: D('1180.00'), dueDate: '2026-05-01' }),
    ])

    const party = ageing.parties[0]!
    expect(party.items[0]?.daysOverdue).toBe(60)
    expect(party.items[0]?.bucket).toBe(2)
    expect(party.buckets.map((amount) => amount.toFixed(2))).toEqual([
      '0.00',
      '0.00',
      '1180.00',
      '0.00',
      '0.00',
    ])
    expect(party.total.toFixed(2)).toBe('1180.00')
  })

  /* Money is not late on the day it falls due, and it is late the day after. Both, in one
   * test, because the mistake is always a shift of exactly one day and a test of either
   * side alone passes against it. */
  it('calls a charge due today not-yet-due, and one due yesterday a day late', () => {
    const ageing = ageItems(AGE_BUCKETS, '2026-06-30', [
      item({ partyId: 'today', dueDate: '2026-06-30' }),
      item({ partyId: 'yesterday', dueDate: '2026-06-29' }),
    ])

    const byParty = new Map(ageing.parties.map((party) => [party.partyId, party]))
    expect(byParty.get('today')?.items[0]?.bucket).toBe(0)
    expect(byParty.get('today')?.items[0]?.daysOverdue).toBe(0)
    expect(byParty.get('yesterday')?.items[0]?.bucket).toBe(1)
    expect(byParty.get('yesterday')?.items[0]?.daysOverdue).toBe(1)
  })

  /*
   * THE RULE THE HEADER IS ABOUT. The credit is two years old, which is the case that
   * makes bucketing it look reasonable — and it still never ages, because a customer's
   * own money is not a debt of theirs however long it has sat there.
   */
  it('never ages a credit, however old it is', () => {
    const ageing = ageItems(AGE_BUCKETS, '2026-06-30', [
      item({ amount: D('-500.00'), dueDate: '2024-01-01' }),
    ])

    const party = ageing.parties[0]!
    expect(party.items[0]?.bucket).toBeNull()
    expect(party.items[0]?.daysOverdue).toBe(911)
    expect(party.buckets.every((amount) => amount.isZero())).toBe(true)
    expect(party.onAccount.toFixed(2)).toBe('500.00')
    expect(party.total.toFixed(2)).toBe('-500.00')
  })

  it('takes what is on account off what is owed', () => {
    const ageing = ageItems(AGE_BUCKETS, '2026-06-30', [
      item({ amount: D('1000.00'), dueDate: '2026-05-01' }),
      item({ amount: D('-300.00'), dueDate: '2026-06-15' }),
    ])

    const party = ageing.parties[0]!
    expect(party.buckets[2]?.toFixed(2)).toBe('1000.00')
    expect(party.onAccount.toFixed(2)).toBe('300.00')
    expect(party.total.toFixed(2)).toBe('700.00')
  })

  it('adds two charges that fall in the same column', () => {
    const ageing = ageItems(AGE_BUCKETS, '2026-06-30', [
      item({ amount: D('100.00'), dueDate: '2026-06-01' }),
      item({ amount: D('250.50'), dueDate: '2026-06-10' }),
    ])

    expect(ageing.parties[0]?.buckets[1]?.toFixed(2)).toBe('350.50')
  })

  it("lists a party's items oldest first", () => {
    const ageing = ageItems(AGE_BUCKETS, '2026-06-30', [
      item({ dueDate: '2026-06-20' }),
      item({ dueDate: '2026-01-05' }),
      item({ dueDate: '2026-03-31' }),
    ])

    expect(ageing.parties[0]?.items.map((placed) => placed.item.dueDate)).toEqual([
      '2026-01-05',
      '2026-03-31',
      '2026-06-20',
    ])
  })

  /* Largest debt first, which is the order the report is read in. The fixture is built in
   * the OPPOSITE order so that a fold which simply preserved arrival would fail. */
  it('lists parties by what they owe, largest first', () => {
    const ageing = ageItems(AGE_BUCKETS, '2026-06-30', [
      item({ partyId: 'small', amount: D('10.00') }),
      item({ partyId: 'large', amount: D('9000.00') }),
      item({ partyId: 'middling', amount: D('500.00') }),
    ])

    expect(ageing.parties.map((party) => party.partyId)).toEqual(['large', 'middling', 'small'])
  })

  it('keeps two parties owing the same amount in a settled order', () => {
    const ageing = ageItems(AGE_BUCKETS, '2026-06-30', [
      item({ partyId: 'zeta', amount: D('100.00') }),
      item({ partyId: 'alpha', amount: D('100.00') }),
    ])

    expect(ageing.parties.map((party) => party.partyId)).toEqual(['alpha', 'zeta'])
  })

  it('gives a line naming nobody a row of its own', () => {
    const ageing = ageItems(AGE_BUCKETS, '2026-06-30', [
      item({ partyId: null, amount: D('75.00') }),
      item({ partyId: 'party-1', amount: D('75.00') }),
    ])

    expect(ageing.parties).toHaveLength(2)
    expect(ageing.parties.map((party) => party.partyId).includes(null)).toBe(true)
  })

  /*
   * The foot, column by column and BY VALUE. Asserting only that the columns sum to the
   * total would hold against a fold that put every figure in one column.
   */
  it('totals the columns across every party', () => {
    const ageing = ageItems(AGE_BUCKETS, '2026-06-30', [
      item({ partyId: 'a', amount: D('1000.00'), dueDate: '2026-06-30' }),
      item({ partyId: 'b', amount: D('200.00'), dueDate: '2026-06-01' }),
      /* 76 days: mid-April read at the end of June, which is the fourth column. */
      item({ partyId: 'a', amount: D('40.00'), dueDate: '2026-04-15' }),
      item({ partyId: 'b', amount: D('-90.00'), dueDate: '2026-06-20' }),
    ])

    expect(ageing.totals.buckets.map((amount) => amount.toFixed(2))).toEqual([
      '1000.00',
      '200.00',
      '0.00',
      '40.00',
      '0.00',
    ])
    expect(ageing.totals.onAccount.toFixed(2)).toBe('90.00')
    expect(ageing.totals.total.toFixed(2)).toBe('1150.00')
  })

  /* Every party row's columns are the table's own length, so a screen can draw a header
   * row from the table and a body row from a party and have them line up. */
  it('gives every party a figure for every column', () => {
    const ageing = ageItems(AGE_BUCKETS, '2026-06-30', [
      item({ partyId: 'a' }),
      item({ partyId: 'b', amount: D('-1.00') }),
    ])

    for (const party of ageing.parties) {
      expect(party.buckets).toHaveLength(AGE_BUCKETS.length)
    }
  })

  /* A column with nothing in it holds zero, not `undefined`. A screen formats each cell,
   * and a hole would reach `toMoneyString` as a missing figure rather than as nought. */
  it('starts every column at zero rather than leaving it absent', () => {
    const ageing = ageItems(AGE_BUCKETS, '2026-06-30', [item()])

    const empty = ageing.parties[0]?.buckets.filter((amount) => amount.equals(ZERO)) ?? []
    expect(empty).toHaveLength(AGE_BUCKETS.length - 1)
  })
})
