import { describe, expect, it } from 'vitest'

import { CsvError } from './errors'
import { parseCsv } from './parse'

const fieldsOf = (text: string): readonly (readonly string[])[] =>
  parseCsv(text).records.map((record) => record.fields)

describe('parseCsv — quoting', () => {
  it('keeps a delimiter that is inside quotes', () => {
    expect(fieldsOf('a,"b,c",d')).toEqual([['a', 'b,c', 'd']])
  })

  it('reads a doubled quote as one literal quote', () => {
    expect(fieldsOf('a,"say ""hello""",b')).toEqual([['a', 'say "hello"', 'b']])
  })

  it('reads a field that is nothing but a doubled quote', () => {
    expect(fieldsOf('"""",x')).toEqual([['"', 'x']])
  })

  it('keeps a NEWLINE that is inside quotes, which is the case naive splitters lose', () => {
    const grid = parseCsv('a,"line one\nline two",b\nc,d,e')
    expect(grid.records.map((record) => record.fields)).toEqual([
      ['a', 'line one\nline two', 'b'],
      ['c', 'd', 'e'],
    ])
    /* The second record starts on line 3, not line 2: the quoted field consumed a line
     * break. A report that counted records instead of lines would send the user to the
     * middle of the address. */
    expect(grid.records.map((record) => record.line)).toEqual([1, 3])
  })

  it('normalises CRLF and a lone CR inside quotes to LF, so a re-export is the same text', () => {
    /* Transport, not content — the same argument as the `""` decision. Without this the
     * duplicate fingerprint reports every row of a Windows re-download as new. */
    expect(fieldsOf('"a\r\nb"')).toEqual([['a\nb']])
    expect(fieldsOf('"a\rb"')).toEqual([['a\nb']])
    expect(fieldsOf('"a\nb"')).toEqual([['a\nb']])
  })

  it('treats a bare quote inside an UNQUOTED field as ordinary data', () => {
    const grid = parseCsv('5" pipe,2')
    expect(grid.records[0]?.fields).toEqual(['5" pipe', '2'])
    expect(grid.problems).toEqual([])
  })

  it('reports text after a CLOSING quote, once per field, and keeps the text', () => {
    const grid = parseCsv('"a"bcd,e')
    expect(grid.records[0]?.fields).toEqual(['abcd', 'e'])
    expect(grid.problems).toHaveLength(1)
    expect(grid.problems[0]?.code).toBe('TEXT_AFTER_CLOSING_QUOTE')
    expect(grid.problems[0]?.columnNumber).toBe(1)
  })

  it('reports an unterminated quote and says how much it swallowed', () => {
    const grid = parseCsv('h1,h2\na,"b\nc,d\ne,f')
    /* One row, not three: the quote ate the rest of the file. Silently, without this
     * report, the user sees an import that found one transaction in a file of three. */
    expect(grid.records).toHaveLength(2)
    expect(grid.records[1]?.fields).toEqual(['a', 'b\nc,d\ne,f'])
    expect(grid.problems[0]?.code).toBe('UNTERMINATED_QUOTE')
    expect(grid.problems[0]?.line).toBe(2)
    expect(grid.problems[0]?.columnNumber).toBe(2)
  })
})

describe('parseCsv — the `""` decision', () => {
  /*
   * DECIDED: a quoted empty field is an EMPTY STRING and is indistinguishable from a bare
   * empty one. Quoting is transport, not meaning — see the header of parse.ts. These two
   * assertions are the decision; if either changes, the decision changed.
   */
  it('reads `""` and an empty field as the same empty string', () => {
    expect(fieldsOf('a,"",b')).toEqual([['a', '', 'b']])
    expect(fieldsOf('a,,b')).toEqual([['a', '', 'b']])
    expect(fieldsOf('a,"",b')).toEqual(fieldsOf('a,,b'))
  })

  it('keeps a trailing empty field rather than dropping it', () => {
    expect(fieldsOf('a,b,')).toEqual([['a', 'b', '']])
    expect(fieldsOf(',')).toEqual([['', '']])
  })
})

describe('parseCsv — line endings', () => {
  const rows = [
    ['Date', 'Amount'],
    ['04/11/2027', '100.00'],
  ]

  it('reads LF, CRLF and lone CR to the same records', () => {
    expect(fieldsOf('Date,Amount\n04/11/2027,100.00')).toEqual(rows)
    expect(fieldsOf('Date,Amount\r\n04/11/2027,100.00')).toEqual(rows)
    expect(fieldsOf('Date,Amount\r04/11/2027,100.00')).toEqual(rows)
  })

  it('reads a file with a trailing newline and one without to the same records', () => {
    expect(fieldsOf('Date,Amount\n04/11/2027,100.00\n')).toEqual(rows)
    expect(fieldsOf('Date,Amount\r\n04/11/2027,100.00\r\n')).toEqual(rows)
    expect(fieldsOf('Date,Amount\n04/11/2027,100.00')).toEqual(rows)
  })

  it('keeps a blank line as a record of one empty field, faithfully', () => {
    /* The grid is faithful; skipping blank lines is table.ts's decision, not the
     * parser's. Two trailing newlines therefore differ from one. */
    expect(fieldsOf('a,b\n\n')).toEqual([['a', 'b'], ['']])
    expect(fieldsOf('\n')).toEqual([['']])
  })

  it('counts lines across a CRLF pair as one line, not two', () => {
    const grid = parseCsv('a\r\nb\r\nc')
    expect(grid.records.map((record) => record.line)).toEqual([1, 2, 3])
  })
})

