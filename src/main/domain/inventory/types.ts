/*
 * The inventory contract — what a stock movement is, what a valuation strategy is, and
 * the state a stock file is in between two movements.
 *
 * Types and pure definitions only: no I/O, no clock, no ids generated here, and nothing
 * that knows a tax regime or a database exists. Every function takes its data as an
 * argument (CONVENTIONS §1.2).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS INTERFACE WAS DESIGNED AGAINST
 *
 * ARCHITECTURE §6.4 ships moving weighted average in v1 and promises FIFO and
 * batch/expiry later BEHIND THE SAME INTERFACE. That promise is the only reason this
 * file is separate from `moving-average.ts`, so it is written against the two strategies
 * that do NOT exist yet rather than the one that does. An interface shaped around the
 * method that needs least state is an interface the method that needs most will rewrite.
 *
 *   FIFO NEEDS IDENTIFIABLE LAYERS. A receipt creates a layer carrying its own cost; an
 *   issue consumes the oldest layers and its cost is the sum of the slices it took out
 *   of each. That is why `ValuationState` carries `layers` and why `ValuationResult`
 *   reports `slices`: a FIFO issue's cost is not `quantity × one unit cost` and never
 *   was, so a result that reported only a unit cost would have to grow a second shape.
 *
 *   MOVING AVERAGE IS NOT A DIFFERENT SHAPE — IT IS THIS SHAPE WITH ONE LAYER. The pool
 *   (`POOLED_LAYER_KEY`) is a single layer re-averaged on every receipt. Writing it that
 *   way is what makes the claim "FIFO arrives without touching a call site" testable
 *   rather than aspirational: the same `layers` and the same `slices` are already being
 *   produced and consumed today.
 *
 *   BATCH/EXPIRY NEEDS A LAYER KEY ON THE MOVEMENT AND A BATCH ON THE LAYER. A pharmacy
 *   issues *from batch B-2291*, and an expiry report reads the batch off each layer
 *   still on hand. So `StockMovement` may name a layer and a batch, and a strategy that
 *   cannot honour them REFUSES the movement (`identifiesLayers`, `tracksBatches`)
 *   instead of accepting the fields and silently dropping them. A batch number recorded
 *   against a pool is a number nothing can ever act on.
 *
 * ---------------------------------------------------------------------------
 * THE SEVEN INVARIANTS
 *
 * 1. THE STATE OF RECORD IS (QUANTITY, VALUE) — NEVER (QUANTITY, UNIT COST). Value is
 *    what the balance sheet carries and what the general ledger posted, so value is what
 *    the stock file holds. Unit cost is DERIVED from the two, reported for a column, and
 *    never an input to any figure. Hold the unit cost instead and the arithmetic goes:
 *    100.00 over 3.000 units is 33.33 a unit at money scale, three units leave at 99.99,
 *    and a paisa is stranded in an item that is now empty. Do it twice a day for a year
 *    and the stock register and the ledger have quietly parted company. See `cost.ts`.
 *
 * 2. AN ISSUE DOES NOT MOVE THE AVERAGE. A receipt at a new cost re-averages the pool;
 *    an issue leaves at the average that is already there and reduces quantity and value
 *    together. This is what "weighted average" means and it is the rule a naive
 *    implementation breaks first, by recomputing an average it had no business touching.
 *
 * 3. A MOVEMENT'S DIRECTION IS ON ITS KIND, NEVER ON THE SIGN OF ITS QUANTITY. Quantity
 *    and cost on a movement are both non-negative; `STOCK_MOVEMENT_KINDS` says which way
 *    the stock went. CONVENTIONS §1.10 in its inventory form — a sign read off the row's
 *    kind survives a new kind being added, and a sign read off "the query that fetched
 *    it" or off a minus somebody remembered to put in does not.
 *
 * 4. WHO SUPPLIES THE COST IS DECIDED BY DIRECTION, AND BY A TOTAL RECORD. Inward
 *    movements STATE their cost (a purchase bill line already fixed it at money scale, a
 *    sales return brings back the cost it left at). Outward movements are VALUED by the
 *    strategy and may not carry a cost at all — accepting one would let a caller price a
 *    sale at whatever it liked, and the stock register would stop reconciling with the
 *    ledger in a way no report could show. See `COST_SOURCE`.
 *
 * 5. NEGATIVE STOCK IS REFUSED, NOT PRICED. See `INSUFFICIENT_STOCK` below.
 *
 * 6. VALUE CANNOT EXIST WITHOUT QUANTITY. QUANTITY CAN EXIST WITHOUT VALUE. The
 *    asymmetry is real and deliberate: stock held at nil is an ordinary fact — a free
 *    sample taken in at zero, or an item written down to nothing — and refusing it would
 *    refuse a transaction people actually enter. Value with nothing to hold it is not a
 *    fact about anything; no movement in this module can produce it, so a state carrying
 *    it came from somewhere else and means the stock register and the ledger have
 *    diverged. `checkState` says so instead of dividing by zero.
 *
 * 7. THE STOCK CARD IS RECOMPUTED, NEVER STORED. The same rule as the running ledger
 *    balance (`domain/reports/running.ts`), and it bites for the same reason: a
 *    back-dated receipt re-averages every movement after it, so a stored running average
 *    is wrong from the moment a delivery note arrives a week late. `runStockCard` folds
 *    from an opening state every time, in date-then-sequence order, whatever order the
 *    movements arrived in.
 */

