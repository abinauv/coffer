/*
 * The golden fixtures, run end to end: text -> table -> mapped records -> fingerprints.
 *
 * These are the only tests in the folder that assert the whole pipeline at once. The
 * per-module tests beside them can each pass while the joins between them are wrong —
 * a header the parser produced with a byte order mark still on it matches nothing, and
 * every unit test of `findColumn` still passes.
 */

import { describe, expect, it } from 'vitest'

import { surveyDateFormats, type DateFormat } from './dates'
import { groupByFingerprint, repeatedRows, rowFingerprint } from './fingerprint'
import { mapCsvRows, type ColumnMap } from './mapping'
import { readCsvTable } from './table'

import fixture from './__fixtures__/statements.json'

interface StatementFixture {
  why: string
  csv: string
  dateFormat?: string
  expected: {
    line?: number
    rowNumber?: number
    date?: string
    narration?: string
    reference?: string | null
    amount?: string
    side?: string
  }[]
  expectedIssues?: {
    code: string
    severity: string
    line?: number
    rowNumber?: number
    columnNumber?: number
  }[]
}

const golden = fixture as unknown as {
  why: string
  statements: Record<string, StatementFixture>
}

const statement = (name: string): StatementFixture => {
  const found = golden.statements[name]
  if (found === undefined) {
    throw new Error(`No fixture called ${name}`)
  }
  return found
}

describe('hdfcLike — separate withdrawal and deposit columns, CRLF, Indian grouping', () => {
  const fix = statement('hdfcLike')
  const map: ColumnMap = {
    date: {
      kind: 'date',
      columns: ['Date'],
      required: true,
      format: (fix.dateFormat ?? 'DD/MM/YYYY') as DateFormat,
    },
    narration: { kind: 'text', columns: ['Narration'], required: true },
    reference: { kind: 'text', columns: ['Chq./Ref.No.'], required: false },
    movement: {
      kind: 'debit-credit',
      debitColumns: ['Withdrawal Amt.'],
      creditColumns: ['Deposit Amt.'],
      required: true,
      sign: 'credit-positive',
    },
  }
  const table = readCsvTable(fix.csv)
  const result = mapCsvRows(table, map, { reportUnmappedColumns: false })

  it('reads the file with no errors', () => {
    expect(result.errorCount).toBe(0)
    expect(result.records).toHaveLength(fix.expected.length)
  })

  it('produces the rows, in file order, with the signs the columns imply', () => {
    expect(
      result.records.map((record) => ({
        line: record.line,
        rowNumber: record.rowNumber,
        date: record.values.date,
        narration: record.values.narration,
        reference: record.values.reference,
        amount: (record.values.movement as { amount: string }).amount,
        side: (record.values.movement as { side: string }).side,
      })),
    ).toEqual(fix.expected)
  })

  it('is NOT in date order in the file, so the assertion above is about order', () => {
    const dates = result.records.map((record) => record.values.date as string)
    expect(dates).not.toEqual([...dates].sort())
  })

  it('reads the file as unambiguously DD/MM, because one row is dated the 13th', () => {
    const column = table.rows.map((row) => row.fields[0] ?? '')
    const survey = surveyDateFormats(column)
    expect(survey.verdict).toBe('unambiguous')
    expect(survey.consistent).toEqual(['DD/MM/YYYY'])
  })
})

describe('nasty — a BOM, quoted newlines, doubled quotes, grouping and a bracketed negative', () => {
  const fix = statement('nasty')
  const map: ColumnMap = {
    date: { kind: 'date', columns: ['Txn Date'], required: true, format: 'DD/MM/YYYY' },
    narration: { kind: 'text', columns: ['Narration'], required: true },
    reference: { kind: 'text', columns: ['Ref No'], required: false },
    amount: { kind: 'decimal', columns: ['Amount (INR)'], required: true },
  }
  const table = readCsvTable(fix.csv)
  const result = mapCsvRows(table, map)

  it('sees the byte order mark and strips it from the first heading', () => {
    expect(table.hadByteOrderMark).toBe(true)
    expect(table.header[0]?.key).toBe('txn date')
  })

  it('matches every heading despite the stray spaces and the shouting', () => {
    expect(result.resolution.ok).toBe(true)
    expect(result.errorCount).toBe(0)
  })

  it('produces the rows, keeping the newlines and the quotes inside the narration', () => {
    expect(
      result.records.map((record) => ({
        line: record.line,
        rowNumber: record.rowNumber,
        date: record.values.date,
        narration: record.values.narration,
        reference: record.values.reference ?? null,
        amount: record.values.amount,
      })),
    ).toEqual(fix.expected)
  })

  it('counts the LINE of the second row past the three-line address, not the record', () => {
    /* Line 5, not line 3. This is the join the unit tests cannot see: a row number that
     * ignored the wrapped field would send the user to the wrong line of their file. */
    expect(result.records[1]?.line).toBe(5)
    expect(result.records[1]?.rowNumber).toBe(2)
  })
})

describe('ragged — five different faults in one file', () => {
  const fix = statement('ragged')
  const map: ColumnMap = {
    date: { kind: 'date', columns: ['Date'], required: true, format: 'DD/MM/YYYY' },
    narration: { kind: 'text', columns: ['Description'], required: true },
    amount: { kind: 'decimal', columns: ['Amount'], required: true },
  }
  const result = mapCsvRows(readCsvTable(fix.csv), map)

  it('still produces the rows that were fine', () => {
    expect(
      result.records.map((record) => ({
        line: record.line,
        rowNumber: record.rowNumber,
        date: record.values.date,
        narration: record.values.narration,
        amount: record.values.amount,
      })),
    ).toEqual(fix.expected)
  })

  it('lists every fault once, in order, with where to find it', () => {
    expect(
      result.issues.map((issue) => ({
        code: issue.code,
        severity: issue.severity,
        ...(issue.line === undefined ? {} : { line: issue.line }),
        ...(issue.rowNumber === undefined ? {} : { rowNumber: issue.rowNumber }),
        ...(issue.columnNumber === undefined ? {} : { columnNumber: issue.columnNumber }),
      })),
    ).toEqual(fix.expectedIssues)
  })

  it('counts errors and warnings separately', () => {
    expect(result.errorCount).toBe(4)
    expect(result.warningCount).toBe(1)
    expect(result.issuesTruncated).toBe(false)
  })
})

