/*
 * How old a debt is, and which column of an aged report it belongs in.
 *
 * The arithmetic of an aged report, with no database and no formatting — the split this
 * folder makes everywhere. What is outstanding is decided in db/repos/outstanding.ts and
 * db/repos/ageing.ts; this decides only where each figure lands once somebody has it.
 *
 * ---------------------------------------------------------------------------
 * AN AGED REPORT IS ONE CONTROL ACCOUNT, DECOMPOSED
 *
 * Not "a list of unpaid invoices", which is the version that is easy to write and does
 * not tie to anything. The identity at the top of db/repos/outstanding.ts is
 *
 *   party control balance  =  SUM(document outstanding)  -  SUM(receipt unallocated)
 *
 * so a report listing only the first term disagrees with the balance sheet by exactly the
 * money sitting on account — which is money a customer has actually sent, and the report
 * that omits it is the one used to chase them for it.
 *
 * Everything below therefore takes ITEMS, not invoices: anything at all that has moved a
 * party's control account. An invoice, a credit note, a receipt with money spare, and the
 * opening balance somebody typed on the day they adopted Coffer are all items. The
 * repository's job is to leave nothing out; this file's job is to put each one in a
 * column, and the two together are why the total at the foot equals the account.
 *
 * ---------------------------------------------------------------------------
 * A CREDIT NEVER AGES
 *
 * Only a debt gets older. A payment on account, a credit note, an over-receipt: none of
 * them is late, and bucketing them by date would put a customer's own money in "over 90
 * days" beside the invoices nobody has matched it to — one figure reading as both a
 * problem and its own solution. So the sign decides the treatment before any date is
 * looked at: what the party owes is aged, what stands to their credit goes to one column
 * of its own, and the total is the first less the second.
 *
 * ---------------------------------------------------------------------------
 * MONEY WITH NOTHING TO FIX A DATE IS DUE THE DAY IT WAS RAISED
 *
 * An opening receivable has no terms and no document; a manual journal against the
 * control account has neither either. They still have to age, or a file adopted with
 * 4,50,000 owed by five customers reports nothing overdue on the day it opens — which is
 * both wrong and the exact case opening balances exist for.
 *
 * "Due on the day it was raised" is not invented here to fill that hole. It is the rule
 * 0014 already wrote down for a party on no payment terms: `dueDateFor` reads null terms
 * as due on receipt, because that is a decision rather than an absence. This is the same
 * sentence one layer up, and the repository is where it is applied — by the time an item
 * reaches this file it has a due date, and there is no null case for anyone to forget.
 */

import { ZERO, type Decimal } from '../money'
import { daysBetween, type DateString } from '../time'

/**
 * One column of the report.
 *
 * Both ends inclusive, and both nullable: the first column is open at the young end so
 * that something not yet due lands in it however far off it is, and the last is open at
 * the old end so that nothing can be too old to appear. A closed table would need a
 * "somewhere else" column, which is where figures go to stop being read.
 */
export interface AgeBucket {
  /** The column heading. */
  label: string
  /** Days overdue at which the column starts. Null is open — nothing is too young. */
  fromDays: number | null
  /** Days overdue at which it ends. Null is open — nothing is too old. */
  toDays: number | null
}

/**
 * The columns, thirty days apart, which is what an aged report is expected to look like.
 *
 * `toDays: 0` on the first is the load-bearing number. Days overdue is the report's date
 * less the due date, so an invoice due TODAY is nought days overdue and is not late —
 * money is not late on the day it is due. Writing `-1` there would move every invoice
 * into the first overdue column on its due date, a day early on every statement sent.
 */
export const AGE_BUCKETS: readonly AgeBucket[] = [
  { label: 'Not yet due', fromDays: null, toDays: 0 },
  { label: '1-30 days', fromDays: 1, toDays: 30 },
  { label: '31-60 days', fromDays: 31, toDays: 60 },
  { label: '61-90 days', fromDays: 61, toDays: 90 },
  { label: 'Over 90 days', fromDays: 91, toDays: null },
]