describe('parseCsv — the byte order mark', () => {
  it('strips a leading BOM and says it was there', () => {
    const grid = parseCsv('﻿Date,Amount\n04/11/2027,100.00')
    expect(grid.hadByteOrderMark).toBe(true)
    expect(grid.records[0]?.fields).toEqual(['Date', 'Amount'])
  })

  it('corrupts only the FIRST heading when it is not stripped, which is why it is stripped', () => {
    /* The observation the whole guard exists for: the second column is untouched, so the
     * file reads as a mapping bug in column one and nothing else. */
    const raw = '﻿Date,Amount'
    expect(raw.split(',')[0]).not.toBe('Date')
    expect(raw.split(',')[1]).toBe('Amount')
    expect(parseCsv(raw).records[0]?.fields).toEqual(['Date', 'Amount'])
  })

  it('leaves a U+FEFF that is not at position zero alone', () => {
    const grid = parseCsv('Date,Am﻿ount')
    expect(grid.hadByteOrderMark).toBe(false)
    expect(grid.records[0]?.fields[1]).toBe('Am﻿ount')
  })
})

describe('parseCsv — degenerate files', () => {
  it('reads an empty file as no records at all', () => {
    const grid = parseCsv('')
    expect(grid.records).toEqual([])
    expect(grid.problems).toEqual([])
    expect(grid.hadByteOrderMark).toBe(false)
  })

  it('reads a file that is only a BOM as no records', () => {
    const grid = parseCsv('﻿')
    expect(grid.records).toEqual([])
    expect(grid.hadByteOrderMark).toBe(true)
  })

  it('reads a header-only file as one record', () => {
    expect(fieldsOf('Date,Narration,Amount\n')).toEqual([['Date', 'Narration', 'Amount']])
  })

  it('reads a file that is one very long line', () => {
    const long = `Date,Narration\n04/11/2027,${'x'.repeat(120_000)}`
    const grid = parseCsv(long)
    expect(grid.records).toHaveLength(2)
    expect(grid.records[1]?.fields[1]).toHaveLength(120_000)
  })

  it('keeps ragged records at their real length and pads nothing', () => {
    expect(fieldsOf('a,b,c\nd,e\nf,g,h,i')).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e'],
      ['f', 'g', 'h', 'i'],
    ])
  })
})

describe('parseCsv — options', () => {
  it('reads a semicolon or a tab as the delimiter when told to', () => {
    expect(parseCsv('a;b;c', { delimiter: ';' }).records[0]?.fields).toEqual(['a', 'b', 'c'])
    expect(parseCsv('a\tb', { delimiter: '\t' }).records[0]?.fields).toEqual(['a', 'b'])
    /* And does NOT split on a semicolon by default — the condition each option alone
     * excludes. */
    expect(parseCsv('a;b;c').records[0]?.fields).toEqual(['a;b;c'])
  })

  it('takes a different quote character', () => {
    expect(parseCsv("a,'b,c'", { quote: "'" }).records[0]?.fields).toEqual(['a', 'b,c'])
  })

  it('refuses a delimiter that cannot work', () => {
    /* An empty delimiter matches nothing and would spin the scanner; a two-character one
     * would half-match; a newline would end the record it was meant to split. */
    for (const delimiter of ['', ',,', '\n', '\r', '\u{1F600}']) {
      expect(() => parseCsv('a,b', { delimiter })).toThrow(CsvError)
    }
    expect(() => parseCsv('a,b', { delimiter: '"' })).toThrowError(/cannot be the same/)
  })
})

describe('parseCsv — the caps on untrusted input', () => {
  it('refuses more rows than the limit, and names the limit', () => {
    expect(() => parseCsv('a\nb\nc', { maxRows: 2 })).toThrowError(/more than 2 rows/)
    expect(parseCsv('a\nb', { maxRows: 2 }).records).toHaveLength(2)
  })

  it('refuses more columns on one line than the limit', () => {
    expect(() => parseCsv('a,b,c,d', { maxFieldsPerRow: 3 })).toThrow(CsvError)
    expect(parseCsv('a,b,c', { maxFieldsPerRow: 3 }).records[0]?.fields).toHaveLength(3)
  })

  it('refuses a single field longer than the limit, and blames the quote', () => {
    expect(() => parseCsv(`a,${'x'.repeat(50)}`, { maxFieldCharacters: 10 })).toThrowError(
      /never closed/,
    )
    expect(parseCsv('a,xxxxx', { maxFieldCharacters: 10 }).records).toHaveLength(1)
  })

  it('refuses a limit of zero rather than reading it as "no limit"', () => {
    /* PROBED, not reasoned: the guess about which malformed input is dangerous has been
     * exactly backwards in this codebase before. Zero, a negative, and a fraction are all
     * refused, and each throws with the same code so a caller can act on it. */
    for (const bad of [0, -1, -0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseCsv('a,b', { maxRows: bad }), `maxRows ${String(bad)}`).toThrow(CsvError)
      expect(() => parseCsv('a,b', { maxFieldsPerRow: bad })).toThrow(CsvError)
      expect(() => parseCsv('a,b', { maxFieldCharacters: bad })).toThrow(CsvError)
    }
    let code = ''
    try {
      parseCsv('a,b', { maxRows: 0 })
    } catch (error) {
      code = error instanceof CsvError ? error.code : 'not a CsvError'
    }
    expect(code).toBe('CSV_LIMIT_INVALID')
  })

  it('accepts a limit of exactly one', () => {
    expect(
      parseCsv('a', { maxRows: 1, maxFieldsPerRow: 1, maxFieldCharacters: 1 }).records,
    ).toEqual([{ line: 1, fields: ['a'] }])
  })
})
