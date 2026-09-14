import { describe, expect, it } from 'vitest'
import { todayISO } from './today'

describe('todayISO', () => {
  /*
   * A stand-in whose local and UTC getters disagree, rather than a real Date in a real
   * timezone.
   *
   * The behaviour under test is "reads the local calendar day, not the UTC one", and a
   * real `new Date(2026, 4, 1, 2, 0)` only demonstrates that where the runner sits east
   * of Greenwich. On a UTC CI runner the two are identical and the test proves nothing
   * — worse, an assertion written the obvious way (`expect(d.toISOString()).not.toBe`)
   * would fail there outright, on a machine nobody was looking at.
   */
  function crossing(): Date {
    return {
      getFullYear: () => 2027,
      getMonth: () => 0,
      getDate: () => 1,
      getUTCFullYear: () => 2026,
      getUTCMonth: () => 11,
      getUTCDate: () => 31,
      toISOString: () => '2026-12-31T20:30:00.000Z',
    } as unknown as Date
  }

  it('is the local date, not the UTC one', () => {
    /*
     * The reason this is not `toISOString().slice(0, 10)`. At 02:00 on the first of
     * January in India, UTC is still 20:30 on 31 December — so a balance sheet would
     * default not just to yesterday but to the previous year.
     */
    expect(todayISO(crossing())).toBe('2027-01-01')
    expect(crossing().toISOString().slice(0, 10)).toBe('2026-12-31')
  })

  it('reads the local date for an ordinary instant too', () => {
    expect(todayISO(new Date(2026, 4, 1, 2, 0, 0))).toBe('2026-05-01')
  })

  it('pads the month and the day', () => {
    expect(todayISO(new Date(2026, 0, 5, 12))).toBe('2026-01-05')
  })

  it('handles the last day of a year', () => {
    expect(todayISO(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31')
  })
})