import type { Decimal } from '@main/domain/money'
import type { DateString } from '@shared/scalars'

// ---- Methods ---------------------------------------------------------------

/**
 * How an item is costed. Persisted per item, so the union is closed and the two members
 * with no strategy behind them yet are named here on purpose — a company file written by
 * a later build must be recognisably a later build, not an unknown string.
 *
 * There is deliberately NO `Record<ValuationMethod, ValuationStrategy>` registry in this
 * phase. A lookup over one member cannot be wrong yet, and writing it now would freeze
 * the construction shape before FIFO has had a chance to argue with it. When the second
 * strategy lands, the registry is a total record (CONVENTIONS §1.9) and the compiler
 * will not let the third be forgotten.
 */
export type ValuationMethod = 'moving-average' | 'fifo' | 'batch'

// ---- Movement kinds --------------------------------------------------------

/** Which way stock moved. Invariant 3: this is on the kind, never on a minus sign. */
export type StockDirection = 'in' | 'out'

/** Who decides what the movement cost. Invariant 4. */
export type CostSource = 'stated' | 'valued'

/**
 * Every kind of stock movement.
 *
 * Closed, because an unknown kind in a company file means the file was written by a
 * newer build and the stock card should say so rather than value it as whatever the last
 * branch happened to be.
 *
 * A movement KIND is not a source document type: one `stock-adjustment` document raises
 * `adjustment-in` for a stock-take surplus and `adjustment-out` for shrinkage, and one
 * `credit-note` raises `sales-return` here and something else entirely in the ledger.
 * Neither derives from the other, so neither is stored on the other.
 */
export type StockMovementKind =
  | 'opening'
  | 'receipt'
  | 'issue'
  | 'purchase-return'
  | 'sales-return'
  | 'adjustment-in'
  | 'adjustment-out'

export interface StockMovementKindDefinition {
  readonly kind: StockMovementKind
  /** What a stock card calls it. */
  readonly label: string
  readonly direction: StockDirection
}

/**
 * The table. A total record over the union, not a chain of conditionals — CONVENTIONS
 * §1.9: the two are indistinguishable while the union is small and stop being the same
 * thing the moment somebody adds a member.
 */
export const STOCK_MOVEMENT_KINDS: Readonly<
  Record<StockMovementKind, StockMovementKindDefinition>
> = {
  opening: { kind: 'opening', label: 'Opening stock', direction: 'in' },
  receipt: { kind: 'receipt', label: 'Receipt', direction: 'in' },
  issue: { kind: 'issue', label: 'Issue', direction: 'out' },
  'purchase-return': { kind: 'purchase-return', label: 'Purchase return', direction: 'out' },
  'sales-return': { kind: 'sales-return', label: 'Sales return', direction: 'in' },
  'adjustment-in': { kind: 'adjustment-in', label: 'Adjustment in', direction: 'in' },
  'adjustment-out': { kind: 'adjustment-out', label: 'Adjustment out', direction: 'out' },
} as const

