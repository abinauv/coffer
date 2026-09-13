import { describe, expect, it } from 'vitest'

import { CsvError, type ImportIssue } from './errors'
import { mapCsvRows, resolveColumns, type ColumnMap } from './mapping'
import { readCsvTable } from './table'

const STATEMENT: ColumnMap = {
  date: { kind: 'date', columns: ['Value Date', 'Txn Date'], required: true, format: 'DD/MM/YYYY' },
  narration: { kind: 'text', columns: ['Narration', 'Description'], required: true },
  reference: { kind: 'text', columns: ['Ref No'], required: false },
  amount: { kind: 'decimal', columns: ['Amount'], required: true },
}

const codesOf = (issues: readonly ImportIssue[]): readonly string[] =>
  issues.map((issue) => issue.code)

describe('mapCsvRows — a file that reads cleanly', () => {
  /* The rows are in the order 9th, 2nd, 21st — deliberately NOT date order, so a mapper
   * that sorted or grouped on the way through would disagree with this list. */
  const table = readCsvTable(
    [
      ' VALUE DATE ,narration,Ref No,AMOUNT',
      '09/04/2028,Second in the file,R-9,"1,000.00"',
      '02/04/2028,First by date,R-2,(250.50)',
      '21/04/2028,Third in the file,,₹ 75.00',
      '',
    ].join('\n'),
  )
  const result = mapCsvRows(table, STATEMENT)

  it('matches headings whatever their case and spacing', () => {
    expect(result.resolution.ok).toBe(true)
    expect(result.resolution.columns.map((column) => column.field)).toEqual([
      'date',
      'narration',
      'reference',
      'amount',
    ])
  })

  it('returns the ROWS, in file order, not just a count', () => {
    expect(result.records.map((record) => record.values.date)).toEqual([
      '2028-04-09',
      '2028-04-02',
      '2028-04-21',
    ])
    expect(result.records.map((record) => record.values.amount)).toEqual([
      '1000.00',
      '-250.50',
      '75.00',
    ])
    expect(result.records.map((record) => record.values.narration)).toEqual([
      'Second in the file',
      'First by date',
      'Third in the file',
    ])
  })

  it('keeps the line and row number of each record', () => {
    expect(result.records.map((record) => [record.line, record.rowNumber])).toEqual([
      [2, 1],
      [3, 2],
      [4, 3],
    ])
  })

  it('reads a blank optional cell as undefined, and the key is still there', () => {
    const third = result.records[2]
    expect(third?.values.reference).toBeUndefined()
    expect(third === undefined ? [] : Object.keys(third.values).sort()).toEqual([
      'amount',
      'date',
      'narration',
      'reference',
    ])
  })

  it('reports nothing', () => {
    expect(result.issues).toEqual([])
    expect(result.errorCount).toBe(0)
    expect(result.warningCount).toBe(0)
  })
})

describe('mapCsvRows — a missing column', () => {
  const table = readCsvTable(
    ['Narration,Ref No,Amount', 'Row one,R-1,10.00', 'Row two,R-2,20.00'].join('\n'),
  )
  const result = mapCsvRows(table, STATEMENT)

  it('names the COLUMN, once, and does not read a single row', () => {
    /* The whole point of decision 1: two rows here, eight hundred in a real file, and
     * the user's problem is one sentence either way. */
    expect(result.records).toEqual([])
    expect(result.errorCount).toBe(1)
    expect(codesOf(result.issues)).toEqual(['MISSING_COLUMN'])
    expect(result.issues[0]?.message).toMatch(/no column for "date"/)
    expect(result.issues[0]?.message).toMatch(/"Value Date", "Txn Date"/)
    expect(result.issues[0]?.field).toBe('date')
  })

  it('says so before any row is read, from the header alone', () => {
    const resolution = resolveColumns(table.header, STATEMENT)
    expect(resolution.ok).toBe(false)
    expect(codesOf(resolution.issues)).toEqual(['MISSING_COLUMN'])
  })
})

