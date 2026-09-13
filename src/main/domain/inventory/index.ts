/*
 * The inventory domain. Import from here, not from the individual files.
 *
 * Pure by construction and by lint rule: no Node built-in, no `electron`, nothing from
 * `db/`, `services/` or `ipc/`, and no tax regime. Every function takes the stock file
 * it is working on as an argument and returns the next one.
 *
 * Start at types.ts — the seven invariants at the top of it are the contract, and the
 * paragraph above them says what the strategy interface was designed against and why it
 * carries more shape than moving weighted average needs.
 */

export {
  COST_SOURCE,
  STOCK_MOVEMENT_KINDS,
  STOCK_MOVEMENT_KIND_LIST,
  costSourceOf,
  definitionOf,
  directionOf,
  refusal,
  type BatchRef,
  type CostSource,
  type InventoryErrorCode,
  type InventoryProblem,
  type LayerSlice,
  type RevaluationOutcome,
  type RevaluationResult,
  type StockDirection,
  type StockLayer,
  type StockMovement,
  type StockMovementKind,
  type StockMovementKindDefinition,
  type ValuationMethod,
  type ValuationOutcome,
  type ValuationResult,
  type ValuationState,
  type ValuationStrategy,
} from './types'

export { UNIT_COST_SCALE, roundUnitCost, shareOfCost, unitCostOf } from './cost'

export {
  EMPTY_STOCK,
  checkMovement,
  checkMovementDate,
  checkState,
  statedCostOf,
  unitCostOfState,
} from './state'

export { MOVING_AVERAGE, POOLED_LAYER_KEY, movingAverageState } from './moving-average'

export { runStockCard, type StockCard, type StockCardRow } from './stock-card'

export {
  COUNTER_ROLES,
  costChangesBetween,
  movementEntry,
  revaluationsFor,
  type CostChange,
  type MovementPosting,
  type Revaluation,
  type RevaluationNarration,
} from './posting'
