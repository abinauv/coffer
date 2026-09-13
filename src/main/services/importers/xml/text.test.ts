import { describe, expect, it } from 'vitest'

import {
  BYTE_ORDER_MARK,
  collapseXmlSpace,
  cursorAt,
  findForbiddenCharacter,
  isAllowedXmlCodePoint,
  isXmlName,
  isXmlNameStart,
  isXmlWhitespace,
  isXmlWhitespaceOnly,
  positionAt,
  positionOf,
  readXmlName,
  seekTo,
  stripByteOrderMark,
} from './text'

/* Built rather than typed. A byte order mark and a NUL are invisible in a source file, so
 * an editor, a formatter or a re-encoding can remove one and every test still passes. */
const BOM = String.fromCharCode(0xfeff)
const NUL = String.fromCharCode(0)
const HIGH_SURROGATE = String.fromCharCode(0xd83d)
const GRINNING = String.fromCodePoint(0x1f600)

describe('stripByteOrderMark', () => {
  it('strips one at position zero and says it was there', () => {
    expect(stripByteOrderMark(`${BOM}<A/>`)).toEqual({ text: '<A/>', hadByteOrderMark: true })
  })

  it('leaves a U+FEFF that is not at position zero, which is a character and not a mark', () => {
    const text = `<A>a${BOM}b</A>`
    expect(stripByteOrderMark(text)).toEqual({ text, hadByteOrderMark: false })
  })

  it('is idempotent, which is what lets parseXml and scanXml both call it', () => {
    const once = stripByteOrderMark(`${BOM}<A/>`)
    expect(stripByteOrderMark(once.text)).toEqual({ text: '<A/>', hadByteOrderMark: false })
  })

  it('strips only one mark, so a doubled one leaves a character behind', () => {
    /* Two marks is a file that was decoded twice. The second is data, and saying so is
     * more honest than looping until there are none left. */
    expect(stripByteOrderMark(`${BOM}${BOM}<A/>`).text).toBe(`${BOM}<A/>`)
  })

  it('exports the mark rather than leaving every caller to type an escape', () => {
    expect(BYTE_ORDER_MARK.charCodeAt(0)).toBe(0xfeff)
  })
})

describe('line and column counting', () => {
  it('counts LF, CRLF and a lone CR as one line break each', () => {
    expect(positionAt('a\nb', 2)).toEqual({ line: 2, column: 1 })
    expect(positionAt('a\r\nb', 3)).toEqual({ line: 2, column: 1 })
    expect(positionAt('a\rb', 2)).toEqual({ line: 2, column: 1 })
  })

  it('counts a CRLF ONCE — the condition the lone-CR half of the rule alone excludes', () => {
    /* `\r` is a break only when no `\n` follows. Delete that half and every position after
     * the first Windows line ending in the file is one line too far down. */
    expect(positionAt('a\r\nb\r\nc', 6)).toEqual({ line: 3, column: 1 })
    expect(positionAt('a\rb\rc', 4)).toEqual({ line: 3, column: 1 })
  })

  it('does not overshoot when asked to stop BETWEEN the CR and the LF of a pair', () => {
    /* The reason the rule is written per character. A cursor that consumed CRLF in one
     * step would land past this index and then disagree with the scanner about where it is. */
    const cursor = cursorAt()
    seekTo('a\r\nb', cursor, 2)
    expect(cursor.index).toBe(2)
    seekTo('a\r\nb', cursor, 4)
    expect(positionOf(cursor)).toEqual({ line: 2, column: 2 })
  })

  it('counts columns in UTF-16 units, so an astral character advances two', () => {
    expect(positionAt(`${GRINNING}x`, 2)).toEqual({ line: 1, column: 3 })
  })

  it('never moves a cursor backwards, so a target already passed is a no-op', () => {
    const cursor = cursorAt()
    seekTo('a\nb\nc', cursor, 4)
    const reached = positionOf(cursor)
    seekTo('a\nb\nc', cursor, 0)
    expect(positionOf(cursor)).toEqual(reached)
  })

  it('starts at line 1, column 1', () => {
    expect(positionAt('anything', 0)).toEqual({ line: 1, column: 1 })
  })
})

describe('collapseXmlSpace', () => {
  it('trims and collapses runs of XML whitespace', () => {
    expect(collapseXmlSpace('\n   Two  inner  spaces  \t\n')).toBe('Two inner spaces')
  })

  it('does NOT fold a non-breaking space, which csv/text.ts deliberately does fold', () => {
    /* The condition that separates XML's S production from JavaScript's `\s`. A U+00A0 in
     * a ledger name is a character somebody typed; folding it would make two different
     * ledgers compare equal. */
    const nbsp = String.fromCharCode(0x00a0)
    expect(collapseXmlSpace(`Acme${nbsp}Supplies`)).toBe(`Acme${nbsp}Supplies`)
    expect(collapseXmlSpace(`a${nbsp} b`)).toBe(`a${nbsp} b`)
  })

  it('leaves a string with nothing to collapse exactly as it was', () => {
    expect(collapseXmlSpace('Freight charges')).toBe('Freight charges')
  })

  it('reduces whitespace-only text to the empty string', () => {
    expect(collapseXmlSpace(' \t\r\n ')).toBe('')
  })
})