describe('mapCsvRows — an optional column that is absent', () => {
  const table = readCsvTable(['Value Date,Narration,Amount', '09/04/2028,Row one,10.00'].join('\n'))
  const result = mapCsvRows(table, STATEMENT)

  it('warns rather than stopping, and the rows still come through', () => {
    expect(result.errorCount).toBe(0)
    expect(result.warningCount).toBe(1)
    expect(codesOf(result.issues)).toEqual(['MISSING_COLUMN'])
    expect(result.issues[0]?.severity).toBe('warning')
    expect(result.records).toHaveLength(1)
  })

  it('still gives the record the key, as undefined', () => {
    expect(result.records[0]?.values.reference).toBeUndefined()
    expect(Object.keys(result.records[0]?.values ?? {})).toContain('reference')
  })
})

describe('mapCsvRows — ambiguity', () => {
  it('refuses when two of a field’s candidate headings are both present', () => {
    /* Taking the first would make the ORDER of the spec list the rule, invisibly. */
    const table = readCsvTable('Value Date,Txn Date,Narration,Amount\n09/04/2028,09/04/2028,x,1.00')
    const result = mapCsvRows(table, STATEMENT)
    expect(result.records).toEqual([])
    expect(codesOf(result.issues)).toContain('AMBIGUOUS_COLUMN')
    expect(result.issues[0]?.message).toMatch(/"Value Date", "Txn Date"/)
  })

  it('refuses when ONE heading appears twice in the file', () => {
    const table = readCsvTable('Value Date,Narration,Amount,amount\n09/04/2028,x,1.00,2.00')
    const result = mapCsvRows(table, STATEMENT)
    expect(result.records).toEqual([])
    const ambiguous = result.issues.find((issue) => issue.code === 'AMBIGUOUS_COLUMN')
    expect(ambiguous?.message).toMatch(/columns 3 and 4/)
  })

  it('is only a warning when the ambiguous field is optional', () => {
    const table = readCsvTable('Value Date,Narration,Amount,Ref No,ref no\n09/04/2028,x,1.00,a,b')
    const result = mapCsvRows(table, STATEMENT)
    expect(result.records).toHaveLength(1)
    expect(result.errorCount).toBe(0)
    expect(codesOf(result.issues)).toContain('AMBIGUOUS_COLUMN')
  })
})

describe('mapCsvRows — collecting every row error', () => {
  const table = readCsvTable(
    [
      'Value Date,Narration,Ref No,Amount',
      '09/04/2028,Good row,R-1,10.00',
      '32/04/2028,Bad date,R-2,20.00',
      '10/04/2028,Bad amount,R-3,1.2.3',
      '11/04/2028,,R-4,40.00',
      '12/04/2028,Also good,R-5,50.00',
    ].join('\n'),
  )
  const result = mapCsvRows(table, STATEMENT)

  it('keeps the rows that read and drops only the ones that did not', () => {
    expect(result.records.map((record) => record.values.narration)).toEqual([
      'Good row',
      'Also good',
    ])
  })

  it('lists every failure with its row, line, column number and heading', () => {
    expect(
      result.issues.map((issue) => [
        issue.code,
        issue.rowNumber,
        issue.line,
        issue.columnNumber,
        issue.heading,
      ]),
    ).toEqual([
      ['INVALID_DATE', 2, 3, 1, 'Value Date'],
      ['INVALID_AMOUNT', 3, 4, 4, 'Amount'],
      ['MISSING_VALUE', 4, 5, 2, 'Narration'],
    ])
    expect(result.errorCount).toBe(3)
  })

  it('carries the offending value so the message can be read without the file', () => {
    expect(result.issues[0]?.value).toBe('32/04/2028')
    expect(result.issues[1]?.value).toBe('1.2.3')
  })

  it('contributes NO record for a row that failed, not a half-filled one', () => {
    expect(result.records).toHaveLength(2)
    expect(result.records.every((record) => record.values.amount !== undefined)).toBe(true)
  })
})

