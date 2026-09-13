/*
 * The scalars a Tally export writes, and the one convention that decides every sign in it.
 *
 * ---------------------------------------------------------------------------
 * DATES ARE `YYYYMMDD`, AND THAT IS VALIDATED RATHER THAN ASSUMED.
 *
 * Eight digits with no separators is the one date format that carries no ambiguity: there
 * is no reading of `20270719` that is not 19 July 2027, so this importer does not survey
 * the file's date columns the way the Zoho one has to. What it does instead is CHECK the
 * shape, because "unambiguous" is a property of the format and not of the file — a report
 * export writes `1-Apr-2027`, and a reader that assumed eight digits would take the first
 * eight characters of it and produce a date in the year 1 with nothing to say so.
 *
 * The calendar check itself is the CSV module's, reached by putting the separators back
 * in: `parseImportDate('2027-07-19', 'YYYY-MM-DD')`. Not re-implemented, because "is 31
 * February a date" is exactly the kind of rule that ends up written twice and agreeing
 * only for the inputs somebody thought of, and the CSV module already has it under test.
 *
 * ---------------------------------------------------------------------------
 * AMOUNTS GO THROUGH `csv/amounts.ts`, UNCHANGED AND UNWRAPPED.
 *
 * Tally usually writes a bare `-11800.00`, and usually is not always: an export that has
 * been through a report template carries `₹ 1,18,000.00`, and one that has been through a
 * spreadsheet carries `(11,800.00)`. Indian grouping, parentheses, leading and trailing
 * minus and currency tokens are all already parsed there, against tests, so this file adds
 * nothing to it and only names the scale.
 *
 * ---------------------------------------------------------------------------
 * THE SIGN IS THE FACT. `ISDEEMEDPOSITIVE` IS A SECOND OPINION ABOUT IT.
 *
 * A Tally ledger entry states its side twice: the AMOUNT carries a sign, and
 * `ISDEEMEDPOSITIVE` says `Yes` for the side Tally treats as positive. In Tally's own
 * convention a debit is written NEGATIVE and is `ISDEEMEDPOSITIVE=Yes`; a credit is
 * written positive and is `No`. The two are meant to agree and sometimes do not — a file
 * that has been through a connector, a template, or somebody's script.
 *
 * WHEN THEY DISAGREE, THE SIGN WINS, and the reasons are in order of how much they matter:
 *
 *   1. THE SIGN IS WHAT IS POSTED. The amount goes into the books; the flag does not.
 *      Filing an entry on the side the flag names while posting the figure the sign
 *      carries produces a voucher whose two sides no longer add up, and it produces it
 *      QUIETLY, because both halves came out of the same file.
 *   2. THE SIGN IS ALWAYS THERE. `ISDEEMEDPOSITIVE` is absent from plenty of exports —
 *      older releases, some collection paths, most hand-written import files. A rule that
 *      reads the flag needs a fallback to the sign anyway, and a rule with a fallback has
 *      two answers and no way to say which one it used.
 *   3. THE SIGNS OF A VOUCHER CHECK EACH OTHER. Every entry's sign is tested by the
 *      requirement that the voucher sums to zero (see `vouchers.ts`). Nothing tests the
 *      flags against anything.
 *
 * AND THE ONE PLACE THE FLAG IS AUTHORITATIVE: a ZERO amount. Zero is neither negative nor
 * positive, so the sign genuinely says nothing, and there the flag is the only signal
 * there is. A zero entry with no flag has no side at all — which is representable
 * (`'nil'`) rather than guessed, because a third state is honest and picking `credit` for
 * it would be a coin toss written into a ledger.
 *
 * A contradiction is REPORTED whichever way it is resolved. The point of choosing the sign
 * is not that the flag is worthless; it is that the choice has to be made once, in the
 * open, rather than differently in each function that meets one.
 */

import type { Decimal, DecimalString } from '@main/domain/money'

import { parseImportDate, parseImportDecimal, type FieldParse } from '../csv'

import type { DateString } from '@shared/scalars'

/** Exactly eight digits: `YYYYMMDD`, the only shape a Tally date is written in. */
const TALLY_DATE = /^(\d{4})(\d{2})(\d{2})$/

/**
 * Read one `YYYYMMDD` date.
 *
 * Failure carries a reason, the same contract `parseImportDate` keeps: "is not eight
 * digits" and "31 February is not a real date" send the user to different fixes, and a
 * `null` says neither.
 */
export function parseTallyDate(text: string): FieldParse<DateString> {
  const value = text.trim()
  if (value === '') {
    return { ok: false, message: 'is empty' }
  }
  const match = TALLY_DATE.exec(value)
  if (match === null) {
    return {
      ok: false,
      message:
        `is ${JSON.stringify(value)}, and Tally writes a date as eight digits with no ` +
        'separators, like 20270719 for 19 July 2027',
    }
  }
  const read = parseImportDate(
    `${match[1] ?? ''}-${match[2] ?? ''}-${match[3] ?? ''}`,
    'YYYY-MM-DD',
  )
  if (read.ok) {
    return read
  }
  /* The shape is already known to be eight digits, so the only way the CSV parser can
   * refuse it is the calendar — 31 February, 30 February in a leap year, month 13. Its own
   * message names `YYYY-MM-DD`, which is the format this function put the separators into
   * and NOT the format the user's file is in; repeating it would send somebody looking for
   * a date shaped like that in a file that has none. */
  return { ok: false, message: `is ${JSON.stringify(value)}, which is not a real date` }
}

