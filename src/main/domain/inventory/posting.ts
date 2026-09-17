/*
 * How a stock movement becomes a journal entry, and what to do about a movement that
 * arrives late.
 *
 * ARCHITECTURE §6.4: "Every stock movement writes to the stock ledger AND posts to the
 * general ledger, so inventory value on the balance sheet always reconciles with the
 * stock register." `moving-average.ts` says what a movement cost. This says what that
 * costs the books.
 *
 * PURE, like every other file here and like `domain/documents/posting.ts` beside it. It
 * takes the movement, the figure the strategy produced and a resolver the caller has
 * already filled from the chart of accounts; it mints no ids, reads no clock and reaches
 * no database. So the test for an accounting treatment is a movement written down beside
 * the entry it must produce.
 *
 * ===========================================================================
 * 1. EVERY MOVEMENT'S ENTRY IS THE STOCK ACCOUNT AGAINST ONE OTHER
 * ===========================================================================
 *
 *   KIND               DIR   STOCK   COUNTER                 WHAT IT MEANS
 *   opening            in    Dr      opening-balance-equity  stock the books started with
 *   receipt            in    Dr      purchases               goods bought, now on hand
 *   sales-return       in    Dr      cost-of-goods-sold      goods back; the sale's cost undone
 *   adjustment-in      in    Dr      stock-adjustment        found in a count
 *   issue              out   Cr      cost-of-goods-sold      goods sold, at what they cost
 *   purchase-return    out   Cr      stock-adjustment        goods sent back, at the average
 *   adjustment-out     out   Cr      stock-adjustment        shrinkage, breakage, write-down
 *
 * `COUNTER_ROLES` is a TOTAL RECORD over `StockMovementKind` (CONVENTIONS §1.9), so an
 * eighth kind does not compile until somebody has said where its other side goes. The
 * alternative — a lookup with a default — would give the new kind whatever the last
 * branch said, and a stock movement posted to the wrong expense account is a figure that
 * looks entirely plausible on every report.
 *
 * WHY `receipt` FACES `purchases` AND NOT `accounts-payable`. The purchase bill has
 * already posted `Dr Purchases / Cr Accounts Payable` — that is `domain/documents/
 * posting.ts` and it is not changing. The receipt then moves the same figure out of
 * Purchases and into Stock, so the pair nets to `Dr Stock / Cr Payable`, which is the
 * perpetual answer, and `Purchases` is left holding exactly what was bought and NOT
 * stocked: services, consumables, anything nobody counts. That is a useful figure rather
 * than a residue. A receipt that no bill raised — an opening top-up — is the kind
 * `opening`, which faces equity instead, so the clearing account is not asked to absorb
 * something no bill put in it.
 *
 * ===========================================================================
 * 2. THE PURCHASE RETURN, WHICH IS THE ONE WITH A DECISION IN IT
 * ===========================================================================
 *
 * A DEBIT NOTE CREDITS THE SUPPLIER AT THE NOTE'S PRICE AND THE STOCK LEAVES AT THE
 * AVERAGE. Those are two different numbers whenever anything has been bought at a
 * different price since, which is most of the time. Bought at 100, average now 95, sent
 * back for 100: the supplier owes 100 and the shelf loses 95. The 5 is a price variance
 * and it has to land somewhere.
 *
 * THE THREE CANDIDATES, AND WHY THE ANSWER IS `stock-adjustment`.
 *
 *   `purchase-returns`, the account the note itself credited. The variance would then be
 *   the NET of one account — 100 credited by the note, 95 debited by the movement, 5 left
 *   — which is arithmetically perfect and destroys the register: `Purchase Returns` would
 *   read 5 for a year in which 50,000 of goods went back, and "how much did we send back"
 *   is a question a business asks about its own quality. Worse, when the average happens
 *   to equal the price the account nets to NOTHING and the returns vanish from the profit
 *   and loss entirely. An account whose figure disappears exactly when nothing went wrong
 *   is not a register.
 *
 *   `purchases`, by symmetry with the receipt. It reports a PURCHASE of 95 against goods
 *   that were sent back, in the account that is supposed to hold what was bought and not
 *   stocked. The symmetry is real and the sentence it produces is false.
 *
 *   `stock-adjustment`, which is what this file uses. Account 5500 in the shipped chart,
 *   under Cost of Sales, already declared and already mapped (`db/repos/chart-template.ts`
 *   — the seam was laid at Phase 1). The profit and loss then carries two adjacent lines:
 *   `Purchase Returns` 100, the gross value of what went back, and `Stock Adjustment` 95,
 *   the cost of the goods that left. Their difference is the variance, it is visible, and
 *   BOTH figures survive — which is the property the first candidate loses.
 *
 * WHAT IT COSTS, STATED PLAINLY. The variance is the net of two lines rather than a line
 * of its own, and `Stock Adjustment` now carries routine return volume alongside
 * shrinkage and write-downs, which makes it a less sharp signal than it was. A dedicated
 * `purchase-price-variance` role would fix both and would mean a new member of
 * `AccountRole`, a new account in the shipped chart, and a mapping every existing company
 * file would be missing — a role a posting rule needs and no file has is a
 * `ROLE_UNMAPPED` refusal at the moment somebody tries to send goods back. That is a
 * migration and a repair path, and it is not this batch's.
 *
 * WHAT WOULD GIVE THE VARIANCE ITS OWN FIGURE without any of that: the movement knowing
 * the consideration. A purchase-return movement raised BY a debit note could carry what
 * the note credited, and the entry would then be three lines — the note's figure out of
 * `purchase-returns`, the average out of `stock`, and the difference into a variance
 * account. Nothing raises a movement from a document yet (there is no warehouse on a
 * document line — see `domain/documents/movement.ts`), so that shape has no caller and is
 * deliberately not written.
 *
 * ===========================================================================
 * 3. THE BACK-DATED MOVEMENT, WHICH IS THE HARD ONE
 * ===========================================================================
 *
 * 0019's header names it: "recording a back-dated receipt CHANGES THE COST OF A SALE THAT
 * HAS ALREADY POSTED TO THE GENERAL LEDGER. The stock register moves and the ledger
 * cannot, because a posted entry is immutable."
 *
 * IT IS POSTED, NOT REFUSED, AND NOT EDITED. A new entry, the same shape as a reversal —
 * ledger invariant 3 says a correction is a second entry dated when the correction was
 * made, and this is exactly that. Refusing instead would mean a delivery note that
 * arrives a week late cannot be entered at all, which is a Tuesday rather than an
 * exception.
 *
 * WHAT IT COMES TO IS EXACT, AND THAT IS WHY IT IS SAFE TO POST. An inward movement
 * STATES its cost and that figure never moves; only outward movements are re-valued. So
 * the whole drift is
 *
 *     Σ(what the outward movements cost NOW) − Σ(what they cost BEFORE)
 *
 * and `costChangesBetween` produces it movement by movement by folding the card twice —
 * once over the register as it stood, once with the new movement in it — and comparing
 * the two rows with the same sequence. There is no estimate anywhere in it.
 *
 * IT IS DATED AT THE MOVEMENT IT RESTATES, NOT AT THE MOVEMENT THAT CAUSED IT, and this
 * is the part that took the argument. A receipt back-dated to the 8th changes what an
 * issue on the 12th cost. Dating the correction the 8th would make a balance sheet drawn
 * on the 10th disagree with the register by the correction, because on the 10th the issue
 * has not happened yet in either book. Dating it the 12th is right at every date: before
 * the 12th neither book has it, from the 12th both do. So there is one adjusting entry
 * PER AFFECTED DATE — `revaluationsFor` groups them — and the reconciliation holds as at
 * every day, not merely at the end.
 *
 * THE OBJECTION TO THAT IS A CLOSED PERIOD, AND IT CANNOT HAPPEN. The movements being
 * restated are all dated on or after the movement that caused them, because they come
 * after it in card order; the causing movement's own period must be open, or nothing would
 * have been written; and periods close in order (`PERIOD_EARLIER_OPEN` in repos/periods).
 * So every affected date sits in a period at least as open as one already proven open.
 * The rule is a consequence of two other rules rather than a hope, and a test builds the
 * shape.
 *
 * EACH ADJUSTING ENTRY IS GROUPED BY THE COUNTER ACCOUNT of the movements it restates,
 * not lumped onto cost of goods sold. A back-dated receipt that re-values an issue and a
 * write-off on the same day moves two different expense accounts, and posting both to
 * COGS would overstate cost of sales and understate the adjustment account by the same
 * figure — which nets to the right profit and is wrong on both lines.
 */

