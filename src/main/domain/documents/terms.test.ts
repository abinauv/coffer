/*
 * When a document falls due.
 *
 * The arithmetic is `addDays` and is tested in `domain/time`; what is tested here is the
 * two decisions this function makes on top of it — that a party with no terms is due on
 * receipt, and that terms which could produce a date before the document was raised are a
 * crash rather than a clamp.
 */

import { describe, expect, it } from 'vitest'
import { addDays } from '../time'
import { dueDateFor } from './terms'

describe('dueDateFor', () => {
  it('is the document date itself when nobody has agreed terms', () => {
    expect(dueDateFor('2026-04-15', null)).toBe('2026-04-15')
  })

  /* Zero and null are the same answer, and they arrive by different routes: null is a
   * party nobody filled in, zero is a party somebody deliberately put on due-on-receipt. */
  it('treats no terms and nought days alike', () => {
    expect(dueDateFor('2026-04-15', 0)).toBe(dueDateFor('2026-04-15', null))
  })

  it('counts calendar days, not working ones', () => {
    /* 15 April plus 30 lands on 15 May: April has 30 days, so the month changes and the
     * day of the month does not. A weekend-aware version would answer differently and
     * would be wrong — nothing in a contract for 30 days means 30 working days. */
    expect(dueDateFor('2026-04-15', 30)).toBe('2026-05-15')
  })

  it('crosses a month, a year and a leap day', () => {
    expect(dueDateFor('2026-12-20', 45)).toBe('2027-02-03')
    /* 2028 is a leap year, so 45 days from 20 January reaches 5 March rather than 6. */
    expect(dueDateFor('2028-01-20', 45)).toBe('2028-03-05')
  })

  it('is exactly addDays, for every term a business might use', () => {
    for (const days of [0, 7, 14, 15, 30, 45, 60, 90, 120, 365]) {
      expect(dueDateFor('2026-04-15', days)).toBe(addDays('2026-04-15', days))
    }
  })

  /*
   * NEGATIVE TERMS ARE A CRASH, AND THE ALTERNATIVE IS WHAT MAKES THAT WORTH A TEST.
   * `addDays` subtracts happily, so a clamp or a pass-through would produce an invoice
   * that fell due before it was raised — which issues, balances, and shows up only as one
   * invoice in a thousand sitting in the wrong ageing bucket.
   */
  it('refuses terms that would fall due before the document exists', () => {
    expect(() => dueDateFor('2026-04-15', -1)).toThrow(/never negative/)
    expect(() => dueDateFor('2026-04-15', -30)).toThrow(/-30 days/)
  })

  it('refuses a term that is not a whole number of days', () => {
    expect(() => dueDateFor('2026-04-15', 1.5)).toThrow(/whole number/)
    expect(() => dueDateFor('2026-04-15', Number.NaN)).toThrow(/whole number/)
  })
})