describe('isXmlWhitespace and isXmlWhitespaceOnly', () => {
  it('is exactly space, tab, CR and LF', () => {
    for (const character of [' ', '\t', '\r', '\n']) {
      expect(isXmlWhitespace(character), JSON.stringify(character)).toBe(true)
    }
    for (const character of [String.fromCharCode(0x00a0), String.fromCharCode(0x2003), 'x']) {
      expect(isXmlWhitespace(character), JSON.stringify(character)).toBe(false)
    }
  })

  it('calls the empty string whitespace-only and a single letter not', () => {
    expect(isXmlWhitespaceOnly('')).toBe(true)
    expect(isXmlWhitespaceOnly(' \t\r\n')).toBe(true)
    expect(isXmlWhitespaceOnly(' x ')).toBe(false)
    expect(isXmlWhitespaceOnly(String.fromCharCode(0x00a0))).toBe(false)
  })
})

describe('names', () => {
  it('accepts the names a Tally export uses, dots and hyphens included', () => {
    for (const name of ['A', 'VOUCHER', 'VCH.TYPE', 'ns:tag', '_x', 'a-b', 'a1']) {
      expect(isXmlName(name), name).toBe(true)
    }
  })

  it('refuses a name that starts with a digit, a hyphen, a dot or nothing', () => {
    for (const name of ['1A', '-A', '.A', '', ' A', 'A B', 'A<']) {
      expect(isXmlName(name), JSON.stringify(name)).toBe(false)
    }
  })

  it('accepts a non-ASCII name, because rejecting one would be inventing a rule', () => {
    expect(isXmlName('Cliente')).toBe(true)
    expect(isXmlName(String.fromCharCode(0xe9, 0x74, 0xe9))).toBe(true)
    expect(isXmlNameStart(String.fromCharCode(0xe9))).toBe(true)
  })

  it('reads the name at an index and stops where the name stops', () => {
    expect(readXmlName('<VOUCHER DATE="1">', 1)).toBe('VOUCHER')
    expect(readXmlName('<VOUCHER/>', 1)).toBe('VOUCHER')
    expect(readXmlName('</VOUCHER>', 2)).toBe('VOUCHER')
    expect(readXmlName('< VOUCHER>', 1)).toBe('')
  })

  it('reads a name at an index without slicing, so two calls do not interfere', () => {
    /* The sticky regex carries `lastIndex` between calls. If it were not reset on every
     * call this second read would start where the first stopped and return nothing. */
    const text = '<AAA><BB>'
    expect(readXmlName(text, 1)).toBe('AAA')
    expect(readXmlName(text, 6)).toBe('BB')
    expect(readXmlName(text, 1)).toBe('AAA')
  })
})

describe('the Char production', () => {
  it('finds a NUL, which is what a mis-decoded UTF-16 file is full of', () => {
    expect(findForbiddenCharacter(`<A>a${NUL}b</A>`)).toBe(4)
  })

  it('finds an unpaired surrogate, which needs the u flag to be visible at all', () => {
    expect(findForbiddenCharacter(`<A>${HIGH_SURROGATE}</A>`)).toBe(3)
    /* And a PROPERLY paired one is a legal astral character, not a pair of forbidden
     * halves — the condition that makes the u flag necessary rather than merely correct. */
    expect(findForbiddenCharacter(`<A>${GRINNING}</A>`)).toBe(-1)
  })

  it('allows tab, newline and carriage return and refuses the other controls', () => {
    expect(findForbiddenCharacter('a\t\r\nb')).toBe(-1)
    expect(findForbiddenCharacter(`a${String.fromCharCode(0x0b)}b`)).toBe(1)
    expect(findForbiddenCharacter(`a${String.fromCharCode(0x1f)}b`)).toBe(1)
  })

  it('allows U+FFFD and refuses U+FFFE, which are adjacent and on opposite sides', () => {
    expect(findForbiddenCharacter(String.fromCharCode(0xfffd))).toBe(-1)
    expect(findForbiddenCharacter(String.fromCharCode(0xfffe))).toBe(0)
  })

  it('agrees with the code-point form at every boundary', () => {
    const allowed = [0x9, 0xa, 0xd, 0x20, 0xd7ff, 0xe000, 0xfffd, 0x10000, 0x10ffff]
    const refused = [0x0, 0x8, 0xb, 0xc, 0x1f, 0xd800, 0xdfff, 0xfffe, 0xffff, 0x110000]
    for (const codePoint of allowed) {
      expect(isAllowedXmlCodePoint(codePoint), codePoint.toString(16)).toBe(true)
    }
    for (const codePoint of refused) {
      expect(isAllowedXmlCodePoint(codePoint), codePoint.toString(16)).toBe(false)
    }
  })

  it('says nothing is wrong with an ordinary document', () => {
    expect(findForbiddenCharacter('<ENVELOPE><A>1,234.50</A></ENVELOPE>')).toBe(-1)
  })
})