import { ZERO, sum, type Decimal } from '@main/domain/money'
import type {
  AccountRef,
  AccountResolver,
  AccountRole,
  EntryDraft,
  EntryLineDraft,
  SourceDocument,
} from '@main/domain/ledger'
import { PostingError } from '@main/domain/ledger'
import type { DateString } from '@shared/scalars'

import { directionOf, type StockDirection, type StockMovementKind } from './types'
import type { StockCard, StockCardRow } from './stock-card'

// ---- Which accounts, and which way round ------------------------------------

/**
 * The account facing `stock` for each kind of movement.
 *
 * TOTAL OVER THE UNION, so an eighth kind is a compile error here rather than a movement
 * that posts to whatever the last branch said. See the table in the header for what each
 * one means and, for `purchase-return`, why it is the one with an argument behind it.
 */
export const COUNTER_ROLES: Readonly<Record<StockMovementKind, AccountRole>> = {
  opening: 'opening-balance-equity',
  receipt: 'purchases',
  'sales-return': 'cost-of-goods-sold',
  'adjustment-in': 'stock-adjustment',
  issue: 'cost-of-goods-sold',
  'purchase-return': 'stock-adjustment',
  'adjustment-out': 'stock-adjustment',
} as const

/**
 * Whether the stock account is DEBITED, as a total record over direction.
 *
 * Stock rises when goods come in and falls when they go out, which is not a rule about
 * inventory so much as the definition of an asset — but it is written as a record rather
 * than as `direction === 'in'` for the reason every other one in this codebase is: a
 * third direction would not compile until somebody answered for it (CONVENTIONS §1.9).
 */