describe('mapCsvRows — ragged rows', () => {
  const table = readCsvTable(
    [
      'Value Date,Narration,Ref No,Amount',
      '09/04/2028,Good,R-1,10.00',
      '10/04/2028,Short',
      '11/04/2028,Long,R-3,30.00,extra',
    ].join('\n'),
  )
  const result = mapCsvRows(table, STATEMENT)

  it('refuses a ragged row instead of padding it and reading the wrong columns', () => {
    expect(result.records).toHaveLength(1)
    expect(codesOf(result.issues)).toEqual(['RAGGED_ROW', 'RAGGED_ROW'])
    expect(result.issues[0]?.message).toMatch(/has 2 values where the heading row has 4/)
    expect(result.issues[1]?.message).toMatch(/has 5 values where the heading row has 4/)
  })
})

describe('mapCsvRows — columns nobody claimed', () => {
  const table = readCsvTable(
    'Value Date,Narration,Ref No,Amount,Closing Balance,\n09/04/2028,x,R-1,10.00,999.00,',
  )

  it('warns about an unused column and about an unnamed one, without blocking', () => {
    const result = mapCsvRows(table, STATEMENT)
    expect(result.records).toHaveLength(1)
    expect(result.errorCount).toBe(0)
    expect([...codesOf(result.issues)].sort()).toEqual(['UNMAPPED_COLUMN', 'UNNAMED_COLUMN'])
    expect(result.issues.find((issue) => issue.code === 'UNMAPPED_COLUMN')?.heading).toBe(
      'Closing Balance',
    )
  })

  it('can be told not to report unused columns', () => {
    const result = mapCsvRows(table, STATEMENT, { reportUnmappedColumns: false })
    expect(codesOf(result.issues)).toEqual(['UNNAMED_COLUMN'])
  })

  it('warns when two fields read the same column', () => {
    const doubled: ColumnMap = {
      narration: { kind: 'text', columns: ['Narration'], required: true },
      alsoNarration: { kind: 'text', columns: ['narration'], required: true },
    }
    const result = mapCsvRows(readCsvTable('Narration\nx'), doubled)
    expect(codesOf(result.issues)).toContain('COLUMN_USED_TWICE')
    expect(result.records).toHaveLength(1)
  })
})

describe('mapCsvRows — debit and credit columns', () => {
  const map: ColumnMap = {
    date: { kind: 'date', columns: ['Date'], required: true, format: 'DD/MM/YYYY' },
    movement: {
      kind: 'debit-credit',
      debitColumns: ['Withdrawal', 'Debit'],
      creditColumns: ['Deposit', 'Credit'],
      required: true,
      sign: 'credit-positive',
    },
  }

  it('signs each row by the column it came from', () => {
    const table = readCsvTable(
      ['Date,Withdrawal,Deposit', '09/04/2028,0.00,"1,000.00"', '10/04/2028,"250.50",0.00'].join(
        '\n',
      ),
    )
    const result = mapCsvRows(table, map)
    expect(result.records.map((record) => record.values.movement)).toEqual([
      { amount: '1000.00', side: 'credit' },
      { amount: '-250.50', side: 'debit' },
    ])
  })

  it('names the missing half of the pair when only one column is present', () => {
    const table = readCsvTable('Date,Withdrawal\n09/04/2028,10.00')
    const result = mapCsvRows(table, map)
    expect(result.records).toEqual([])
    expect(result.issues[0]?.message).toMatch(/credit half of "movement"/)
  })

  it('reports a row with an amount on both sides, and keeps the rest', () => {
    const table = readCsvTable(
      ['Date,Withdrawal,Deposit', '09/04/2028,10.00,20.00', '10/04/2028,,30.00'].join('\n'),
    )
    const result = mapCsvRows(table, map)
    expect(result.records).toHaveLength(1)
    expect(result.issues[0]?.message).toMatch(/both the debit and the credit/)
  })

  it('treats both cells blank as absent for an optional pair', () => {
    const optional: ColumnMap = {
      date: { kind: 'date', columns: ['Date'], required: true, format: 'DD/MM/YYYY' },
      movement: {
        kind: 'debit-credit',
        debitColumns: ['Withdrawal'],
        creditColumns: ['Deposit'],
        required: false,
        sign: 'credit-positive',
      },
    }
    const table = readCsvTable('Date,Withdrawal,Deposit\n09/04/2028,,')
    const result = mapCsvRows(table, optional)
    expect(result.records[0]?.values.movement).toBeUndefined()
    expect(result.errorCount).toBe(0)
  })
})

