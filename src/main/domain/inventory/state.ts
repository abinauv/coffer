/*
 * The checks every strategy runs before it values anything, and the empty state it
 * starts from.
 *
 * These live outside the strategies because they are not opinions about costing — they
 * are the shape of a stock file, and a second strategy that reimplemented them would be
 * a second chance to get one of them wrong. `moving-average.ts` calls both; FIFO will
 * call the same two.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STATE IS CHECKED AT ALL, GIVEN THAT THIS MODULE PRODUCES IT
 *
 * Because this module is not the only thing that will produce it. A stock file is read
 * back from a table between sessions, and a state that arrives holding value against no
 * quantity, or layers that do not add up to the aggregate they break down, is the
 * signature of the stock register and the general ledger having diverged. That is the
 * one condition perpetual inventory exists to make impossible (ARCHITECTURE §6.4), so it
 * has to be NAMED rather than divided by.
 *
 * Every check here is reachable by handing the function the bad state directly, and each
 * is a separate condition with a separate code, because a guard no test can reach is a
 * guard that is not there (CONVENTIONS §6).
 */

import { SCALE, ZERO, sum, type Decimal } from '@main/domain/money'
import { isDateString } from '@main/domain/time'
import { unitCostOf } from './cost'
import {
  costSourceOf,
  refusal,
  type CostSource,
  type InventoryProblem,
  type StockLayer,
  type StockMovement,
  type ValuationState,
} from './types'

/** An item holding nothing: no quantity, no value, and no layers to hold either. */
export const EMPTY_STOCK: ValuationState = Object.freeze({
  quantity: ZERO,
  value: ZERO,
  layers: Object.freeze([]) as readonly StockLayer[],
})

/**
 * Average cost per unit of a whole state. ZERO when nothing is on hand — see `cost.ts`.
 */
export function unitCostOfState(state: ValuationState): Decimal {
  return unitCostOf(state.quantity, state.value)
}

/**
 * What is wrong with this state, or null.
 *
 * The order is deliberate: finiteness first, because every check after it would read a
 * NaN as "not negative" and "not more than three decimal places" and wave it through;
 * then the aggregate; then the breakdown.
 */
export function checkState(state: ValuationState): InventoryProblem | null {
  if (!state.quantity.isFinite() || !state.value.isFinite()) {
    return refusal(
      'NOT_FINITE',
      'The stock on hand is not a number. The stock register cannot be read.',
      { quantity: state.quantity.toString(), value: state.value.toString() },
    )
  }

  if (state.quantity.decimalPlaces() > SCALE.quantity) {
    return refusal(
      'SCALE_EXCEEDED',
      `Stock on hand is held to ${String(SCALE.quantity)} decimal places, but the quantity carries ${String(state.quantity.decimalPlaces())}.`,
      { quantity: state.quantity.toString() },
    )
  }

  if (state.value.decimalPlaces() > SCALE.money) {
    return refusal(
      'SCALE_EXCEEDED',
      `Stock value is held to ${String(SCALE.money)} decimal places, but the value carries ${String(state.value.decimalPlaces())}.`,
      { value: state.value.toString() },
    )
  }

  if (state.quantity.isNegative() && !state.quantity.isZero()) {
    return refusal(
      'NEGATIVE_QUANTITY_ON_HAND',
      `The stock register shows ${state.quantity.toString()} on hand. Stock cannot be negative; the register and the ledger have diverged.`,
      { quantity: state.quantity.toString() },
    )
  }

  if (state.value.isNegative() && !state.value.isZero()) {
    return refusal(
      'NEGATIVE_VALUE_ON_HAND',
      `The stock register values what is on hand at ${state.value.toString()}. Stock cannot be worth less than nothing; the register and the ledger have diverged.`,
      { value: state.value.toString() },
    )
  }

  /*
   * Invariant 6, and only in this direction. Quantity with no value is ordinary — a free
   * sample taken in at nil, or an item written down to nothing — and refusing it would
   * refuse a transaction people enter. Value with no quantity is not a fact about
   * anything: no movement in this module can produce it, so a state carrying it was
   * written by something else.
   */
  if (state.quantity.isZero() && !state.value.isZero()) {
    return refusal(
      'VALUE_WITHOUT_QUANTITY',
      `The stock register holds a value of ${state.value.toString()} against nothing on hand. The register and the ledger have diverged.`,
      { value: state.value.toString() },
    )
  }

  return checkLayers(state)
}

/**
 * Whether the breakdown agrees with the aggregate it breaks down.
 *
 * Both are stored rather than one derived from the other, precisely so that this can be
 * false and be reported. Derive the aggregate from the layers and a corrupt file becomes
 * a plausible-looking one.
 */
function checkLayers(state: ValuationState): InventoryProblem | null {
  for (const layer of state.layers) {
    if (!layer.quantity.isFinite() || !layer.value.isFinite()) {
      return refusal('NOT_FINITE', `Layer ${layer.key} does not hold a number.`, {
        layer: layer.key,
        quantity: layer.quantity.toString(),
        value: layer.value.toString(),
      })
    }
    if (layer.quantity.isNegative() && !layer.quantity.isZero()) {
      return refusal(
        'NEGATIVE_QUANTITY_ON_HAND',
        `Layer ${layer.key} holds ${layer.quantity.toString()}. Stock cannot be negative.`,
        { layer: layer.key, quantity: layer.quantity.toString() },
      )
    }
    if (layer.value.isNegative() && !layer.value.isZero()) {
      return refusal(
        'NEGATIVE_VALUE_ON_HAND',
        `Layer ${layer.key} is valued at ${layer.value.toString()}. Stock cannot be worth less than nothing.`,
        { layer: layer.key, value: layer.value.toString() },
      )
    }
  }

  const layerQuantity = sum(state.layers.map((layer) => layer.quantity))
  if (!layerQuantity.equals(state.quantity)) {
    return refusal(
      'LAYERS_DISAGREE',
      `The stock register shows ${state.quantity.toString()} on hand but its layers add up to ${layerQuantity.toString()}.`,
      { quantity: state.quantity.toString(), layers: layerQuantity.toString() },
    )
  }

  const layerValue = sum(state.layers.map((layer) => layer.value))
  if (!layerValue.equals(state.value)) {
    return refusal(
      'LAYERS_DISAGREE',
      `The stock register values what is on hand at ${state.value.toString()} but its layers add up to ${layerValue.toString()}.`,
      { value: state.value.toString(), layers: layerValue.toString() },
    )
  }

  return null
}

