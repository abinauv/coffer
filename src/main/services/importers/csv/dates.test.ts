import { describe, expect, it } from 'vitest'

import {
  DATE_FORMATS,
  isDateFormat,
  parseImportDate,
  surveyDateFormats,
  TWO_DIGIT_YEAR_CENTURY,
  type DateFormat,
} from './dates'

const read = (text: string, format: DateFormat): string => {
  const attempt = parseImportDate(text, format)
  return attempt.ok ? attempt.value : `FAILED: ${attempt.message}`
}

describe('parseImportDate — one value per supported format', () => {
  /* Every date here is in 2027 or 2028. A fixture whose value the real clock could
   * produce tests nothing about where the value came from. */
  const cases: readonly [DateFormat, string, string][] = [
    ['YYYY-MM-DD', '2027-11-04', '2027-11-04'],
    ['YYYY/MM/DD', '2027/11/04', '2027-11-04'],
    ['DD/MM/YYYY', '04/11/2027', '2027-11-04'],
    ['MM/DD/YYYY', '11/04/2027', '2027-11-04'],
    ['DD-MM-YYYY', '04-11-2027', '2027-11-04'],
    ['MM-DD-YYYY', '11-04-2027', '2027-11-04'],
    ['DD.MM.YYYY', '04.11.2027', '2027-11-04'],
    ['MM.DD.YYYY', '11.04.2027', '2027-11-04'],
    ['DD/MM/YY', '04/11/27', '2027-11-04'],
    ['MM/DD/YY', '11/04/27', '2027-11-04'],
    ['DD-MM-YY', '04-11-27', '2027-11-04'],
    ['MM-DD-YY', '11-04-27', '2027-11-04'],
    ['DD-MMM-YYYY', '04-Nov-2027', '2027-11-04'],
    ['DD-MMM-YY', '04-Nov-27', '2027-11-04'],
    ['DD MMM YYYY', '04 Nov 2027', '2027-11-04'],
    ['MMM DD, YYYY', 'Nov 04, 2027', '2027-11-04'],
  ]

  for (const [format, text, expected] of cases) {
    it(`reads ${JSON.stringify(text)} as ${format}`, () => {
      expect(read(text, format)).toBe(expected)
    })
  }

  it('covers every format in the closed list', () => {
    /* If a format is added and no case is written, this fails by name. */
    expect(cases.map(([format]) => format).sort()).toEqual([...DATE_FORMATS].sort())
  })
})

describe('parseImportDate — the ambiguity that misdates a year of transactions', () => {
  it('reads 01/02/2027 as February in DD/MM and January in MM/DD', () => {
    /* The headline case, and the reason the format is an argument. Nothing in a file
     * says which of these two it is. */
    expect(read('01/02/2027', 'DD/MM/YYYY')).toBe('2027-02-01')
    expect(read('01/02/2027', 'MM/DD/YYYY')).toBe('2027-01-02')
  })

  it('refuses a value that cannot be the format asked for, rather than swapping the parts', () => {
    expect(read('13/04/2027', 'MM/DD/YYYY')).toMatch(/not a real calendar date/)
    expect(read('2027-11-04', 'DD/MM/YYYY')).toMatch(/does not look like/)
  })
})

describe('parseImportDate — impossible dates', () => {
  it('refuses a day the month does not have', () => {
    expect(read('31/02/2027', 'DD/MM/YYYY')).toMatch(/not a real calendar date/)
    expect(read('31/04/2027', 'DD/MM/YYYY')).toMatch(/not a real calendar date/)
    expect(read('00/11/2027', 'DD/MM/YYYY')).toMatch(/not a real calendar date/)
  })

  it('knows which February has twenty-nine days', () => {
    expect(read('29/02/2027', 'DD/MM/YYYY')).toMatch(/not a real calendar date/)
    expect(read('29/02/2028', 'DD/MM/YYYY')).toBe('2028-02-29')
  })

  it('refuses a month of thirteen rather than rolling into the next year', () => {
    expect(read('04/13/2027', 'DD/MM/YYYY')).toMatch(/not a real calendar date/)
  })

  it('refuses a month name it does not know, and names it', () => {
    expect(read('04-Febr-2027', 'DD-MMM-YYYY')).toMatch(/month name Coffer does not know.*Febr/)
  })

  it('reads `Sept` as well as `Sep`, because four-letter abbreviations are real', () => {
    expect(read('04-Sept-2027', 'DD-MMM-YYYY')).toBe('2027-09-04')
    expect(read('04-September-2027', 'DD-MMM-YYYY')).toBe('2027-09-04')
  })
})