describe('mapCsvRows — parser problems reach the issue list', () => {
  it('surfaces an unterminated quote as an error', () => {
    const table = readCsvTable('Value Date,Narration,Ref No,Amount\n09/04/2028,"oops,R-1,10.00')
    const result = mapCsvRows(table, STATEMENT)
    expect(codesOf(result.issues)).toContain('UNTERMINATED_QUOTE')
    expect(result.issues.find((issue) => issue.code === 'UNTERMINATED_QUOTE')?.severity).toBe(
      'error',
    )
  })

  it('surfaces text after a closing quote as a warning', () => {
    const table = readCsvTable('Value Date,Narration,Ref No,Amount\n09/04/2028,"a"b,R-1,10.00')
    const result = mapCsvRows(table, STATEMENT)
    expect(codesOf(result.issues)).toContain('TEXT_AFTER_CLOSING_QUOTE')
    expect(result.records[0]?.values.narration).toBe('ab')
  })
})

describe('mapCsvRows — the issue limit', () => {
  const lines = ['Value Date,Narration,Ref No,Amount']
  for (let row = 0; row < 20; row += 1) {
    lines.push(`32/04/2028,Row ${String(row)},R,10.00`)
  }
  const table = readCsvTable(lines.join('\n'))

  it('lists at most `maxIssues` while counting all of them', () => {
    const result = mapCsvRows(table, STATEMENT, { maxIssues: 5 })
    expect(result.errorCount).toBe(20)
    expect(result.issuesTruncated).toBe(true)
    expect(result.issues).toHaveLength(6)
    expect(result.issues[5]?.code).toBe('ISSUE_LIMIT_REACHED')
    expect(result.issues[5]?.message).toMatch(/20 errors/)
  })

  it('appends nothing when the list fitted', () => {
    const result = mapCsvRows(table, STATEMENT, { maxIssues: 100 })
    expect(result.issuesTruncated).toBe(false)
    expect(result.issues).toHaveLength(20)
  })

  it('refuses a limit of zero rather than reading it as "list nothing" or "no limit"', () => {
    expect(() => mapCsvRows(table, STATEMENT, { maxIssues: 0 })).toThrow(CsvError)
    expect(() => mapCsvRows(table, STATEMENT, { maxIssues: -1 })).toThrow(CsvError)
  })
})

describe('mapCsvRows — a malformed mapping', () => {
  it('throws rather than reporting, because it is a programmer error', () => {
    const broken: ColumnMap = { date: { kind: 'text', columns: [], required: true } }
    expect(() => mapCsvRows(readCsvTable('A\n1'), broken)).toThrowError(/names no columns/)
  })
})

describe('mapCsvRows — degenerate tables', () => {
  it('reads a header-only file as no records and no row errors', () => {
    const result = mapCsvRows(readCsvTable('Value Date,Narration,Ref No,Amount\n'), STATEMENT)
    expect(result.records).toEqual([])
    expect(result.errorCount).toBe(0)
  })

  it('reads an empty file as a missing column, not a crash', () => {
    const result = mapCsvRows(readCsvTable(''), STATEMENT)
    expect(result.records).toEqual([])
    expect(codesOf(result.issues)).toContain('MISSING_COLUMN')
  })
})
