/*
 * The stock card: an item's movements, in order, each carrying what the file looked like
 * after it.
 *
 * ---------------------------------------------------------------------------
 * FOLDED EVERY TIME, FROM AN OPENING STATE
 *
 * Invariant 7. The same argument as `domain/reports/running.ts` makes for a running
 * ledger balance, and it is sharper here because a moving average is path-dependent in a
 * way a balance is not: a receipt posted with a back-date does not merely shift figures
 * down the page, it CHANGES THE AVERAGE that every issue after it left at, and therefore
 * changes the cost of goods sold on invoices that are already printed. A stored running
 * average would be silently wrong from the moment a delivery note arrived a week late,
 * and the row that did not get rewritten is the one nobody notices.
 *
 * So the card is O(rows) over the movements every time it is asked for, and the closing
 * state is the last row's, not a separately computed sum. Two ways of arriving at the
 * closing figure is one way too many.
 *
 * ---------------------------------------------------------------------------
 * ORDER IS DECIDED HERE, NOT BY WHATEVER FETCHED THE ROWS
 *
 * Movements are sorted by date, then by sequence within the date. CONVENTIONS §1.10 in
 * its ordering form: an order that comes from "the query that fetched it" agrees with the
 * right order exactly as long as nobody back-dates anything, which is a property nothing
 * states and nothing tests.
 *
 * A DUPLICATE SEQUENCE IS REFUSED for the same reason. Two movements sharing a sequence
 * on the same date would be ordered by whatever the sort happened to do with a tie —
 * which is the input's order wearing a sort's name. Under moving average the two orders
 * can give different figures (issue-then-receive and receive-then-issue are not the same
 * card), so the tie is a real ambiguity and not a cosmetic one.
 *
 * ---------------------------------------------------------------------------
 * THE CARD STOPS AT THE FIRST MOVEMENT IT CANNOT VALUE
 *
 * It does not skip it and carry on. A card that skipped an issue it could not cover would
 * be arithmetically impeccable over an incomplete set of facts — every row right, every
 * total tying, and the closing figure wrong — which is the failure mode CONVENTIONS §1.10
 * describes: a wrong answer that disagrees with something gets found, and one that agrees
 * with everything does not.
 */

import { ZERO, sum, type Decimal } from '@main/domain/money'
import { compareDates } from '@main/domain/time'
import { checkMovementDate } from './state'
import {
  directionOf,
  refusal,
  type InventoryProblem,
  type LayerSlice,
  type StockDirection,
  type StockMovement,
  type ValuationMethod,
  type ValuationState,
  type ValuationStrategy,
} from './types'

/** One line of the card: the movement, what it cost, and the file after it. */
export interface StockCardRow {
  readonly movement: StockMovement
  /** What this movement moved, as money at 2dp. Non-negative; the direction is on the kind. */
  readonly cost: Decimal
  /** On hand after the movement. */
  readonly quantity: Decimal
  /** Carrying value after the movement. */
  readonly value: Decimal
  /** Average cost per unit after the movement, at `UNIT_COST_SCALE`. */
  readonly unitCost: Decimal
  /** Which layers moved. One entry under moving average, several under FIFO. */
  readonly slices: readonly LayerSlice[]
}

export interface StockCard {
  readonly itemId: string
  readonly method: ValuationMethod
  readonly opening: ValuationState
  /** The movements that were valued, in date-then-sequence order. */
  readonly rows: readonly StockCardRow[]
  /** The file after the last valued row — the last row's state, never a second sum. */
  readonly closing: ValuationState
  readonly quantityIn: Decimal
  readonly quantityOut: Decimal
  readonly costIn: Decimal
  readonly costOut: Decimal
  /**
   * The first movement that could not be valued, and why. Null when the card is complete.
   *
   * `rows` then holds everything before it, so the card shows the user exactly how far it
   * got — which is the information they need to find the movement that is missing.
   */
  readonly problem: InventoryProblem | null
}

/**
 * Date, then sequence. Sequence alone would be wrong for a back-dated movement — it gets
 * the highest sequence and the earliest date — and date alone leaves two movements on one
 * day in the order the rows arrived.
 */