/**
 * Refuse a table that does not cover every possible age exactly once.
 *
 * WHAT MAKES THE TOTAL TRUSTWORTHY. A gap between two columns loses a figure in silence:
 * the item is in no bucket, so no column shows it, and the row total is short by an
 * amount nothing on the page accounts for. An overlap is worse — the figure appears
 * twice, so the row total is right while both columns are wrong, and the page looks
 * consistent precisely where it is not.
 *
 * Neither can be seen by reading the table, which is why it is checked rather than read.
 * Contiguity is the whole of the condition: each column starts the day after the one
 * before it ends, the first is open below, the last open above.
 *
 * IT TAKES THE TABLE AS AN ARGUMENT for the reason `chargeKindIn` does. A guard against a
 * state the shipped constant cannot reach is a guard no test can exercise and no mutation
 * can kill; handed a broken table, this one is ordinary code.
 */
export function assertBucketsCover(buckets: readonly AgeBucket[], asking: string): void {
  const refuse = (why: string): never => {
    throw new Error(`${asking}: ${why} The columns must cover every age exactly once.`)
  }

  const first = buckets[0]
  const last = buckets.at(-1)
  if (first === undefined || last === undefined) refuse('there are no columns.')
  else if (first.fromDays !== null) refuse('the first column is closed at the young end.')
  else if (last.toDays !== null) refuse('the last column is closed at the old end.')

  for (const [index, bucket] of buckets.entries()) {
    const previous = buckets[index - 1]
    if (previous === undefined) continue
    /* `previous.toDays` is null only on the last column, and nothing follows the last
     * column — so this is the check that a middle column is closed at both ends, rather
     * than a null the loop has to tolerate. */
    if (previous.toDays === null) {
      refuse(`${previous.label} is open at the old end but is not the last column.`)
    } else if (bucket.fromDays === null) {
      refuse(`${bucket.label} is open at the young end but is not the first column.`)
    } else if (bucket.fromDays !== previous.toDays + 1) {
      refuse(
        `${previous.label} ends at ${String(previous.toDays)} and ${bucket.label} starts ` +
          `at ${String(bucket.fromDays)}.`,
      )
    }
  }
}

assertBucketsCover(AGE_BUCKETS, 'AGE_BUCKETS')

/**
 * Which column an age falls in.
 *
 * COUNTED, NOT FOUND. `.find` would answer "the first column that matches", which is a
 * different rule and agrees with this one only while the table is sound — and the whole
 * point of `assertBucketsCover` is that soundness is not visible by reading. Counting
 * makes an overlapping table a refusal here as well as at load, rather than a figure
 * quietly filed under whichever column happens to be listed first.
 */
export function bucketIndexIn(buckets: readonly AgeBucket[], daysOverdue: number): number {
  const matches = buckets
    .map((bucket, index) => ({ bucket, index }))
    .filter(
      ({ bucket }) =>
        (bucket.fromDays === null || daysOverdue >= bucket.fromDays) &&
        (bucket.toDays === null || daysOverdue <= bucket.toDays),
    )

  const [only, ...rest] = matches
  if (only === undefined || rest.length > 0) {
    throw new Error(
      `${String(matches.length)} columns cover ${String(daysOverdue)} days overdue. ` +
        'Exactly one, or the figure is either lost or counted twice.',
    )
  }
  return only.index
}

/** The least an item needs before it can be aged. */
export interface AgeableItem {
  /**
   * Whose it is. Null is a line on the control account naming no party, which is a
   * mistake in the books — and this report is the only page that shows it, so it is
   * carried rather than dropped. See `agedReport`.
   */
  partyId: string | null
  /**
   * Positive: the party owes it. Negative: it stands to their credit.
   *
   * Signed towards what the party owes whichever side of the trade it is, so a purchase
   * ledger reads the same way round as a sales one and a negative always means the same
   * thing. Zero never arrives: an item that has come to nothing is not an item.
   */
  amount: Decimal
  /** What it falls due on. Never null — see the header. */
  dueDate: DateString
}

/** An item with its age worked out, and the column that follows from it. */
export interface PlacedItem<T> {
  item: T
  /**
   * The report's date less the due date. Nought or below is not yet due.
   *
   * Kept on the row rather than only used to pick a column, because "45 days" is what a
   * person chasing the money says out loud, and working it out again in the screen would
   * be the renderer doing date arithmetic on something main has already answered.
   */
  daysOverdue: number
  /** Which column, or null where it stands to the party's credit and so never ages. */
  bucket: number | null
}