describe('parseImportDate — two-digit years', () => {
  it('puts a two-digit year in the 2000s, always', () => {
    expect(TWO_DIGIT_YEAR_CENTURY).toBe(2000)
    expect(read('04/11/27', 'DD/MM/YY')).toBe('2027-11-04')
    expect(read('04/11/99', 'DD/MM/YY')).toBe('2099-11-04')
    expect(read('04/11/00', 'DD/MM/YY')).toBe('2000-11-04')
  })

  it('does not slide with the clock, so the same file imports the same way forever', () => {
    /* A window relative to "today" would make this file's meaning change while it sat in
     * a folder. `99` is 2099 whether it is read in 2027 or in 2098. */
    expect(read('04/11/99', 'DD/MM/YY')).not.toBe('1999-11-04')
  })
})

describe('parseImportDate — times and zones', () => {
  it('accepts a trailing clock time and throws it away', () => {
    expect(read('04/11/2027 00:00:00', 'DD/MM/YYYY')).toBe('2027-11-04')
    expect(read('04/11/2027 23:59', 'DD/MM/YYYY')).toBe('2027-11-04')
    expect(read('04/11/2027 11:30 PM', 'DD/MM/YYYY')).toBe('2027-11-04')
    expect(read('2027-11-04T09:30:00.000', 'YYYY-MM-DD')).toBe('2027-11-04')
  })

  it('REFUSES a value that carries a time zone rather than truncating it', () => {
    /* `toISOString().slice(0, 10)` converts to UTC first, so 22:30 IST is the previous
     * day. Dropping an offset silently is the same mistake with the same symptom. */
    expect(read('2027-11-04T22:30:00+05:30', 'YYYY-MM-DD')).toMatch(/time zone/)
    expect(read('2027-11-04T22:30:00Z', 'YYYY-MM-DD')).toMatch(/time zone/)
    expect(read('04/11/2027 22:30:00 -0500', 'DD/MM/YYYY')).toMatch(/time zone/)
  })

  it('does not mistake the hyphens of a plain date for a negative offset', () => {
    /* The condition the zone test alone must not exclude: `2027-11-04` has two hyphens
     * followed by two digits and is not zoned. */
    expect(read('2027-11-04', 'YYYY-MM-DD')).toBe('2027-11-04')
    expect(read('04-11-2027', 'DD-MM-YYYY')).toBe('2027-11-04')
  })
})

describe('parseImportDate — surrounding noise', () => {
  it('reads a value with spaces and unpadded parts', () => {
    expect(read('  4/1/2027  ', 'DD/MM/YYYY')).toBe('2027-01-04')
    expect(read('Nov 04,2027', 'MMM DD, YYYY')).toBe('2027-11-04')
  })

  it('says a blank cell is empty rather than inventing a date', () => {
    expect(read('', 'DD/MM/YYYY')).toBe('FAILED: is empty')
    expect(read('   ', 'DD/MM/YYYY')).toBe('FAILED: is empty')
  })

  it('refuses trailing junk instead of reading the front of it', () => {
    expect(read('04/11/2027 (posted)', 'DD/MM/YYYY')).toMatch(/does not look like/)
  })
})

