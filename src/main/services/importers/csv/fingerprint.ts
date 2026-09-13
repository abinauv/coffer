/*
 * A stable content fingerprint for one imported row, so a caller can tell whether it has
 * seen the row before.
 *
 * RE-IMPORTING THE SAME STATEMENT IS THE SINGLE MOST COMMON MISTAKE A USER MAKES with an
 * importer, and it is a quiet one: the second import balances exactly as well as the
 * first, so nothing complains and the bank balance is simply twice what it should be. It
 * is also easy to do by accident — a statement downloaded for March and then again as
 * part of a January-to-June range contains the same rows a second time.
 *
 * WHAT GOES IN, AND WHY EACH ONE:
 *
 *   the date        The day the transaction happened. The caller chooses WHICH date
 *                   column that is (a statement often has both a transaction date and a
 *                   value date) and must choose the same one every time — a fingerprint
 *                   built from the value date this month and the transaction date next
 *                   month agrees with nothing.
 *   the amount      Canonicalised to the money scale first, so `1,234.5`, `+1234.50` and
 *                   `1234.50` are one value. Without that, a re-export with different
 *                   number formatting reads as an entirely new statement.
 *   the narration   Folded: NFC, no invisibles, single spaces, lower case. A portal that
 *                   upper-cases its CSV export and title-cases its XLS export is
 *                   describing the same transaction both times.
 *   the reference   The bank's own identifier for the transaction where there is one —
 *                   a cheque number, a UTR, an RRN. This is the field that makes the
 *                   fingerprint sharp, because it is the only part that distinguishes
 *                   two genuinely separate transfers of the same amount on the same day.
 *
 * WHAT IS DELIBERATELY LEFT OUT, WHICH MATTERS MORE:
 *
 *   THE ROW'S POSITION, and the line number. A fingerprint that moved when a row moved
 *   would be defeated by the one thing it exists to catch: the same statement downloaded
 *   over a different date range, where every row is in a different place. Position is a
 *   fact about the file, not about the transaction.
 *
 *   THE RUNNING BALANCE. It is the most tempting column in the file and the most
 *   poisonous: it is a function of every earlier row, so the same transaction carries a
 *   different balance in a statement that starts a month earlier. (It is also the exact
 *   shape CONVENTIONS §1.3 refuses to store.)
 *
 *   THE FILE NAME AND THE IMPORT BATCH. Including either would make a fingerprint unique
 *   per import, which is the same as having none.
 *
 *   A PER-STATEMENT SERIAL NUMBER — "Sl No", "Txn #", "1, 2, 3...". These restart at one
 *   in every download, so they identify a POSITION in a file, not a transaction. The
 *   bank REFERENCE is included precisely because it does not restart.
 *
 *   THE BANK ACCOUNT. This is a constraint on the caller, not an oversight: two accounts
 *   at the same bank can genuinely have the same amount, day and narration, and their
 *   rows fingerprint identically. A caller MUST scope its lookup to one account — which
 *   it is doing anyway, since it is importing one statement into one account.
 *
 * AND THE LIMIT THAT HAS TO BE SAID OUT LOUD: TWO IDENTICAL TRANSACTIONS ARE NOT A
 * DUPLICATE. Two five-hundred-rupee ATM withdrawals on the same day, with the same
 * narration and no reference, are two real transactions with one fingerprint. So a
 * caller must compare COUNTS, not presence: "this file has two rows with fingerprint X
 * and the ledger has one, so import one". `groupByFingerprint` returns the positions
 * rather than a set for exactly that reason.
 *
 * VERSIONED IN THE OUTPUT. The digest is prefixed `csv1:`. If the recipe above ever
 * changes, the prefix changes with it, and a stored fingerprint says which recipe made
 * it instead of silently failing to match every row of an older import.
 */

import { createHash } from 'node:crypto'

import { parseDate, type DateString } from '@main/domain/time'
import { parseMoney, toMoneyString, type DecimalString } from '@main/domain/money'

import { foldText } from './text'

/** The recipe version. Changing what is hashed means changing this. */
export const FINGERPRINT_VERSION = 'csv1'

export interface RowFingerprintInput {
  /** 'YYYY-MM-DD'. The caller picks which date column and must keep picking the same one. */
  readonly date: DateString
  /** An exact decimal string. Canonicalised to 2dp here, so the caller need not. */
  readonly amount: DecimalString
  /** The description, as written. Folded here. */
  readonly narration: string
  /** A cheque number, UTR or RRN. Absent and blank are the same thing. */
  readonly reference?: string | undefined
}

/**
 * A stable fingerprint for one row's content.
 *
 * Pure: same input, same output, on any machine, in any zone, at any time.
 *
 * @throws TimeError when the date is not a real 'YYYY-MM-DD' date.
 * @throws MoneyError when the amount is not exact decimal text at money scale.
 */
export function rowFingerprint(input: RowFingerprintInput): string {
  /* Validated rather than trusted. A fingerprint over a malformed date is a fingerprint
   * that will not match the same row parsed properly next time, and nothing downstream
   * would ever notice — it would just look like a row it had not seen. */
  parseDate(input.date, 'fingerprint date')
  const amount = toMoneyString(parseMoney(input.amount, 'fingerprint amount'))

  const parts = [
    FINGERPRINT_VERSION,
    input.date,
    amount,
    foldText(input.narration).toLowerCase(),
    foldText(input.reference ?? '').toLowerCase(),
  ]

  /*
   * Length-prefixed, not delimiter-joined. Any separator character can also appear
   * inside a narration — including the control characters that look safe — and then two
   * different rows can produce one payload: a narration ending in the separator followed
   * by an empty reference is the same string as a narration with the reference glued on.
   * Writing each part's length in front makes the encoding injective with no assumption
   * about what the parts contain.
   */
  const payload = parts.map((part) => `${String(part.length)}:${part}`).join('')
  return `${FINGERPRINT_VERSION}:${createHash('sha256').update(payload, 'utf8').digest('hex')}`
}

/**
 * Group rows by fingerprint, keeping the POSITION of each.
 *
 * Positions rather than a count, so a caller can act on the second occurrence
 * specifically — see the note about two identical transactions in the module header.
 * Insertion order is preserved, and so is the order of the positions within a group.
 */
export function groupByFingerprint<T>(
  rows: readonly T[],
  fingerprintOf: (row: T, index: number) => RowFingerprintInput,
): Map<string, number[]> {
  const groups = new Map<string, number[]>()
  for (const [index, row] of rows.entries()) {
    const key = rowFingerprint(fingerprintOf(row, index))
    const positions = groups.get(key)
    if (positions === undefined) {
      groups.set(key, [index])
    } else {
      positions.push(index)
    }
  }
  return groups
}

/**
 * The positions of rows that repeat WITHIN one file, keyed by fingerprint.
 *
 * Only groups of two or more. A file that repeats a row is not necessarily wrong — see
 * the header — but it is worth showing the user before the import runs, because it is
 * also what a statement downloaded twice into one file looks like.
 */
export function repeatedRows<T>(
  rows: readonly T[],
  fingerprintOf: (row: T, index: number) => RowFingerprintInput,
): Map<string, number[]> {
  const repeats = new Map<string, number[]>()
  for (const [key, positions] of groupByFingerprint(rows, fingerprintOf)) {
    if (positions.length > 1) {
      repeats.set(key, positions)
    }
  }
  return repeats
}