function inCardOrder(a: StockMovement, b: StockMovement): number {
  return compareDates(a.date, b.date) || a.sequence - b.sequence
}

/**
 * Everything wrong with the SET of movements, before any of them is valued.
 *
 * `WRONG_ITEM` is the guard against the `WHERE` clause somebody forgets: a card is about
 * one item, and a movement for another one would be averaged straight into it, producing
 * a plausible page with a wrong average and no way to see it. Cheap to check and
 * impossible to detect afterwards.
 */
function checkSet(itemId: string, movements: readonly StockMovement[]): InventoryProblem | null {
  const seen = new Set<number>()
  for (const movement of movements) {
    const dateProblem = checkMovementDate(movement)
    if (dateProblem !== null) {
      return dateProblem
    }
    if (movement.itemId !== itemId) {
      return refusal(
        'WRONG_ITEM',
        `This card is for item ${itemId} and a movement for ${movement.itemId} reached it.`,
        { itemId, found: movement.itemId, sequence: movement.sequence },
      )
    }
    if (seen.has(movement.sequence)) {
      return refusal(
        'DUPLICATE_SEQUENCE',
        `Two movements share sequence ${String(movement.sequence)}, so their order cannot be decided.`,
        { itemId, sequence: movement.sequence },
      )
    }
    seen.add(movement.sequence)
  }
  return null
}

/** What the card is adding up while it folds. */
interface MovementTotals {
  readonly quantityIn: Decimal[]
  readonly quantityOut: Decimal[]
  readonly costIn: Decimal[]
  readonly costOut: Decimal[]
}

/**
 * Which side of the card a movement lands on, as a total record over direction rather
 * than a conditional — CONVENTIONS §1.9. A third direction would not compile until it
 * was answered for, whereas an `if (direction === 'in')` would quietly give it whatever
 * the else branch said, and the two figures at the foot would still add up.
 */
const GATHER: Readonly<
  Record<StockDirection, (totals: MovementTotals, quantity: Decimal, cost: Decimal) => void>
> = {
  in: (totals, quantity, cost) => {
    totals.quantityIn.push(quantity)
    totals.costIn.push(cost)
  },
  out: (totals, quantity, cost) => {
    totals.quantityOut.push(quantity)
    totals.costOut.push(cost)
  },
}

/**
 * Fold an item's movements into a card.
 *
 * Pure and deterministic: the same movements in any order give the same card, which is
 * what makes it safe to recompute rather than store.
 */
export function runStockCard(
  strategy: ValuationStrategy,
  itemId: string,
  movements: readonly StockMovement[],
  opening: ValuationState = strategy.empty(),
): StockCard {
  const setProblem = checkSet(itemId, movements)
  if (setProblem !== null) {
    return emptyCard(strategy, itemId, opening, setProblem)
  }

  const ordered = [...movements].sort(inCardOrder)
  const rows: StockCardRow[] = []
  const totals: MovementTotals = { quantityIn: [], quantityOut: [], costIn: [], costOut: [] }

  let state = opening
  let problem: InventoryProblem | null = null

  for (const movement of ordered) {
    const outcome = strategy.applyMovement(state, movement)
    if (!outcome.ok) {
      problem = outcome.problem
      break
    }

    const { result } = outcome
    state = result.state
    rows.push({
      movement,
      cost: result.cost,
      quantity: state.quantity,
      value: state.value,
      unitCost: result.unitCost,
      slices: result.slices,
    })

    GATHER[directionOf(movement.kind)](totals, movement.quantity, result.cost)
  }

  return {
    itemId,
    method: strategy.method,
    opening,
    rows,
    closing: state,
    quantityIn: sum(totals.quantityIn),
    quantityOut: sum(totals.quantityOut),
    costIn: sum(totals.costIn),
    costOut: sum(totals.costOut),
    problem,
  }
}

function emptyCard(
  strategy: ValuationStrategy,
  itemId: string,
  opening: ValuationState,
  problem: InventoryProblem,
): StockCard {
  return {
    itemId,
    method: strategy.method,
    opening,
    rows: [],
    closing: opening,
    quantityIn: ZERO,
    quantityOut: ZERO,
    costIn: ZERO,
    costOut: ZERO,
    problem,
  }
}