describe('ambiguousDates — the file the survey must refuse to resolve', () => {
  const fix = statement('ambiguousDates')
  const table = readCsvTable(fix.csv)
  const survey = surveyDateFormats(table.rows.map((row) => row.fields[0] ?? ''))

  it('reports both readings and picks neither', () => {
    expect(survey.verdict).toBe('ambiguous')
    expect(survey.consistent).toEqual(['DD/MM/YYYY', 'MM/DD/YYYY'])
  })

  it('says the two readings DISAGREE, so the caller has to ask', () => {
    expect(survey.agreeOnEveryValue).toBe(false)
  })

  it('and the two readings really do give different months', () => {
    for (const format of ['DD/MM/YYYY', 'MM/DD/YYYY'] as const) {
      const map: ColumnMap = {
        date: { kind: 'date', columns: ['Date'], required: true, format },
      }
      const dates = mapCsvRows(table, map, { reportUnmappedColumns: false }).records.map(
        (record) => record.values.date,
      )
      expect(dates).toEqual(
        format === 'DD/MM/YYYY' ? ['2028-04-05', '2028-07-06'] : ['2028-05-04', '2028-06-07'],
      )
    }
  })
})

describe('europeanAmounts — a comma used as the decimal point', () => {
  const fix = statement('europeanAmounts')
  const map: ColumnMap = {
    date: { kind: 'date', columns: ['Date'], required: true, format: 'DD/MM/YYYY' },
    amount: { kind: 'decimal', columns: ['Amount'], required: true },
  }
  const result = mapCsvRows(readCsvTable(fix.csv), map)

  it('refuses the row by name rather than reading it a thousand times too large', () => {
    expect(result.records).toEqual([])
    expect(result.issues[0]?.code).toBe('INVALID_AMOUNT')
    expect(result.issues[0]?.message).toMatch(/comma as the decimal point/)
  })
})

describe('headerOnly and empty', () => {
  const map: ColumnMap = {
    date: { kind: 'date', columns: ['Date'], required: true, format: 'DD/MM/YYYY' },
    narration: { kind: 'text', columns: ['Narration'], required: true },
    amount: { kind: 'decimal', columns: ['Amount'], required: true },
  }

  it('reads a statement with no transactions as no records and no complaints', () => {
    const result = mapCsvRows(readCsvTable(statement('headerOnly').csv), map)
    expect(result.records).toEqual([])
    expect(result.issues).toEqual([])
  })

  it('reads a zero-byte file as missing columns, without throwing', () => {
    const result = mapCsvRows(readCsvTable(statement('empty').csv), map)
    expect(result.records).toEqual([])
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'MISSING_COLUMN',
      'MISSING_COLUMN',
      'MISSING_COLUMN',
    ])
  })
})

describe('re-importing a statement', () => {
  const fix = statement('hdfcLike')
  const map: ColumnMap = {
    date: { kind: 'date', columns: ['Date'], required: true, format: 'DD/MM/YYYY' },
    narration: { kind: 'text', columns: ['Narration'], required: true },
    reference: { kind: 'text', columns: ['Chq./Ref.No.'], required: false },
    movement: {
      kind: 'debit-credit',
      debitColumns: ['Withdrawal Amt.'],
      creditColumns: ['Deposit Amt.'],
      required: true,
      sign: 'credit-positive',
    },
  }
  const fingerprints = (csv: string): string[] =>
    mapCsvRows(readCsvTable(csv), map, { reportUnmappedColumns: false }).records.map((record) =>
      rowFingerprint({
        date: record.values.date as string,
        amount: (record.values.movement as { amount: string }).amount,
        narration: record.values.narration as string,
        reference: record.values.reference as string | undefined,
      }),
    )

  it('gives the same row the same fingerprint on the second import', () => {
    expect(fingerprints(fix.csv)).toEqual(fingerprints(fix.csv))
  })

  it('gives the same row the same fingerprint after the file was re-saved with LF endings', () => {
    /* A user who opened the statement in another tool and saved it again. Same rows. */
    const asLf = fix.csv.replace(/\r\n/g, '\n')
    expect(asLf).not.toBe(fix.csv)
    expect(fingerprints(asLf)).toEqual(fingerprints(fix.csv))
  })

  it('gives every row of a clean statement a DIFFERENT fingerprint', () => {
    const grouped = groupByFingerprint(fingerprints(fix.csv), (value) => ({
      date: '2027-11-04',
      amount: '0.00',
      narration: value,
    }))
    expect(grouped.size).toBe(fix.expected.length)
  })

  it('spots the same statement pasted into itself', () => {
    const doubled = `${fix.csv}${fix.csv.split('\r\n').slice(1).join('\r\n')}`
    const all = fingerprints(doubled)
    expect(all).toHaveLength(fix.expected.length * 2)
    const repeats = repeatedRows(all, (value) => ({
      date: '2027-11-04',
      amount: '0.00',
      narration: value,
    }))
    expect(repeats.size).toBe(fix.expected.length)
    expect([...repeats.values()].every((positions) => positions.length === 2)).toBe(true)
  })
})