export const STOCK_MOVEMENT_KIND_LIST: readonly StockMovementKind[] = [
  'opening',
  'receipt',
  'issue',
  'purchase-return',
  'sales-return',
  'adjustment-in',
  'adjustment-out',
] as const

/**
 * Who supplies the cost, by direction. A total record rather than `direction === 'in'`,
 * and DERIVED rather than a third field on `STOCK_MOVEMENT_KINDS` — storing it beside
 * the direction would be a second place for it to be wrong, and the two would agree
 * right up until they did not. Same reasoning as `levyOf` in `domain/documents/types.ts`.
 */
export const COST_SOURCE: Readonly<Record<StockDirection, CostSource>> = {
  in: 'stated',
  out: 'valued',
} as const

export function definitionOf(kind: StockMovementKind): StockMovementKindDefinition {
  return STOCK_MOVEMENT_KINDS[kind]
}

export function directionOf(kind: StockMovementKind): StockDirection {
  return STOCK_MOVEMENT_KINDS[kind].direction
}

export function costSourceOf(kind: StockMovementKind): CostSource {
  return COST_SOURCE[directionOf(kind)]
}

// ---- Layers ----------------------------------------------------------------

/** A batch as the stock file identifies it. Meaningful only to a batch-tracking strategy. */
export interface BatchRef {
  /** The batch or lot number printed on the goods. */
  readonly code: string
  /** Null for goods that do not expire. */
  readonly expiresOn: DateString | null
}

/**
 * A parcel of stock with a cost of its own.
 *
 * FIFO has one per unconsumed receipt; a batch strategy has one per batch; moving
 * average has exactly one, keyed `POOLED_LAYER_KEY`, holding everything on hand.
 *
 * `receivedAt` and `sequence` are what a FIFO strategy orders by, and they are NULLABLE
 * because the pooled layer genuinely has no single origin. A pool that reported the date
 * of its last receipt would be answering "when did this arrive?" with a number that is
 * true of some of the stock and false of the rest, which is worse than declining to
 * answer.
 */
export interface StockLayer {
  /** Opaque to everything above; only the strategy that made it assigns meaning. */
  readonly key: string
  /** Quantity remaining in this layer, at quantity scale. */
  readonly quantity: Decimal
  /** Value remaining in this layer, at money scale. */
  readonly value: Decimal
  /** When it entered stock. Null for a pooled layer. */
  readonly receivedAt: DateString | null
  /** Sequence of the movement that created it. Null for a pooled layer. */
  readonly sequence: number | null
  /** Null unless the strategy tracks batches. */
  readonly batch: BatchRef | null
}

/** How much of one layer a movement moved. One entry under moving average; several under FIFO. */
export interface LayerSlice {
  readonly key: string
  /** Quantity into or out of that layer. Non-negative; the direction is the movement's. */
  readonly quantity: Decimal
  /** Value into or out of that layer, at money scale. Non-negative. */
  readonly value: Decimal
}

// ---- State -----------------------------------------------------------------

/**
 * What an item holds between two movements.
 *
 * `quantity` and `value` are the aggregate; `layers` is the same figure broken down.
 * Both are present rather than one derived from the other, because the aggregate is what
 * the balance sheet reconciles against and a state whose layers do not add up to it is
 * exactly the corruption `checkState` exists to catch — deriving the aggregate would
 * make that state unrepresentable and therefore undetectable.
 *
 * There is no `unitCost` field. It is `unitCostOf(state)`, computed in one place, so
 * there is nothing to drift.
 */
export interface ValuationState {
  /** On hand, at quantity scale. Never negative. */
  readonly quantity: Decimal
  /** Carrying value, at money scale. Never negative. */
  readonly value: Decimal
  readonly layers: readonly StockLayer[]
}

// ---- Movements -------------------------------------------------------------

/**
 * One stock movement, as the valuation sees it.
 *
 * Deliberately less than a stock ledger row: no source document, no narration, no id
 * generated here. What raised the movement matters to the drill-through and to the
 * posting rule, and neither of those is valuation's business.
 */
