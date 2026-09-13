/*
 * Moving weighted average — the v1 strategy (ARCHITECTURE §6.4).
 *
 * ---------------------------------------------------------------------------
 * THE RULE, IN TWO SENTENCES
 *
 * A RECEIPT RE-AVERAGES: the new average is (value on hand + value received) over
 * (quantity on hand + quantity received). AN ISSUE DOES NOT: it leaves at the average
 * already on the file and reduces quantity and value together.
 *
 * The second sentence is the one implementations get wrong, because "recompute the
 * average" is the obvious thing to do after any movement and it is correct after exactly
 * half of them. Recomputing on an issue is a no-op only while the arithmetic is exact;
 * the moment a paisa is rounded it becomes a slow revaluation of stock nobody asked to
 * revalue. Here it cannot happen by construction: an issue is expressed as a share of
 * the VALUE leaving (`shareOfCost`), and the average is never an input to anything.
 *
 * ---------------------------------------------------------------------------
 * ONE LAYER, NOT NONE
 *
 * Moving average needs less state than FIFO, and the interface still carries FIFO's
 * shape (`types.ts`). Rather than leave `layers` empty and let it become dead weight
 * that Phase 4.2 has to bring to life, moving average IS the one-layer case: everything
 * on hand sits in a single pool keyed `POOLED_LAYER_KEY`, re-averaged on every receipt.
 * So the `layers` and `slices` a FIFO strategy will fill are already being produced and
 * already being asserted by tests, and the pool's null `receivedAt` is an honest answer
 * to a question this method cannot answer rather than a placeholder.
 *
 * The pool DISAPPEARS when the item empties, which is what makes the average reset a
 * structural fact rather than an arithmetic accident: an item at zero has no layers, so
 * the next receipt has nothing to average against and its own cost becomes the average.
 *
 * ---------------------------------------------------------------------------
 * RETURNS
 *
 * A PURCHASE RETURN LEAVES AT THE AVERAGE, like any other outward movement. It cannot do
 * anything else: the pool has no memory of which unit came from which supplier, so
 * taking the goods out at the price originally paid would leave a residue in the pool
 * that no later report could account for. The supplier is still credited with the price
 * paid — that figure is on the debit note, not here — and the difference between the two
 * is a price variance for the posting rule to place. This is why `ValuationResult.cost`
 * is reported separately from anything on the document.
 *
 * A SALES RETURN COMES BACK AT THE COST IT LEFT AT, which the caller states, taking it
 * from the original issue's recorded cost (`shareOfCost` computes the share for a
 * partial return). The alternative — bringing it back at today's average — would let the
 * passing of time change the gross profit on a sale that has already been made: goods
 * sold in April and returned in September, after the average has risen, would credit
 * cost of goods sold with more than was ever charged to it, and the difference is
 * invented. The cost of a sale is a fact about the day of the sale.
 */

import { SCALE, normaliseZero, type Decimal } from '@main/domain/money'
import { shareOfCost, unitCostOf } from './cost'
import { EMPTY_STOCK, checkMovement, checkState, statedCostOf } from './state'
import {
  directionOf,
  refusal,
  type RevaluationOutcome,
  type StockDirection,
  type StockLayer,
  type StockMovement,
  type ValuationOutcome,
  type ValuationState,
  type ValuationStrategy,
} from './types'

/**
 * The single layer moving average keeps. A constant, not a generated id: `domain/` mints
 * no identifiers (they would make a replay of the same movements produce a different
 * file), and there is only ever one of these per item anyway.
 */
export const POOLED_LAYER_KEY = 'pooled'

const NO_LAYERS: readonly StockLayer[] = Object.freeze([]) as readonly StockLayer[]

/**
 * The pool holding everything on hand, or no layers at all when the item is empty.
 *
 * An empty item keeps no zero-quantity pool. That is what makes `layers.length === 0`
 * mean "nothing on hand" and, more usefully, what makes the average reset visible in the
 * state rather than only in the arithmetic.
 */
function pooled(quantity: Decimal, value: Decimal): readonly StockLayer[] {
  if (quantity.isZero() && value.isZero()) {
    return NO_LAYERS
  }
  return [
    {
      key: POOLED_LAYER_KEY,
      quantity,
      value,
      receivedAt: null,
      sequence: null,
      batch: null,
    },
  ]
}

