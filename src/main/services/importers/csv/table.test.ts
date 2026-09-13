import { describe, expect, it } from 'vitest'

import { cellAt, duplicateHeadings, findColumn, readCsvTable } from './table'

describe('readCsvTable — finding the header', () => {
  it('takes the first NON-BLANK line, and counts the blank ones it walked past', () => {
    const table = readCsvTable('\n\nDate,Amount\n04/11/2027,100.00')
    expect(table.header.map((column) => column.heading)).toEqual(['Date', 'Amount'])
    expect(table.blankLines).toEqual([1, 2])
    expect(table.rows).toHaveLength(1)
    /* And the row still knows which line of the FILE it is on, not which record. */
    expect(table.rows[0]?.line).toBe(4)
  })

  it('treats a row of nothing but commas as blank, because that is a spreadsheet empty row', () => {
    const table = readCsvTable('Date,Amount\n04/11/2027,100.00\n,,\n05/11/2027,200.00\n')
    expect(table.blankLines).toEqual([3])
    expect(table.rows.map((row) => row.number)).toEqual([1, 2])
    /* The numbering closes over the gap: row 2 is the second TRANSACTION, on line 4. */
    expect(table.rows[1]).toMatchObject({ number: 2, line: 4 })
  })

  it('reads a header-only file as a header and no rows', () => {
    const table = readCsvTable('Date,Narration,Amount\n')
    expect(table.header).toHaveLength(3)
    expect(table.rows).toEqual([])
    expect(table.ragged).toEqual([])
  })

  it('reads an empty file as no header and no rows, without throwing', () => {
    const table = readCsvTable('')
    expect(table.header).toEqual([])
    expect(table.rows).toEqual([])
  })

  it('reads a file of nothing but blank lines as no header', () => {
    const table = readCsvTable('\n\n\n')
    expect(table.header).toEqual([])
    expect(table.blankLines).toEqual([1, 2, 3])
  })
})

describe('readCsvTable — ragged rows', () => {
  const table = readCsvTable('A,B,C\n1,2,3\n4,5\n6,7,8,9\n')

  it('reports a short row and a long row with what it expected and what it found', () => {
    expect(table.ragged).toEqual([
      { line: 3, number: 2, expected: 3, found: 2 },
      { line: 4, number: 3, expected: 3, found: 4 },
    ])
  })

  it('does NOT pad the short row', () => {
    /* Padding would pick the harmless reading of a short row, and the other reading is a
     * delimiter that ate a column boundary — after which every value is one place left. */
    expect(table.rows[1]?.fields).toEqual(['4', '5'])
    expect(table.rows[2]?.fields).toEqual(['6', '7', '8', '9'])
  })

  it('keeps ragged rows in `rows` so a caller can look at them', () => {
    expect(table.rows.map((row) => row.number)).toEqual([1, 2, 3])
  })
})

describe('findColumn', () => {
  const header = readCsvTable(' VALUE DATE ,Narration,AMOUNT,amount\n').header

  it('matches regardless of case and surrounding whitespace', () => {
    for (const spelling of ['Value Date', 'value date', ' VALUE DATE ', 'value  date']) {
      const lookup = findColumn(header, spelling)
      expect(lookup.kind, spelling).toBe('found')
      expect(lookup.kind === 'found' ? lookup.column.index : -1).toBe(0)
    }
  })

  it('says `missing` for a heading the file does not have', () => {
    expect(findColumn(header, 'Cheque Number')).toEqual({ kind: 'missing' })
  })

  it('says `ambiguous` for two columns of one name, and never picks the first', () => {
    /* CONVENTIONS §9: a `.find` here would silently implement "whichever is listed
     * first", and no assertion downstream could tell. */
    const lookup = findColumn(header, 'Amount')
    expect(lookup.kind).toBe('ambiguous')
    expect(lookup.kind === 'ambiguous' ? lookup.columns.map((column) => column.index) : []).toEqual(
      [2, 3],
    )
  })

  it('reports the heading as the file spells it, for a message the user can act on', () => {
    const lookup = findColumn(header, 'value date')
    expect(lookup.kind === 'found' ? lookup.column.heading : '').toBe(' VALUE DATE ')
  })
})

describe('duplicateHeadings', () => {
  it('names a heading that appears twice', () => {
    expect(duplicateHeadings(readCsvTable('A,B,a\n').header)).toEqual(['a'])
  })

  it('does not report unnamed columns as duplicates of each other', () => {
    /* A trailing comma on both a header and a spreadsheet's own padding gives two blank
     * headings, which is not the same problem and would drown the real one. */
    expect(duplicateHeadings(readCsvTable('A,B,,\n').header)).toEqual([])
  })

  it('says nothing when every heading is distinct', () => {
    expect(duplicateHeadings(readCsvTable('A,B,C\n').header)).toEqual([])
  })
})

describe('cellAt', () => {
  it('reads a cell by position', () => {
    const row = readCsvTable('A,B\nx,y\n').rows[0]
    expect(row === undefined ? '' : cellAt(row, 1)).toBe('y')
  })

  it('returns an empty string past the end rather than undefined', () => {
    const row = readCsvTable('A,B\nx,y\n').rows[0]
    expect(row === undefined ? 'no row' : cellAt(row, 7)).toBe('')
  })
})