export interface StockMovement {
  /** Which item. `runStockCard` refuses a movement that is not the card's subject. */
  readonly itemId: string
  readonly kind: StockMovementKind
  /** The date the movement is valued as of. Decides its place in the card, and is not "now". */
  readonly date: DateString
  /**
   * Position in the item's own register, unique within it. The tiebreak within a date,
   * and the reason a card's order does not depend on the order rows came back in.
   */
  readonly sequence: number
  /** Non-negative, at quantity scale. Zero is legal — see `COST_WITHOUT_QUANTITY`. */
  readonly quantity: Decimal
  /**
   * What it cost, at money scale, non-negative. Required on an inward movement and
   * refused on an outward one — invariant 4.
   */
  readonly cost: Decimal | null
  /**
   * The layer this movement targets. Null means "the strategy chooses" — which is the
   * only thing moving average and FIFO can do, and the thing a batch strategy must not.
   */
  readonly layerKey: string | null
  /** The batch these goods belong to. Refused by a strategy that does not track batches. */
  readonly batch: BatchRef | null
}

// ---- Results ---------------------------------------------------------------

export interface ValuationResult {
  /** The item's state after the movement. */
  readonly state: ValuationState
  /**
   * What the movement moved, as money at 2dp, always non-negative.
   *
   * For an outward movement this is the figure that posts to cost of goods sold, and it
   * is REPORTED SEPARATELY from anything on the document that raised it. A purchase
   * return credits the supplier at the price paid and takes the stock out at the average
   * — the difference is a price variance, and a caller that assumed the two were the
   * same number would post books that do not balance.
   */
  readonly cost: Decimal
  /** Which layers moved, and by how much. Exactly one entry under moving average. */
  readonly slices: readonly LayerSlice[]
  /**
   * Average cost per unit AFTER the movement, at `UNIT_COST_SCALE`.
   *
   * A report column. Nothing in this module computes a value from it — see `cost.ts` for
   * why that is the whole point rather than an implementation detail.
   */
  readonly unitCost: Decimal
}

/** What a revaluation to net realisable value produced. */
export interface RevaluationResult {
  readonly state: ValuationState
  /**
   * What to post: the new value less the old. Negative for a write-down, which is the
   * ordinary case. The sign is already the sign to post, like `roundToWholeUnit`.
   */
  readonly adjustment: Decimal
  readonly unitCost: Decimal
}

// ---- Failures --------------------------------------------------------------

/**
 * Why a movement could not be valued.
 *
 * Every one of these is expected and actionable — the user can fix it — so they are
 * RETURNED, not thrown (CONVENTIONS §5). Issuing more than is on hand is not an
 * exceptional condition in a small business, it is Tuesday, and a `try`/`catch` at every
 * call site is how a message like "you have 4 on hand" turns into a stack trace.
 */
export type InventoryErrorCode =
  /**
   * The issue is larger than the quantity on hand.
   *
   * REFUSED RATHER THAN PRICED, and this is the load-bearing decision of the module.
   * Negative stock has no defensible cost: valuing it at the last average strands a
   * negative value that the next receipt silently absorbs, so that receipt's average is
   * wrong and no report can show why; valuing it at nil understates cost of goods sold
   * and flatters gross profit until somebody happens to look. ARCHITECTURE §6.4 requires
   * that stock value on the balance sheet always reconciles with the stock register, and
   * an invented cost on stock that is not there is precisely a figure that cannot. The
   * user's fix is real and immediate — enter the purchase that has not been entered yet,
   * or correct the quantity — which is the definition of an actionable failure.
   *
   * It is refused HERE, in the domain, and not by a database CHECK, because a CHECK sees
   * one row and this is a question about a running total.
   */
  | 'INSUFFICIENT_STOCK'
  /** The state handed in holds a negative quantity. No movement here can produce it. */
  | 'NEGATIVE_QUANTITY_ON_HAND'
  /** The state handed in holds a negative value. No movement here can produce it either. */
  | 'NEGATIVE_VALUE_ON_HAND'
  /** Nothing on hand, but a value against it. Invariant 6: the registers have diverged. */
  | 'VALUE_WITHOUT_QUANTITY'
  /** The layers do not add up to the aggregate they are a breakdown of. */
  | 'LAYERS_DISAGREE'
  /** A movement would leave value behind with no quantity to carry it. */
  | 'COST_WITHOUT_QUANTITY'
  /** A movement carries a negative quantity. Direction is on the kind — invariant 3. */
  | 'NEGATIVE_QUANTITY'
  /** A movement carries a negative cost. */
  | 'NEGATIVE_COST'
  /** An inward movement arrived with no cost. Invariant 4. */
  | 'COST_REQUIRED'
  /** An outward movement arrived carrying a cost. Invariant 4. */
  | 'COST_NOT_PERMITTED'
  /** A quantity or an amount with more decimal places than its column will hold. */
  | 'SCALE_EXCEEDED'
  /** A quantity or an amount that is NaN or infinite. */
  | 'NOT_FINITE'
  /** A movement whose date is not a calendar date, so it has no place in the card. */
  | 'INVALID_DATE'
  /** The movement names a layer this state does not hold. */
  | 'LAYER_NOT_FOUND'
  /** The movement names a batch and this strategy cannot honour it. */
  | 'BATCH_NOT_SUPPORTED'
  /** Two movements share a sequence, so their order would be the query's order. */
  | 'DUPLICATE_SEQUENCE'
  /** A movement for a different item reached this item's card. */
  | 'WRONG_ITEM'