function settled(
  quantity: Decimal,
  value: Decimal,
  movement: StockMovement,
  cost: Decimal,
): ValuationOutcome {
  return {
    ok: true,
    result: {
      state: { quantity, value, layers: pooled(quantity, value) },
      cost,
      slices: [{ key: POOLED_LAYER_KEY, quantity: movement.quantity, value: cost }],
      unitCost: unitCostOf(quantity, value),
    },
  }
}

/**
 * Stock in, at a cost the caller states.
 *
 * Three cases that are all ordinary and all break something naive:
 *
 *   - A RECEIPT OF ZERO QUANTITY WITH A COST is freight or duty capitalised onto stock
 *     already on hand. Quantity is unchanged, value rises, and the average rises with
 *     it. Nothing divides by anything, so there is nothing to guard.
 *   - A RECEIPT AT ZERO COST is a free sample taken into stock at nil. Quantity rises,
 *     value does not, and the average FALLS. That is correct, and an implementation that
 *     refused a zero cost would refuse a delivery people actually receive.
 *   - THE TWO TOGETHER, ONTO AN EMPTY ITEM, is the one that cannot be allowed: a cost
 *     with no quantity to carry it would leave value against nothing on hand, which is
 *     invariant 6 and the exact signature of a diverged stock file. Refused here, at the
 *     point somebody could still fix it.
 */
function receive(state: ValuationState, movement: StockMovement): ValuationOutcome {
  const cost = statedCostOf(movement)
  const quantity = state.quantity.plus(movement.quantity)
  const value = state.value.plus(cost)

  if (quantity.isZero() && !value.isZero()) {
    return {
      ok: false,
      problem: refusal(
        'COST_WITHOUT_QUANTITY',
        `A cost of ${cost.toString()} cannot be added to an item holding nothing. Receive the goods first, or post the cost to an expense account.`,
        { kind: movement.kind, cost: cost.toString() },
      ),
    }
  }

  return settled(quantity, value, movement, cost)
}

/**
 * Stock out, valued by the file rather than by the caller.
 *
 * Refused when it is larger than what is on hand — see `INSUFFICIENT_STOCK` in
 * `types.ts` for why negative stock is refused rather than priced. The boundary is
 * inclusive: issuing exactly what is on hand is legal and clears the value to exactly
 * zero, because `shareOfCost` of the whole is the whole.
 */
function issue(state: ValuationState, movement: StockMovement): ValuationOutcome {
  if (movement.quantity.greaterThan(state.quantity)) {
    return {
      ok: false,
      problem: refusal(
        'INSUFFICIENT_STOCK',
        `There are ${state.quantity.toString()} on hand and this movement takes out ${movement.quantity.toString()}. Enter the receipt that is missing, or correct the quantity.`,
        {
          kind: movement.kind,
          onHand: state.quantity.toString(),
          requested: movement.quantity.toString(),
        },
      ),
    }
  }

  const cost = shareOfCost(state.value, movement.quantity, state.quantity)
  return settled(state.quantity.minus(movement.quantity), state.value.minus(cost), movement, cost)
}

/**
 * Which handler runs, as a total record over direction — CONVENTIONS §1.9. An eighth
 * movement kind cannot arrive without a direction, and a third direction cannot arrive
 * without an answer here.
 */
const APPLY: Readonly<
  Record<StockDirection, (state: ValuationState, movement: StockMovement) => ValuationOutcome>
> = {
  in: receive,
  out: issue,
}

