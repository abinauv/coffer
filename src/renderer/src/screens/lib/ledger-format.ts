/*
 * Formatting figures for the ledger screens.
 *
 * THE RENDERER NEVER COMPUTES WITH MONEY (CONVENTIONS §1). Every amount arriving here is
 * an exact decimal string produced by main, and everything below turns one into text.
 * Nothing parses an amount into a `number` — not even to format it — because that is
 * precisely the conversion the whole storage layer exists to avoid, and a formatter is a
 * plausible-looking place for it to creep back in.
 *
 * THE GROUPING COMES FROM THE REGIME, and every function that writes one takes it. It
 * used to be the Indian lakh/crore convention, hard-coded with a note admitting that a
 * user anywhere else saw the wrong separators. `regime.describe()` answers it now, so
 * the parameter is REQUIRED rather than defaulted: a default would be the same bug with
 * better manners, and a call site that has not been given a format should fail to
 * compile rather than quietly render 1,234,567 as 12,34,567.
 */

import type { BadgeTone } from '@renderer/components/atoms'
import type { DecimalString, NumberFormat, PeriodStatus } from '@shared/dto'

/**
 * Group a run of digits the way the regime groups them.
 *
 * `groupSizes` is read from the right and the last entry repeats: `[3, 2]` gives the
 * Indian `12,34,567` and `[3]` gives `1,234,567`. Written on the string rather than by
 * dividing, because the input can be longer than a `number` represents exactly and the
 * point of this file is that nothing converts.
 */
export function groupDigits(digits: string, format: NumberFormat): string {
  const parts: string[] = []
  let rest = digits

  for (let index = 0; rest.length > 0; index += 1) {
    const size = format.groupSizes[Math.min(index, format.groupSizes.length - 1)]
    /*
     * No sizes, or a nonsensical one — and MEASURED, because the obvious guess about
     * which one is dangerous is wrong. A size of 0 is harmless: `slice(0, -0)` is `''`,
     * not the whole string, so the loop drains and stops. A NEGATIVE size is the one
     * that hangs — `slice(0, -(-2))` grows nothing and `rest` never empties, so the
     * window locks up. The rule arrives from main out of a compliance pack that Phase 5
     * loads at runtime, so `<= 0` covers both and neither is theoretical.
     *
     * `<=` rather than `<` on the length: provably the same answer either way, since a
     * run exactly one group long splits into itself and an empty remainder. Kept as
     * `<=` because "this fits in one group" is what the line means. Recorded as an
     * equivalent mutant so the next mutation pass does not re-investigate it.
     */
    if (size === undefined || size <= 0 || rest.length <= size) {
      parts.unshift(rest)
      break
    }
    parts.unshift(rest.slice(-size))
    rest = rest.slice(0, -size)
  }

  return parts.join(format.groupSeparator)
}

/**
 * An amount as it appears in a column: grouped, always two places, minus sign kept.
 *
 * Returns the input unchanged when it is not a decimal string. A figure that main has
 * not vouched for should look wrong rather than be quietly rendered as something
 * plausible.
 */
export function formatAmount(value: DecimalString, format: NumberFormat): string {
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return value

  const isNegative = value.startsWith('-')
  const unsigned = isNegative ? value.slice(1) : value
  const [whole = '0', fraction = ''] = unsigned.split('.')
  const places = fraction.padEnd(2, '0').slice(0, 2)

  /* The minus sign is not the regime's to choose. `figureSign` in lib/figures.ts reads
   * it back off this string to colour the cell, and a locale-specific sign would have to
   * be taught there too — CONVENTIONS §1.7 keeps that scan to one place. */
  return `${isNegative ? '-' : ''}${groupDigits(whole, format)}${format.decimalSeparator}${places}`
}

/**
 * The same, but a zero renders as nothing.
 *
 * A trial balance has a debit column and a credit column, and every row is blank in one
 * of them. Printing `0.00` in every other cell doubles the ink and makes the column that
 * matters harder to scan — the convention on paper is to leave it empty, and the
 * convention is right.
 */
export function formatAmountOrBlank(value: DecimalString, format: NumberFormat): string {
  return isZeroAmount(value) ? '' : formatAmount(value, format)
}

/** True for any spelling of zero: '0', '0.00', '-0.00'. */
export function isZeroAmount(value: DecimalString): boolean {
  return /^-?0+(?:\.0+)?$/.test(value)
}

/** True when the amount is below zero. Text only — nothing is parsed. */
export function isNegativeAmount(value: DecimalString): boolean {
  return value.startsWith('-') && !isZeroAmount(value)
}

// ---- Words for the ledger's vocabulary ------------------------------------

const ACCOUNT_TYPE_LABELS: Readonly<Record<string, string>> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
  income: 'Income',
  expense: 'Expenses',
}

/** The plural heading a section of the chart or a trial balance sits under. */
export function accountTypeLabel(type: string): string {
  return ACCOUNT_TYPE_LABELS[type] ?? type
}

/**
 * The order the five types are read in.
 *
 * Balance sheet first, then the profit and loss — the order every set of printed
 * accounts uses, and the order the accounting equation is stated in.
 */
export const ACCOUNT_TYPE_ORDER: readonly string[] = [
  'asset',
  'liability',
  'equity',
  'income',
  'expense',
]

export function accountTypeRank(type: string): number {
  const index = ACCOUNT_TYPE_ORDER.indexOf(type)
  return index === -1 ? ACCOUNT_TYPE_ORDER.length : index
}

const PERIOD_STATUS_LABELS: Readonly<Record<string, string>> = {
  open: 'Open',
  closed: 'Closed',
  locked: 'Locked',
}

export function periodStatusLabel(status: string): string {
  return PERIOD_STATUS_LABELS[status] ?? status
}

/*
 * Tone for the badge beside a period.
 *
 * TYPED AS `BadgeTone`, WHICH IS THE WHOLE POINT. This returned `'info'` until 0016, and
 * `'info'` is not one of the atom's five tones: `.badge--info` has no rule in atoms.css,
 * so the first caller would have got an unstyled pill and the first `<Badge>` it was
 * handed to would not have compiled. `statusTone` in document-view.ts is the same
 * function done right, and this is now spelled the same way.
 *
 * NEITHER CLOSED NOR LOCKED IS A JUDGEMENT, SO NEITHER IS COLOURED AS ONE. Of the tones
 * that remain once `neutral` is spoken for, `positive`, `negative` and `warning` all say
 * something about whether the state is good, and `accent` is this palette's "there is
 * still something to do here" — the word document-view puts on a DRAFT. A locked period
 * is the state with least left to do in the product; accenting it would light up exactly
 * the rows that want nothing from the reader. So the quiet tone carries both, and the
 * LABEL carries the difference between them, which is the rule the Badge atom already
 * states: tone is never the only signal.
 *
 * A total record over `PeriodStatus` rather than an if-chain (CONVENTIONS §1.9) — a
 * fourth period state cannot reach a badge without someone deciding how it reads. The
 * parameter stays `string`, as `periodStatusLabel` next door does, because a status
 * arriving from a future migration should render quietly rather than crash a register.
 */
const PERIOD_STATUS_TONES: Readonly<Record<PeriodStatus, BadgeTone>> = {
  open: 'positive',
  closed: 'neutral',
  locked: 'neutral',
}

export function periodStatusTone(status: string): BadgeTone {
  return PERIOD_STATUS_TONES[status as PeriodStatus] ?? 'neutral'
}