const STOCK_IS_DEBIT: Readonly<Record<StockDirection, boolean>> = {
  in: true,
  out: false,
} as const

// ---- One movement's entry ---------------------------------------------------

/** A movement, and the figure the strategy put on it. Everything the entry needs. */
export interface MovementPosting {
  readonly kind: StockMovementKind
  /** The date the movement is valued as of, which is the date its entry posts as of. */
  readonly date: DateString
  /** What it moved, at money scale, non-negative. `ValuationResult.cost`. */
  readonly cost: Decimal
  /** What raised it, in the ledger's own three fields. */
  readonly source: SourceDocument
  readonly narration: string
}

/**
 * The entry one movement posts, or null when it moved no money.
 *
 * NULL IS A REAL ANSWER AND NOT A FAILURE. A free sample taken in at nil, or an issue out
 * of a pool that is worth nothing, moves quantity and no value — invariant 6 admits both
 * deliberately. There is nothing to post, ledger invariant 5 refuses an entry of two zero
 * lines, and the balance sheet is not missing anything because nothing moved. Returning
 * null rather than an empty draft is what makes the caller decide what to do about it
 * instead of discovering it as an `INSUFFICIENT_LINES` refusal three layers down.
 */
export function movementEntry(
  posting: MovementPosting,
  accounts: AccountResolver,
): EntryDraft | null {
  if (posting.cost.isZero()) {
    return null
  }

  const stockIsDebit = STOCK_IS_DEBIT[directionOf(posting.kind)]
  const stock = roleAccount(accounts, 'stock')
  const counter = roleAccount(accounts, COUNTER_ROLES[posting.kind])

  return {
    date: posting.date,
    narration: posting.narration,
    source: posting.source,
    lines: [place(stock, posting.cost, stockIsDebit), place(counter, posting.cost, !stockIsDebit)],
  }
}

// ---- What a late movement did to entries already posted ---------------------

/** One already-posted movement whose cost the register now says was different. */
export interface CostChange {
  readonly kind: StockMovementKind
  readonly date: DateString
  /** Position in the register, so a caller can name the row that moved. */
  readonly sequence: number
  readonly before: Decimal
  readonly after: Decimal
  /** `after - before`. Positive when the re-average made the movement cost more. */
  readonly delta: Decimal
}

/**
 * Which movements the new one re-valued, and by how much.
 *
 * Both cards are folds of the SAME register, one without the new movement and one with
 * it, so a row present in both is the same movement and its sequence identifies it. A row
 * present only in the second is the new movement itself and is not a change — it had no
 * cost before because it did not exist.
 *
 * ONLY OUTWARD MOVEMENTS CAN APPEAR HERE, and that is a property of the valuation rather
 * than a filter applied on the way out: an inward movement's cost is STATED (invariant 4)
 * and no re-averaging can move a figure the row itself carries. A test asserts it rather
 * than the code assuming it, because the day a strategy re-values a receipt is the day
 * this function has to be looked at again.
 *
 * A card that could not be folded contributes nothing, deliberately: `runStockCard` stops
 * at the first movement it cannot value, so its later rows are absent rather than
 * unchanged, and reading an absence as "cost fell to zero" would post a correction for
 * movements that are simply not in the answer. The caller refuses the whole set instead.
 */
export function costChangesBetween(before: StockCard, after: StockCard): CostChange[] {
  if (before.problem !== null || after.problem !== null) {
    return []
  }

  const was = new Map<number, StockCardRow>(before.rows.map((row) => [row.movement.sequence, row]))

  const changes: CostChange[] = []
  for (const row of after.rows) {
    const previous = was.get(row.movement.sequence)
    if (previous === undefined) {
      continue
    }
    if (previous.cost.equals(row.cost)) {
      continue
    }
    changes.push({
      kind: row.movement.kind,
      date: row.movement.date,
      sequence: row.movement.sequence,
      before: previous.cost,
      after: row.cost,
      delta: row.cost.minus(previous.cost),
    })
  }
  return changes
}