function applyMovement(state: ValuationState, movement: StockMovement): ValuationOutcome {
  const stateProblem = checkState(state)
  if (stateProblem !== null) {
    return { ok: false, problem: stateProblem }
  }

  const movementProblem = checkMovement(movement)
  if (movementProblem !== null) {
    return { ok: false, problem: movementProblem }
  }

  /*
   * A batch number recorded against a pool is a number nothing can ever act on: the goods
   * lose their identity the moment they are averaged in, so no later issue can come out
   * of that batch and no expiry report can find it. Refusing says so while the operator
   * is still looking at the screen. This is what `tracksBatches: false` means in a form
   * the domain can enforce.
   */
  if (movement.batch !== null) {
    return {
      ok: false,
      problem: refusal(
        'BATCH_NOT_SUPPORTED',
        `This item is costed at moving average, which pools all stock together and cannot track batch ${movement.batch.code}. Change the item's costing method to track batches.`,
        { kind: movement.kind, batch: movement.batch.code },
      ),
    }
  }

  if (movement.layerKey !== null && movement.layerKey !== POOLED_LAYER_KEY) {
    return {
      ok: false,
      problem: refusal(
        'LAYER_NOT_FOUND',
        `This item holds one pool of stock and no layer named ${movement.layerKey}.`,
        { kind: movement.kind, layer: movement.layerKey },
      ),
    }
  }

  return APPLY[directionOf(movement.kind)](state, movement)
}

/**
 * Restate what is on hand at a new total value — the write-down to net realisable value.
 *
 * One pool, so the whole adjustment lands on it and the new average falls out of the new
 * value. A FIFO implementation of this method has a real decision to make about which
 * layers absorb the write-down; that is exactly why `revalue` is on the strategy and not
 * beside it.
 *
 * Writing stock down to nothing is legal — quantity survives a value of zero, invariant
 * 6 — but writing a value onto an item holding nothing is not.
 */
function revalue(state: ValuationState, toValue: Decimal): RevaluationOutcome {
  const stateProblem = checkState(state)
  if (stateProblem !== null) {
    return { ok: false, problem: stateProblem }
  }

  if (!toValue.isFinite()) {
    return {
      ok: false,
      problem: refusal('NOT_FINITE', 'The value to write stock to is not a number.', {
        value: toValue.toString(),
      }),
    }
  }

  if (toValue.isNegative() && !toValue.isZero()) {
    return {
      ok: false,
      problem: refusal(
        'NEGATIVE_VALUE_ON_HAND',
        `Stock cannot be written down to ${toValue.toString()}. The lowest it can be carried at is nothing.`,
        { value: toValue.toString() },
      ),
    }
  }

  if (toValue.decimalPlaces() > SCALE.money) {
    return {
      ok: false,
      problem: refusal(
        'SCALE_EXCEEDED',
        `Amounts are held to ${String(SCALE.money)} decimal places, but this value carries ${String(toValue.decimalPlaces())}.`,
        { value: toValue.toString() },
      ),
    }
  }

  if (state.quantity.isZero() && !toValue.isZero()) {
    return {
      ok: false,
      problem: refusal(
        'COST_WITHOUT_QUANTITY',
        `A value of ${toValue.toString()} cannot be carried against an item holding nothing.`,
        { value: toValue.toString() },
      ),
    }
  }

  return {
    ok: true,
    result: {
      state: {
        quantity: state.quantity,
        value: toValue,
        layers: pooled(state.quantity, toValue),
      },
      adjustment: normaliseZero(toValue.minus(state.value)),
      unitCost: unitCostOf(state.quantity, toValue),
    },
  }
}

/**
 * The strategy itself.
 *
 * `identifiesLayers` and `tracksBatches` are both false, and they are on the interface so
 * that a screen and a repository can ask rather than assume. Without them, offering a
 * batch field would mean knowing which method an item uses — and that knowledge in a
 * screen is the thing this seam exists to prevent.
 */
export const MOVING_AVERAGE: ValuationStrategy = {
  method: 'moving-average',
  label: 'Moving weighted average',
  identifiesLayers: false,
  tracksBatches: false,
  empty: () => EMPTY_STOCK,
  applyMovement,
  revalue,
}

/**
 * The state of an item holding a known quantity and value under moving average.
 *
 * What a repository builds when it reads an opening balance out of a table: one pool, or
 * no layers at all if there is nothing on hand. Produced here rather than assembled by
 * the caller so that the pool's key is decided in exactly one place.
 *
 * The state is NOT validated here. `applyMovement` validates whatever it is given, which
 * is what lets a test hand it a diverged file directly (CONVENTIONS §6) — a constructor
 * that refused to build one would make the state that matters most unrepresentable.
 */
export function movingAverageState(quantity: Decimal, value: Decimal): ValuationState {
  return { quantity, value, layers: pooled(quantity, value) }
}