/**
 * A refusal, in the vocabulary the IPC layer already speaks.
 *
 * `details` carries decimals as STRINGS, never as `Decimal` instances: this shape is
 * built to survive the trip to a screen, and CONVENTIONS §1.1 puts a decimal string at
 * every boundary.
 */
export interface InventoryProblem {
  readonly code: InventoryErrorCode
  /** What went wrong and what to do about it. Shown to the user. */
  readonly message: string
  readonly details: Readonly<Record<string, string | number | null>>
}

export type ValuationOutcome =
  | { readonly ok: true; readonly result: ValuationResult }
  | { readonly ok: false; readonly problem: InventoryProblem }

export type RevaluationOutcome =
  | { readonly ok: true; readonly result: RevaluationResult }
  | { readonly ok: false; readonly problem: InventoryProblem }

export function refusal(
  code: InventoryErrorCode,
  message: string,
  details: Readonly<Record<string, string | number | null>> = {},
): InventoryProblem {
  return { code, message, details }
}

// ---- The strategy ----------------------------------------------------------

/**
 * How an item is valued. The seam ARCHITECTURE §6.4 promises.
 *
 * Pure: the same state and the same movement give the same result, every time. No clock,
 * no randomness, no ids minted inside — which is what lets a whole stock card be written
 * down in a fixture and checked line by line, and what makes `runStockCard` able to
 * replay a year from the movements alone.
 *
 * There is no `quote` or `preview` method, and its absence is a consequence of that
 * purity rather than an omission: a caller that wants to know what an issue would cost
 * calls `applyMovement` and reads `result.cost` without keeping the state. A second
 * method computing the same figure is a second place for it to be computed differently.
 */
export interface ValuationStrategy {
  readonly method: ValuationMethod
  /** What a screen calls the method. */
  readonly label: string
  /**
   * Whether a movement may name the layer it comes out of. False for moving average and
   * for FIFO — both choose for themselves; true for a batch strategy, where the operator
   * picks the batch. A screen reads this to decide whether to offer the field at all.
   */
  readonly identifiesLayers: boolean
  /** Whether layers carry batch identity. False here; a screen hides the batch field. */
  readonly tracksBatches: boolean

  /** The state of an item holding nothing. */
  empty(): ValuationState

  /** Apply one movement to one state and report what it cost. */
  applyMovement(state: ValuationState, movement: StockMovement): ValuationOutcome

  /**
   * Write the stock on hand up or down to a stated total value — the lower-of-cost-and-
   * net-realisable-value adjustment, in the shape it is actually made.
   *
   * On the strategy rather than beside it, because it is genuinely strategy-specific:
   * moving average has one pool to restate, and FIFO must decide how a write-down lands
   * across layers whose costs differ. A free function would have to pick one answer for
   * both and would be wrong for one of them.
   */
  revalue(state: ValuationState, toValue: Decimal): RevaluationOutcome
}