export interface AgedParty<T> {
  partyId: string | null
  /** Oldest due date first — the order money is applied in, and the order it is chased. */
  items: PlacedItem<T>[]
  /** One figure per column, in the table's own length and order. */
  buckets: Decimal[]
  /** What stands to the party's credit against no particular charge. Positive. */
  onAccount: Decimal
  /** The columns less what is on account. What this party actually owes. */
  total: Decimal
}

export interface AgeingTotals {
  buckets: Decimal[]
  onAccount: Decimal
  total: Decimal
}

export interface Ageing<T> {
  parties: AgedParty<T>[]
  totals: AgeingTotals
}

/**
 * Put every item in a column, and total the columns by party and overall.
 *
 * GENERIC OVER THE ITEM so that the caller's row — a document number, a voucher, an entry
 * — comes back attached to the column it landed in. The alternative was returning column
 * indices positionally for the repository to zip back up, which is a join by array index
 * and wrong the first time anything filters.
 *
 * Parties come back by what they owe, largest first: the first question an aged report is
 * opened with is who owes the most. `partyId` breaks the tie so that two parties owing
 * the same amount do not swap places between runs — a report that reorders itself is one
 * nobody can hold against last month's. A null party sorts by the same rule as the rest;
 * it is rare enough that a special case would be more surprising than its absence.
 */
export function ageItems<T extends AgeableItem>(
  buckets: readonly AgeBucket[],
  asAtDate: DateString,
  items: readonly T[],
): Ageing<T> {
  const byParty = new Map<string | null, AgedParty<T>>()

  for (const item of items) {
    let party = byParty.get(item.partyId)
    if (party === undefined) {
      party = {
        partyId: item.partyId,
        items: [],
        buckets: buckets.map(() => ZERO),
        onAccount: ZERO,
        total: ZERO,
      }
      byParty.set(item.partyId, party)
    }

    /*
     * The sign is read BEFORE the date, which is the header's rule made into an order of
     * operations. Ageing a credit and then noticing it was a credit would still have
     * touched a column on the way past.
     */
    const daysOverdue = daysBetween(item.dueDate, asAtDate)
    if (item.amount.isNegative()) {
      party.items.push({ item, daysOverdue, bucket: null })
      party.onAccount = party.onAccount.plus(item.amount.negated())
    } else {
      const bucket = bucketIndexIn(buckets, daysOverdue)
      party.items.push({ item, daysOverdue, bucket })
      party.buckets[bucket] = (party.buckets[bucket] ?? ZERO).plus(item.amount)
    }
    party.total = party.total.plus(item.amount)
  }

  const parties = [...byParty.values()]
  for (const party of parties) {
    party.items.sort(byDueDate)
  }
  parties.sort(byWhatIsOwed)

  return { parties, totals: totalsOf(buckets, parties) }
}

/** Oldest first. Two items due the same day keep the order they arrived in. */
function byDueDate<T extends AgeableItem>(a: PlacedItem<T>, b: PlacedItem<T>): number {
  if (a.item.dueDate === b.item.dueDate) return 0
  return a.item.dueDate < b.item.dueDate ? -1 : 1
}

function byWhatIsOwed<T>(a: AgedParty<T>, b: AgedParty<T>): number {
  const difference = b.total.comparedTo(a.total)
  if (difference !== 0) return difference
  return (a.partyId ?? '').localeCompare(b.partyId ?? '')
}

/**
 * The foot of the report, summed from the party rows.
 *
 * From the ROWS and not from the items a second time. Two folds over the same figures is
 * two ways of reaching one total, and on the day a party row is filtered out of the list
 * the foot would go on including it — the fault `runningLedger` avoids by taking its
 * closing balance off the last row rather than summing all over again.
 */
function totalsOf<T>(
  buckets: readonly AgeBucket[],
  parties: readonly AgedParty<T>[],
): AgeingTotals {
  const totals: AgeingTotals = {
    buckets: buckets.map(() => ZERO),
    onAccount: ZERO,
    total: ZERO,
  }

  for (const party of parties) {
    for (const [index, amount] of party.buckets.entries()) {
      totals.buckets[index] = (totals.buckets[index] ?? ZERO).plus(amount)
    }
    totals.onAccount = totals.onAccount.plus(party.onAccount)
    totals.total = totals.total.plus(party.total)
  }
  return totals
}
