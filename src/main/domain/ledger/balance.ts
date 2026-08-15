/*
 * The balance check — invariant 1, in the one place every other layer defers to.
 *
 * Nothing here rounds. An entry's lines arrive at whatever precision the rule that built
 * them produced, and they must balance at that precision: if a rule allocates tax across
 * three components and the shares are rounded, they were rounded by `allocate`, which
 * guarantees they sum back to the original exactly. An entry that only balances after
 * rounding is an entry with a bug upstream, and rounding it here would hide it.
 *
 * See types.ts for the five invariants and for why the database enforces this one again.
 */

import { D, ZERO, type Decimal } from '@main/domain/money'
import type { EntryDraft, EntryLineDraft, EntryTotals, LedgerErrorCode } from './types'

/** Sum the debits and credits of a set of lines, at full precision. */
export function totalsOf(lines: readonly EntryLineDraft[]): EntryTotals {
  let debit: Decimal = ZERO
  let credit: Decimal = ZERO
  for (const line of lines) {
    debit = debit.plus(line.debit)
    credit = credit.plus(line.credit)
  }
  return { debit, credit, difference: debit.minus(credit) }
}

/** True when debits equal credits exactly. */
export function isBalanced(lines: readonly EntryLineDraft[]): boolean {
  return totalsOf(lines).difference.isZero()
}

/**
 * A line is well formed when both amounts are non-negative and exactly one is non-zero.
 *
 * A both-zero line is the one worth being strict about: it balances, it passes every
 * total, and it is almost always a row someone half-filled and forgot. Writing it into
 * the books makes the entry look like it says something it does not.
 */
export function checkLine(line: EntryLineDraft): LedgerErrorCode | null {
  const debit = D(line.debit)
  const credit = D(line.credit)
  if (debit.isNegative() || credit.isNegative()) {
    return 'NEGATIVE_AMOUNT'
  }
  if (debit.isZero() === credit.isZero()) {
    return 'AMBIGUOUS_LINE'
  }
  return null
}

/** A structural problem with a draft, and the line it is on where that applies. */
export interface DraftProblem {
  code: LedgerErrorCode
  /** 0-based index into `draft.lines`. Null for a problem with the entry as a whole. */
  lineIndex: number | null
}

/**
 * Everything structurally wrong with a draft, in one pass.
 *
 * All of them, not the first one: a user who typed a journal wants to see every line
 * that needs attention, not to fix one and be told about the next. Account existence,
 * group accounts and period status are not checked here — those need the database, and
 * `domain/` does not have one. The repository checks them, using the same error codes.
 */
export function checkDraft(draft: EntryDraft): DraftProblem[] {
  const problems: DraftProblem[] = []

  /* Two, not one. A single-line entry cannot balance unless it is zero, and a zero
   * entry is the both-zero line problem wearing a hat. */
  if (draft.lines.length < 2) {
    problems.push({ code: 'INSUFFICIENT_LINES', lineIndex: null })
  }

  draft.lines.forEach((line, index) => {
    const code = checkLine(line)
    if (code !== null) {
      problems.push({ code, lineIndex: index })
    }
  })

  /* Reported last, and only when the lines themselves are sound: a negative amount
   * makes the totals disagree too, and leading with "unbalanced" would point at the
   * symptom rather than the line that caused it. */
  if (problems.length === 0 && !isBalanced(draft.lines)) {
    problems.push({ code: 'UNBALANCED_ENTRY', lineIndex: null })
  }

  return problems
}

/**
 * The mirror of a set of lines: every debit becomes a credit and every credit a debit.
 *
 * This is the whole of what a reversal does to figures. The reversing entry gets its
 * own date, its own narration and its own number — it is a new entry that happens to
 * undo an old one, never an edit to the old one (invariant 3).
 */
export function reverseLines(lines: readonly EntryLineDraft[]): EntryLineDraft[] {
  return lines.map((line) => ({
    ...line,
    debit: line.credit,
    credit: line.debit,
  }))
}