/** One adjusting entry: the movements of one date, restated. */
export interface Revaluation {
  readonly date: DateString
  readonly changes: readonly CostChange[]
  /**
   * What the stock account moves by, SIGNED TO ADD. Negative when the re-average made
   * what had already gone out cost more, which is a back-dated receipt at a higher price.
   */
  readonly stockAmount: Decimal
  readonly draft: EntryDraft
}

/** How the caller describes one adjusting entry in the day book. */
export interface RevaluationNarration {
  (date: DateString, changes: readonly CostChange[]): string
}

/**
 * The entries that restate what a back-dated movement changed — one per affected date.
 *
 * Empty when nothing changed, which is every movement recorded in date order.
 *
 * The date grouping is the whole design and the header argues it: an entry dated at the
 * movement it restates keeps the reconciliation true as at EVERY day, and one dated at
 * the movement that caused it is only true at the end. Dates come out in ascending order
 * so the entries are posted the way a day book reads them.
 */
export function revaluationsFor(
  changes: readonly CostChange[],
  accounts: AccountResolver,
  source: SourceDocument,
  narrate: RevaluationNarration,
): Revaluation[] {
  const byDate = new Map<DateString, CostChange[]>()
  for (const change of changes) {
    if (change.delta.isZero()) {
      continue
    }
    const existing = byDate.get(change.date)
    if (existing === undefined) {
      byDate.set(change.date, [change])
    } else {
      existing.push(change)
    }
  }

  const dates = [...byDate.keys()].sort()
  const revaluations: Revaluation[] = []

  for (const date of dates) {
    const onDate = byDate.get(date) ?? []

    /*
     * Grouped by the counter account of each restated movement, never lumped onto one.
     * An issue and a write-off on the same day face different expense accounts, and
     * posting both to cost of goods sold nets to the right profit with both lines wrong.
     */
    const byRole = new Map<AccountRole, Decimal[]>()
    for (const change of onDate) {
      const role = COUNTER_ROLES[change.kind]
      const amounts = byRole.get(role)
      if (amounts === undefined) {
        byRole.set(role, [change.delta])
      } else {
        amounts.push(change.delta)
      }
    }

    const lines: EntryLineDraft[] = []
    let total = ZERO
    for (const [role, amounts] of byRole) {
      const delta = sum(amounts)
      if (delta.isZero()) {
        continue
      }
      total = total.plus(delta)
      /* More value left than the books recorded, so the expense rises: a debit. */
      lines.push(place(roleAccount(accounts, role), delta, true))
    }

    if (lines.length === 0) {
      /* Every role on this date cancelled out. Nothing moved, so nothing posts — and the
       * stock line would be zero too, which ledger invariant 5 refuses. */
      continue
    }

    const stockAmount = total.negated()
    lines.unshift(place(roleAccount(accounts, 'stock'), stockAmount, true))

    revaluations.push({
      date,
      changes: onDate,
      stockAmount,
      draft: { date, narration: narrate(date, onDate), source, lines },
    })
  }

  return revaluations
}

// ---- Shared -----------------------------------------------------------------

/**
 * One line, on the side asked for, with a negative amount folded into the other side.
 *
 * The same function `domain/documents/posting.ts` keeps for the same reason: ledger
 * invariant 5 refuses a credit of minus something, and a re-valuation is genuinely signed
 * — a back-dated receipt at a LOWER price makes an issue cost less, and the correction
 * goes the other way. Folding it here rather than at each call site is what lets the
 * caller say which side it means and never how to write it.
 */
function place(account: AccountRef, amount: Decimal, isDebit: boolean): EntryLineDraft {
  const debits = isDebit !== amount.isNegative()
  const magnitude = amount.isNegative() ? amount.negated() : amount
  return {
    accountId: account.id,
    debit: debits ? magnitude : ZERO,
    credit: debits ? ZERO : magnitude,
  }
}

/**
 * The account a role is mapped to, or a refusal naming the role.
 *
 * `PostingError` rather than a null, for the reason `domain/documents/posting.ts` gives:
 * there is no half-built entry to hand back, and a stock movement posted to a default
 * account would be a figure that looks entirely plausible on every report.
 */
function roleAccount(accounts: AccountResolver, role: AccountRole): AccountRef {
  const account = accounts.forRole(role)
  if (account === null) {
    throw new PostingError(
      'ROLE_UNMAPPED',
      `No account is mapped to ${role}, so this stock movement cannot post — a movement ` +
        'that does not post is a balance sheet that does not tie to the stock register. ' +
        'Every chart Coffer creates maps one, and no screen can yet, so please report this.',
      { role },
    )
  }
  return account
}