/**
 * The cost an inward movement stated. ZERO for an outward movement, which states none
 * and is valued by the strategy instead.
 *
 * ONLY SAFE AFTER `checkMovement` HAS PASSED, and the coupling is the point: it is
 * `COST_PRESENCE` below that refuses an inward movement carrying no cost, and this is
 * the function that would otherwise have to invent a zero for it. Deleting that refusal
 * would make a receipt with no cost value stock at nothing, and the test pinning
 * `COST_REQUIRED` is what stops it.
 */
export function statedCostOf(movement: StockMovement): Decimal {
  return movement.cost ?? ZERO
}

/**
 * Who has to supply the cost, as a total record over `CostSource` rather than a
 * conditional on direction — CONVENTIONS §1.9. A third source (a standard cost taken
 * from the item master, say) would not compile until it was answered for here.
 */
const COST_PRESENCE: Readonly<
  Record<CostSource, (movement: StockMovement) => InventoryProblem | null>
> = {
  stated: (movement) =>
    movement.cost === null
      ? refusal(
          'COST_REQUIRED',
          `A ${movement.kind} must say what the stock cost. Enter the value of the goods received.`,
          { kind: movement.kind },
        )
      : null,
  valued: (movement) =>
    movement.cost === null
      ? null
      : refusal(
          'COST_NOT_PERMITTED',
          `A ${movement.kind} leaves stock at the cost the register already holds; it cannot be given one of ${movement.cost.toString()}.`,
          { kind: movement.kind, cost: movement.cost.toString() },
        ),
}

/**
 * Whether the movement is dated at all.
 *
 * Its own function because `runStockCard` needs the answer BEFORE it sorts: the card is
 * folded in date order, `compareDates` throws on text that is not a date, and a movement
 * with no valid date has no place in that order to be folded into. Checked in one place
 * so the two callers cannot come to different conclusions.
 */
export function checkMovementDate(movement: StockMovement): InventoryProblem | null {
  if (isDateString(movement.date)) {
    return null
  }
  return refusal(
    'INVALID_DATE',
    `${JSON.stringify(movement.date)} is not a date. A stock movement is valued as at a day.`,
    { kind: movement.kind, date: String(movement.date) },
  )
}

/**
 * What is wrong with this movement before any strategy looks at it, or null.
 *
 * Scale is REJECTED, not rounded away. A movement arriving with four decimal places of
 * quantity did not come from a document line — a line fixed its quantity at 3dp and its
 * amount at 2dp at its own rounding point — it came from arithmetic somebody did on the
 * way here. Rounding it silently would mean the card recomputed from the stored rows no
 * longer equals the card that was computed when they were written, which is the one
 * property a perpetual system has to keep. Same reasoning as `parseAt` in `domain/money`.
 */
export function checkMovement(movement: StockMovement): InventoryProblem | null {
  const dateProblem = checkMovementDate(movement)
  if (dateProblem !== null) {
    return dateProblem
  }

  if (!movement.quantity.isFinite()) {
    return refusal('NOT_FINITE', 'The movement quantity is not a number.', {
      kind: movement.kind,
      quantity: movement.quantity.toString(),
    })
  }

  /* Invariant 3: a movement carries how much moved; which way is on the kind. */
  if (movement.quantity.isNegative() && !movement.quantity.isZero()) {
    return refusal(
      'NEGATIVE_QUANTITY',
      `A movement quantity cannot be negative (${movement.quantity.toString()}). Use the movement kind to say which way the stock went.`,
      { kind: movement.kind, quantity: movement.quantity.toString() },
    )
  }

  if (movement.quantity.decimalPlaces() > SCALE.quantity) {
    return refusal(
      'SCALE_EXCEEDED',
      `Quantities are held to ${String(SCALE.quantity)} decimal places, but this movement carries ${String(movement.quantity.decimalPlaces())}.`,
      { kind: movement.kind, quantity: movement.quantity.toString() },
    )
  }

  const presence = COST_PRESENCE[costSourceOf(movement.kind)](movement)
  if (presence !== null) {
    return presence
  }

  const cost = movement.cost
  if (cost === null) {
    return null
  }

  if (!cost.isFinite()) {
    return refusal('NOT_FINITE', 'The movement cost is not a number.', {
      kind: movement.kind,
      cost: cost.toString(),
    })
  }

  if (cost.isNegative() && !cost.isZero()) {
    return refusal(
      'NEGATIVE_COST',
      `A movement cost cannot be negative (${cost.toString()}). Use the movement kind to say which way the stock went.`,
      { kind: movement.kind, cost: cost.toString() },
    )
  }

  if (cost.decimalPlaces() > SCALE.money) {
    return refusal(
      'SCALE_EXCEEDED',
      `Amounts are held to ${String(SCALE.money)} decimal places, but this movement carries ${String(cost.decimalPlaces())}.`,
      { kind: movement.kind, cost: cost.toString() },
    )
  }

  return null
}
