/*
 * Money primitives. Import from here, not from the individual files.
 *
 * The contract in one paragraph: every monetary, quantity and rate value is a `Decimal`
 * built by `D()`, arithmetic runs at full precision, rounding happens only at a named
 * point in `ROUNDING_POINTS`, and the value becomes a decimal string only at the
 * storage or IPC boundary via `toMoneyString` and friends. A JS `number` with a
 * fractional part cannot get in — see docs/CONVENTIONS.md §1.1.
 */

export {
  D,
  DECIMAL_STRING_PATTERN,
  Decimal,
  HUNDRED,
  MoneyError,
  ONE,
  PRECISION,
  ZERO,
  assertFinite,
  assertNonNegative,
  isDecimal,
  isDecimalString,
  normaliseZero,
  type DecimalInput,
  type MoneyErrorCode,
} from './decimal'

export {
  ROUNDING_MODE,
  ROUNDING_POINTS,
  SCALE,
  roundAt,
  roundMoney,
  roundQuantity,
  roundRate,
  roundToWholeUnit,
  scaleOf,
  unitAt,
  type RoundingPoint,
  type ScaleName,
  type WholeUnitRounding,
} from './scale'

export {
  decimalPlacesIn,
  parseAt,
  parseDecimalString,
  parseMoney,
  parseQuantity,
  parseRate,
  toMoneyString,
  toQuantityString,
  toRateString,
  toStorageString,
  tryParseDecimalString,
  type DecimalString,
} from './storage'

export {
  clamp,
  compare,
  equals,
  max,
  min,
  multiply,
  percentOf,
  percentageRate,
  subtractAll,
  sum,
} from './arithmetic'

export { allocate, allocateByWeights, type AllocationOptions } from './allocate'