/** Read one amount as an exact `Decimal`, sign included. Tally's own sign, untouched. */
export function parseTallyAmount(text: string): FieldParse<DecimalString> {
  return parseImportDecimal(text, 'money')
}

/**
 * Tally's booleans, written out.
 *
 * A closed table rather than a truthiness test. `ISDEEMEDPOSITIVE` reaching this function
 * as `Maybe` has to be reported, not read as false — a flag whose unknown values all mean
 * "no" is a flag that silently stops being read the day a release spells `Yes` differently.
 */
const TALLY_FLAGS: Readonly<Record<string, boolean>> = {
  yes: true,
  y: true,
  true: true,
  '1': true,
  no: false,
  n: false,
  false: false,
  '0': false,
}

/** Read one `Yes`/`No` flag. An unrecognised word is a failure, never a false. */
export function parseTallyFlag(text: string): FieldParse<boolean> {
  const value = text.trim().toLowerCase()
  if (value === '') {
    return { ok: false, message: 'is empty' }
  }
  const flag = TALLY_FLAGS[value]
  if (flag === undefined) {
    return { ok: false, message: `is ${JSON.stringify(text.trim())}, which is not Yes or No` }
  }
  return { ok: true, value: flag }
}

/** Digits, optionally followed by a word — `30`, `30 Days`, `45 days`. */
const TALLY_DAYS = /^(\d+)(?:\s+days?)?$/i

/**
 * Read a credit period as a whole number of days.
 *
 * Tally writes `30 Days` where the number alone would do, so the suffix is accepted and
 * anything else is refused BY NAME. `Due on Receipt` is a real value in a real export and
 * it is not a number of days; the Zoho importer reports the same value the same way, and
 * the alternative — reading it as zero — is a party whose invoices are all overdue on the
 * day they are raised.
 */
export function parseTallyDays(text: string): FieldParse<number> {
  const value = text.trim()
  if (value === '') {
    return { ok: false, message: 'is empty' }
  }
  const match = TALLY_DAYS.exec(value)
  const digits = match?.[1]
  if (digits === undefined) {
    return {
      ok: false,
      message: `is ${JSON.stringify(value)}, which is not a whole number of days`,
    }
  }
  const days = Number(digits)
  if (!Number.isSafeInteger(days)) {
    return { ok: false, message: `is ${JSON.stringify(value)}, which is too large to be days` }
  }
  return { ok: true, value: days }
}

/** Digits and nothing else. */
const TALLY_COUNT = /^\d+$/

/** Read a plain count — the decimal places of a unit. No suffix, no sign, no separators. */
export function parseTallyCount(text: string): FieldParse<number> {
  const value = text.trim()
  if (value === '') {
    return { ok: false, message: 'is empty' }
  }
  if (!TALLY_COUNT.test(value)) {
    return { ok: false, message: `is ${JSON.stringify(value)}, which is not a whole number` }
  }
  const count = Number(value)
  if (!Number.isSafeInteger(count)) {
    return { ok: false, message: `is ${JSON.stringify(value)}, which is too large` }
  }
  return { ok: true, value: count }
}

/**
 * Which side of the books an entry is on.
 *
 * `'nil'` is a real third state and not a failure: a zero-amount entry whose file says
 * nothing about its side has no side, contributes nothing to either total, and is still a
 * ledger the voucher mentions. See the module header.
 */
export type TallyEntrySide = 'debit' | 'credit' | 'nil'

export interface TallySideReading {
  readonly side: TallyEntrySide
  /** What `ISDEEMEDPOSITIVE` said, or null when the entry did not carry one. */
  readonly statedPositive: boolean | null
  /** True when the flag and the sign name different sides. The sign is still the answer. */
  readonly contradicts: boolean
  /** True when the side came from the flag because the amount was zero. */
  readonly fromFlag: boolean
}

/**
 * Read an entry's side off its amount, with `ISDEEMEDPOSITIVE` as a cross-check.
 *
 * NEGATIVE IS A DEBIT. That is Tally's convention as the file states it, and it is not
 * inferred from the voucher type: which side of a SALES voucher is negative and which
 * side of a RECEIPT voucher is negative are different answers, and an importer that
 * learned one of them would post the other backwards while every voucher still summed to
 * zero. The sign is per ENTRY and needs no knowledge of the voucher at all — CONVENTIONS
 * §1.10, a sign belongs to the thing and never to the query that fetched it.
 */
export function tallyEntrySide(amount: Decimal, statedPositive: boolean | null): TallySideReading {
  if (amount.isZero()) {
    if (statedPositive === null) {
      return { side: 'nil', statedPositive, contradicts: false, fromFlag: false }
    }
    return {
      side: statedPositive ? 'debit' : 'credit',
      statedPositive,
      contradicts: false,
      fromFlag: true,
    }
  }
  const side: TallyEntrySide = amount.isNegative() ? 'debit' : 'credit'
  return {
    side,
    statedPositive,
    contradicts: statedPositive !== null && statedPositive !== (side === 'debit'),
    fromFlag: false,
  }
}