describe('surveyDateFormats', () => {
  it('says `unambiguous` when one value rules out the alternative', () => {
    /* A single 13 in the first position is enough, in a file of any size. */
    const survey = surveyDateFormats(['05/04/2027', '13/04/2027', '06/07/2027'])
    expect(survey.verdict).toBe('unambiguous')
    expect(survey.consistent).toEqual(['DD/MM/YYYY'])
    expect(survey.valuesConsidered).toBe(3)
  })

  it('names the value that ruled out each format it eliminated', () => {
    const survey = surveyDateFormats(['05/04/2027', '13/04/2027'], ['DD/MM/YYYY', 'MM/DD/YYYY'])
    expect(survey.ruledOut).toEqual([
      {
        format: 'MM/DD/YYYY',
        index: 1,
        value: '13/04/2027',
        why: 'is not a real calendar date when read as MM/DD/YYYY',
      },
    ])
  })

  it('says `ambiguous` when every day is twelve or less, and does NOT pick one', () => {
    const survey = surveyDateFormats(['05/04/2028', '06/07/2028'])
    expect(survey.verdict).toBe('ambiguous')
    expect(survey.consistent).toEqual(['DD/MM/YYYY', 'MM/DD/YYYY'])
    expect(survey.agreeOnEveryValue).toBe(false)
  })

  it('says the survivors AGREE when they read every value the same way', () => {
    /* Ambiguous by format, settled by content: there is nothing to ask the user. */
    const survey = surveyDateFormats(['05/05/2028', '06/06/2028'], ['DD/MM/YYYY', 'MM/DD/YYYY'])
    expect(survey.verdict).toBe('ambiguous')
    expect(survey.agreeOnEveryValue).toBe(true)
  })

  it('says `none` for a column no format reads', () => {
    const survey = surveyDateFormats(['04/11/2027', 'not a date'])
    expect(survey.verdict).toBe('none')
    expect(survey.consistent).toEqual([])
    expect(survey.agreeOnEveryValue).toBe(false)
  })

  it('says `none` for a column with nothing in it, not "everything is consistent"', () => {
    /* Vacuous truth is the trap: every format reads all zero values, and reporting that
     * as agreement would licence a caller to pick one from an empty column. */
    const survey = surveyDateFormats(['', '   ', ''])
    expect(survey.verdict).toBe('none')
    expect(survey.consistent).toEqual([])
    expect(survey.valuesConsidered).toBe(0)
    expect(survey.blankValues).toBe(3)
  })

  it('says `none` for no values at all', () => {
    expect(surveyDateFormats([]).verdict).toBe('none')
  })

  it('skips blanks in a column that also has dates, and counts them', () => {
    const survey = surveyDateFormats(['13/04/2027', '', '06/07/2027'])
    expect(survey.verdict).toBe('unambiguous')
    expect(survey.valuesConsidered).toBe(2)
    expect(survey.blankValues).toBe(1)
  })

  it('honours a narrowed candidate list and reports what it considered', () => {
    const survey = surveyDateFormats(['04/11/2027'], ['DD/MM/YYYY'])
    expect(survey.considered).toEqual(['DD/MM/YYYY'])
    expect(survey.verdict).toBe('unambiguous')
  })

  it('separates the two conditions: consistent means EVERY value, not any', () => {
    /* The row that separates them: DD/MM reads both, MM/DD reads only the first. A
     * survey that accepted "some value parsed" would call this ambiguous. */
    const survey = surveyDateFormats(['05/04/2027', '25/04/2027'], ['DD/MM/YYYY', 'MM/DD/YYYY'])
    expect(survey.consistent).toEqual(['DD/MM/YYYY'])
  })
})

describe('isDateFormat', () => {
  it('accepts every listed format and nothing else', () => {
    for (const format of DATE_FORMATS) {
      expect(isDateFormat(format)).toBe(true)
    }
    expect(isDateFormat('DD/MMM/YYYY')).toBe(false)
    expect(isDateFormat(4)).toBe(false)
    expect(isDateFormat(null)).toBe(false)
  })
})
