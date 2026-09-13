import { describe, expect, it } from 'vitest'

import { MoneyError } from '@main/domain/money'
import { TimeError } from '@main/domain/time'

import {
  FINGERPRINT_VERSION,
  groupByFingerprint,
  repeatedRows,
  rowFingerprint,
  type RowFingerprintInput,
} from './fingerprint'

/* 2027, so no value here can be one the real clock produced. */
const ROW: RowFingerprintInput = {
  date: '2027-11-04',
  amount: '1234.50',
  narration: 'UPI-RAVI KUMAR-9876543210',
  reference: 'UPI/331500123456',
}

describe('rowFingerprint — shape', () => {
  it('is the version, a colon and a sha256 in hex', () => {
    const fingerprint = rowFingerprint(ROW)
    expect(fingerprint.startsWith(`${FINGERPRINT_VERSION}:`)).toBe(true)
    expect(fingerprint.slice(FINGERPRINT_VERSION.length + 1)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is the same on every call', () => {
    expect(rowFingerprint(ROW)).toBe(rowFingerprint(ROW))
  })
})

describe('rowFingerprint — what it looks through', () => {
  it('ignores how the amount was written', () => {
    /* A re-export with different number formatting is the same transaction. */
    expect(rowFingerprint({ ...ROW, amount: '1234.5' })).toBe(rowFingerprint(ROW))
  })

  it('ignores case and runs of whitespace in the narration', () => {
    expect(rowFingerprint({ ...ROW, narration: '  upi-ravi   kumar-9876543210 ' })).toBe(
      rowFingerprint(ROW),
    )
  })

  it('ignores the line endings inside a multi-line narration', () => {
    const windows = { ...ROW, narration: 'ACME SUPPLIES\r\nUNIT 4' }
    const unix = { ...ROW, narration: 'ACME SUPPLIES\nUNIT 4' }
    expect(rowFingerprint(windows)).toBe(rowFingerprint(unix))
  })

  it('ignores how a combining accent was encoded', () => {
    const decomposed = { ...ROW, narration: 'Bengal\u0075\u0301ru' }
    const composed = { ...ROW, narration: 'Bengal\u00faru' }
    expect(decomposed.narration === composed.narration).toBe(false)
    expect(rowFingerprint(decomposed)).toBe(rowFingerprint(composed))
  })

  it('treats an absent reference and a blank one as the same thing', () => {
    /* A bank that writes `""` and one that omits the column describe the same row. */
    const absent: RowFingerprintInput = { date: ROW.date, amount: ROW.amount, narration: 'x' }
    expect(rowFingerprint({ ...absent, reference: '' })).toBe(rowFingerprint(absent))
    expect(rowFingerprint({ ...absent, reference: '   ' })).toBe(rowFingerprint(absent))
    expect(rowFingerprint({ ...absent, reference: undefined })).toBe(rowFingerprint(absent))
  })
})

describe('rowFingerprint — what it distinguishes', () => {
  it('changes when the date, the amount, the narration or the reference changes', () => {
    const base = rowFingerprint(ROW)
    expect(rowFingerprint({ ...ROW, date: '2027-11-05' })).not.toBe(base)
    expect(rowFingerprint({ ...ROW, amount: '1234.51' })).not.toBe(base)
    expect(rowFingerprint({ ...ROW, amount: '-1234.50' })).not.toBe(base)
    expect(rowFingerprint({ ...ROW, narration: 'UPI-RAVI KUMAR-9876543211' })).not.toBe(base)
    expect(rowFingerprint({ ...ROW, reference: 'UPI/331500123457' })).not.toBe(base)
  })

  it('cannot be fooled by moving text across the boundary between two fields', () => {
    /* This is what the length prefix in the payload buys. A plain separator would let
     * narration `ab` + reference `` and narration `a` + reference `b` collide, and the
     * second row would be silently reported as already imported. */
    const left = rowFingerprint({ date: ROW.date, amount: ROW.amount, narration: 'ab' })
    const right = rowFingerprint({
      date: ROW.date,
      amount: ROW.amount,
      narration: 'a',
      reference: 'b',
    })
    expect(left).not.toBe(right)
  })
})

describe('rowFingerprint — what it deliberately leaves out', () => {
  it('does not include where the row sits in the file', () => {
    /* The whole point: the same statement downloaded over a different date range has
     * every row in a different place, and every row must still match. */
    const rows = [{ n: 'other' }, { n: 'target' }]
    const shifted = [{ n: 'target' }, { n: 'x' }, { n: 'y' }]
    const of = (row: { n: string }): RowFingerprintInput => ({
      date: ROW.date,
      amount: ROW.amount,
      narration: row.n,
    })
    const first = [...groupByFingerprint(rows, of).keys()][1]
    const second = [...groupByFingerprint(shifted, of).keys()][0]
    expect(first).toBe(second)
  })

  it('does not include the account, so a caller MUST scope its lookup to one', () => {
    /* Asserted because it is a constraint on the caller, not an oversight. Two accounts
     * can genuinely hold the same movement on the same day. */
    const a: RowFingerprintInput = { date: ROW.date, amount: '500.00', narration: 'ATM WDL' }
    expect(rowFingerprint(a)).toBe(rowFingerprint({ ...a }))
  })

  it('gives two genuinely identical transactions ONE fingerprint, which is why counts matter', () => {
    const withdrawal: RowFingerprintInput = {
      date: '2027-11-04',
      amount: '-500.00',
      narration: 'ATM WDL SELF',
    }
    const grouped = groupByFingerprint([withdrawal, withdrawal], (row) => row)
    expect(grouped.size).toBe(1)
    expect([...grouped.values()][0]).toEqual([0, 1])
  })
})

describe('rowFingerprint — validation', () => {
  it('refuses a date that is not a real calendar date', () => {
    expect(() => rowFingerprint({ ...ROW, date: '2027-02-30' })).toThrow(TimeError)
    expect(() => rowFingerprint({ ...ROW, date: '04/11/2027' })).toThrow(TimeError)
  })

  it('refuses an amount that is not exact decimal text at money scale', () => {
    /* A fingerprint over a malformed amount would simply never match, and nothing
     * downstream could tell that from a row it had not seen before. */
    expect(() => rowFingerprint({ ...ROW, amount: '1,234.50' })).toThrow(MoneyError)
    expect(() => rowFingerprint({ ...ROW, amount: '1234.505' })).toThrow(MoneyError)
    expect(() => rowFingerprint({ ...ROW, amount: '' })).toThrow(MoneyError)
  })
})

describe('groupByFingerprint and repeatedRows', () => {
  const rows: readonly RowFingerprintInput[] = [
    { date: '2027-11-04', amount: '-500.00', narration: 'ATM WDL SELF' },
    { date: '2027-11-02', amount: '1234.50', narration: 'UPI-RAVI' },
    { date: '2027-11-04', amount: '-500.00', narration: 'atm  wdl self' },
    { date: '2027-11-13', amount: '-25.00', narration: 'CHARGES' },
  ]

  it('keeps the positions of every row in a group, in order', () => {
    const grouped = groupByFingerprint(rows, (row) => row)
    expect(grouped.size).toBe(3)
    expect([...grouped.values()]).toEqual([[0, 2], [1], [3]])
  })

  it('reports only the fingerprints that repeat', () => {
    const repeats = repeatedRows(rows, (row) => row)
    expect(repeats.size).toBe(1)
    expect([...repeats.values()][0]).toEqual([0, 2])
  })

  it('reports nothing for a file with no repeats', () => {
    expect(repeatedRows(rows.slice(1), (row) => row).size).toBe(0)
  })

  it('reports nothing for an empty file', () => {
    expect(groupByFingerprint([], (row: RowFingerprintInput) => row).size).toBe(0)
  })
})
