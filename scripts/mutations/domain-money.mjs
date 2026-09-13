/*
 * Mutations for src/main/domain/money — the pure arithmetic every figure in the product
 * passes through.
 *
 * A definitions file exists so that "I mutation-tested it" becomes something a reviewer
 * can re-run:
 *
 *   npm run mutate -- --defs domain-money
 *   npm run mutate -- --defs domain-money --only rounding-mode-half-down
 *   npm run mutate -- --defs domain-money --dry-run     # anchors only, no tests
 *
 * Run it AFTER `npm run format`. Anchors are literal text and prettier moves it.
 *
 * Every anchor must appear EXACTLY once in its file; the harness says `ANCHOR?` and
 * refuses to count it otherwise, rather than skipping it and reporting a clean page.
 */

export default {
  name: 'domain/money',

  /* vitest path filters. Narrow on purpose: the harness runs the suite once per
   * mutation, and the point of this set is the money primitives, not the whole app. */
  tests: ['src/main/domain/money'],
  project: 'main',

  /*
   * THE CANARY. `decimal.test.ts` pins the rounding mode two ways — once as the
   * constant itself and once by value, `D('2.5').toDecimalPlaces(0)` is `'3'` and
   * banker's rounding would say `'2'`. That second assertion is what makes this a
   * canary rather than a hope: it reads a VALUE, so it cannot pass while the rule is
   * wrong. If this one is not killed, the run never really ran and nothing below means
   * anything.
   */
  canary: {
    name: 'canary: bankers-rounding',
    file: 'src/main/domain/money/decimal.ts',
    anchor: '  rounding: DecimalJs.ROUND_HALF_UP,',
    replace: '  rounding: DecimalJs.ROUND_HALF_EVEN,',
    note: 'CONVENTIONS §3 and ARCHITECTURE §7: ties go away from zero, everywhere.',
  },

  mutations: [
    {
      name: 'money-stored-at-3dp',
      file: 'src/main/domain/money/scale.ts',
      anchor: '  money: 2,',
      replace: '  money: 3,',
      note: 'The money column is 2dp. A third place would reach the database.',
    },
    {
      name: 'rounding-mode-half-down',
      file: 'src/main/domain/money/scale.ts',
      anchor: 'export const ROUNDING_MODE = Decimal.ROUND_HALF_UP',
      replace: 'export const ROUNDING_MODE = Decimal.ROUND_HALF_DOWN',
      note: 'The single rounding mode in the product, used by every named rounding point.',
    },
    {
      name: 'allocation-rounds-away-from-zero',
      file: 'src/main/domain/money/allocate.ts',
      anchor: 'exactShare.toDecimalPlaces(scale, Decimal.ROUND_DOWN)',
      replace: 'exactShare.toDecimalPlaces(scale, Decimal.ROUND_UP)',
      note: 'Truncation is what keeps the residue the same sign as the total.',
    },
    {
      name: 'allocation-tiebreak-reversed',
      file: 'src/main/domain/money/allocate.ts',
      anchor: '(a, b) => b.shortfall.comparedTo(a.shortfall) || a.index - b.index,',
      replace: '(a, b) => b.shortfall.comparedTo(a.shortfall) || b.index - a.index,',
      note: 'Ties go to the earlier part, so a persisted split recomputes identically.',
    },
    {
      name: 'signed-zero-escapes',
      file: 'src/main/domain/money/decimal.ts',
      anchor: '  return value.isZero() ? ZERO : value',
      replace: '  return value',
      note: 'CONVENTIONS §1.7: a report must never print -0.00.',
    },
    {
      name: 'scale-guard-off-by-one',
      file: 'src/main/domain/money/storage.ts',
      anchor: '  if (places > scale) {',
      replace: '  if (places >= scale) {',
      note: 'Extra decimal places are rejected on read, not rounded away.',
    },
    {
      name: 'percentage-rate-divides-by-zero',
      file: 'src/main/domain/money/arithmetic.ts',
      anchor: '  if (denominator.isZero()) {\n    return ZERO\n  }\n',
      replace: '',
      note: 'A zero base is a real case; without the guard it becomes Infinity.',
    },
    {
      name: 'unsafe-integer-accepted',
      file: 'src/main/domain/money/decimal.ts',
      anchor: '    if (!Number.isSafeInteger(value)) {',
      replace: '    if (!Number.isFinite(value)) {',
      note: 'Beyond 2^53 a number is already approximate; it must be passed as a string.',
    },
    {
      name: 'decimal-pattern-accepts-junk',
      file: 'src/main/domain/money/decimal.ts',
      anchor: 'export const DECIMAL_STRING_PATTERN = /^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?$/',
      replace: 'export const DECIMAL_STRING_PATTERN = /^-?\\d*(?:\\.\\d+)?$/',
      note: 'The one gate on decimal text: no leading zeros, no empty string, no bare point.',
    },
    {
      name: 'allocation-refusal-message',
      file: 'src/main/domain/money/allocate.ts',
      anchor: "'Cannot allocate across zero parts.'",
      replace: "'Nope.'",
      note: 'Expected to SURVIVE: the tests assert the ERROR TYPE and read no message. That is a real gap and a small one — but it is exactly the shape CONVENTIONS §6 warns about, and it is why a canary must sit on a value rather than on prose.',
    },
    {
      name: 'assert-finite-default-subject',
      file: 'src/main/domain/money/decimal.ts',
      anchor: "export function assertFinite(value: Decimal, what = 'value'): Decimal {",
      replace: "export function assertFinite(value: Decimal, what = 'banana'): Decimal {",
      note: 'Expected to SURVIVE: every caller that can reach the throw passes its own subject, so the default is only ever used on the path that does not throw.',
    },
  ],
}
