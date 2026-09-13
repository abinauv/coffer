import { describe, expect, it } from 'vitest'

import { decodeXmlReferences, PREDEFINED_ENTITY_NAMES, type ReferenceContext } from './entities'
import { XmlError } from './errors'

const decode = (raw: string, context: ReferenceContext = 'text'): string =>
  decodeXmlReferences(raw, 0, raw.length, { line: 1, lineStart: 0 }, context)

const thrown = (raw: string, context: ReferenceContext = 'text'): XmlError => {
  try {
    decode(raw, context)
  } catch (error) {
    if (error instanceof XmlError) {
      return error
    }
    throw error
  }
  throw new Error(`decoding ${JSON.stringify(raw)} did not throw`)
}

const GRINNING = String.fromCodePoint(0x1f600)

describe('the five predefined references', () => {
  it('decodes each one, and nothing else is defined', () => {
    expect(decode('&lt;&gt;&amp;&apos;&quot;')).toBe(`<>&'"`)
    expect(PREDEFINED_ENTITY_NAMES).toEqual(['amp', 'lt', 'gt', 'apos', 'quot'])
  })

  it('does NOT decode twice — `&amp;amp;` is the five characters `&amp;`', () => {
    /* The property that makes entity expansion impossible rather than merely bounded: the
     * replacement text is appended and never re-scanned. */
    expect(decode('&amp;amp;')).toBe('&amp;')
    expect(decode('&amp;lt;')).toBe('&lt;')
  })

  it('leaves text with no references untouched', () => {
    expect(decode('Freight   charges')).toBe('Freight   charges')
    expect(decode('')).toBe('')
  })

  it('decodes several in a row and keeps what is between them', () => {
    expect(decode('a&amp;b&lt;c')).toBe('a&b<c')
  })
})

describe('unknown named references', () => {
  it('refuses `&nbsp;` BY NAME rather than passing six literal characters into a ledger', () => {
    const error = thrown('Smith&nbsp;Sons')
    expect(error.code).toBe('XML_UNKNOWN_ENTITY')
    expect(error.message).toContain('&nbsp;')
    expect(error.message).toContain('&#160;')
  })

  it('refuses an inherited object key, which a plain Record would have answered', () => {
    /* The probe for this batch: `({} as Record<string, string>)['constructor']` is a
     * FUNCTION and `__proto__` is `Object.prototype`. Backed by an object literal, both of
     * these would have decoded to something, and neither would have been a string. */
    expect(thrown('&constructor;').code).toBe('XML_UNKNOWN_ENTITY')
    expect(thrown('&__proto__;').code).toBe('XML_UNKNOWN_ENTITY')
    expect(thrown('&toString;').code).toBe('XML_UNKNOWN_ENTITY')
  })

  it('names the entity in the message so the user can find it in their file', () => {
    expect(thrown('&eacute;').message).toContain('&eacute;')
  })
})

describe('stray ampersands', () => {
  it('refuses an ampersand with no semicolon after it', () => {
    const error = thrown('Smith & Sons')
    expect(error.code).toBe('XML_INVALID_REFERENCE')
    expect(error.message).toContain('&amp;')
  })

  it('refuses an ampersand at the very end of a run', () => {
    expect(thrown('total &').code).toBe('XML_INVALID_REFERENCE')
  })

  it('refuses `&;`, which has a semicolon and no name', () => {
    expect(thrown('a&;b').code).toBe('XML_INVALID_REFERENCE')
  })

  it('does not scan the whole run looking for a semicolon somewhere later', () => {
    /* Without the window, a stray `&` swallows everything up to an unrelated semicolon and
     * quotes it back at the user as the entity name. The message stays short. */
    const error = thrown(`a & ${'x'.repeat(500)};b`)
    expect(error.code).toBe('XML_INVALID_REFERENCE')
    expect(error.message.length).toBeLessThan(160)
  })
})

describe('numeric character references', () => {
  it('decodes decimal and hexadecimal to the same character', () => {
    expect(decode('&#38;')).toBe('&')
    expect(decode('&#x26;')).toBe('&')
    expect(decode('&#38;&#x26;&amp;')).toBe('&&&')
  })

  it('accepts leading zeros', () => {
    expect(decode('&#0038;')).toBe('&')
    expect(decode('&#x0026;')).toBe('&')
  })

  it('decodes an astral character to a surrogate PAIR, of length two', () => {
    const decoded = decode('&#x1F600;')
    expect(decoded).toBe(GRINNING)
    expect(decoded.length).toBe(2)
    expect(decoded.codePointAt(0)).toBe(0x1f600)
  })

  it('refuses a reference to one HALF of a pair, and says how to write the whole thing', () => {
    /* `String.fromCodePoint(0xD83D)` does not throw — probed. It returns a lone surrogate of
     * length one, an ill-formed string that would travel all the way to the database. */
    const error = thrown('&#xD83D;&#xDE00;')
    expect(error.code).toBe('XML_INVALID_CHARACTER_REFERENCE')
    expect(error.message).toContain('surrogate')
    expect(thrown('&#55357;').code).toBe('XML_INVALID_CHARACTER_REFERENCE')
  })

  it('refuses a reference to a character XML forbids', () => {
    for (const reference of ['&#0;', '&#x0;', '&#8;', '&#x1F;', '&#xFFFE;']) {
      expect(thrown(reference).code, reference).toBe('XML_INVALID_CHARACTER_REFERENCE')
    }
    /* And allows the three controls XML does permit, which is the other side of it. */
    expect(decode('&#9;&#10;&#13;')).toBe('\t\n\r')
  })

  it('refuses a number above the highest code point rather than throwing RangeError', () => {
    const error = thrown('&#99999999999999999999;')
    expect(error.code).toBe('XML_INVALID_CHARACTER_REFERENCE')
    expect(error.message).toContain('&#x10FFFF;')
    expect(thrown('&#x110000;').code).toBe('XML_INVALID_CHARACTER_REFERENCE')
    expect(decode('&#x10FFFF;').codePointAt(0)).toBe(0x10ffff)
  })

  it('refuses digits that are not digits, which `Number` would have accepted', () => {
    /* All three of these were probed: Number('') is 0, Number('0x10') is 16, and
     * parseInt('26zz') is 26. Each would have decoded silently, to a wrong character. */
    for (const reference of ['&#;', '&#x;', '&#0x10;', '&#26zz;', '&#x26zz;', '&# 38;']) {
      expect(thrown(reference).code, reference).toBe('XML_INVALID_REFERENCE')
    }
  })

  it('refuses a capital X, because the alternative is guessing what the author meant', () => {
    const error = thrown('&#X26;')
    expect(error.code).toBe('XML_INVALID_REFERENCE')
    expect(error.message).toContain('lower-case x')
  })
})

describe('line endings and the order they are normalised in', () => {
  it('normalises a literal CRLF and a literal lone CR to LF', () => {
    expect(decode('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
  })

  it('KEEPS a `&#xD;`, which is the whole reason the order matters', () => {
    /* XML 1.0 §2.11 normalises literal line endings BEFORE references are resolved. Decode
     * first and this carriage return is folded away with the transport ones. */
    const decoded = decode('a&#xD;b\r\nc')
    expect([...decoded].map((character) => character.charCodeAt(0))).toEqual([97, 13, 98, 10, 99])
  })
})

describe('attribute values', () => {
  it('replaces a literal tab and a literal line break with a space', () => {
    /* XML 1.0 §3.3.3, and it applies to every attribute here because DTDs are refused, so
     * every attribute is of type CDATA and nothing could declare otherwise. */
    expect(decode('a\tb', 'attribute')).toBe('a b')
    expect(decode('a\r\nb', 'attribute')).toBe('a b')
    expect(decode('a\rb\nc', 'attribute')).toBe('a b c')
  })

  it('counts a CRLF as ONE space, because the line ending is normalised first', () => {
    expect(decode('a\r\nb', 'attribute')).toBe('a b')
    expect(decode('a\n\nb', 'attribute')).toBe('a  b')
  })

  it('KEEPS a referenced tab or newline, which is what makes a round trip stable', () => {
    expect(decode('a&#x9;b', 'attribute')).toBe('a\tb')
    expect(decode('a&#xA;b', 'attribute')).toBe('a\nb')
  })

  it('leaves element text alone — the condition that separates the two modes', () => {
    expect(decode('a\tb', 'text')).toBe('a\tb')
    expect(decode('a   b', 'attribute')).toBe('a   b')
  })
})

describe('positions', () => {
  it('reports a bad reference at its own line and column, not at the start of the run', () => {
    const source = '<A>one\ntwo &nbsp; three</A>'
    let error: XmlError | undefined
    try {
      decodeXmlReferences(source, 3, source.indexOf('</A>'), { line: 1, lineStart: 0 }, 'text')
    } catch (caught) {
      error = caught instanceof XmlError ? caught : undefined
    }
    expect(error?.line).toBe(2)
    expect(error?.column).toBe(5)
  })

  it('takes the line the span starts on from its caller', () => {
    const source = 'padding\n<A>&nbsp;</A>'
    let error: XmlError | undefined
    try {
      decodeXmlReferences(source, 11, 17, { line: 2, lineStart: 8 }, 'text')
    } catch (caught) {
      error = caught instanceof XmlError ? caught : undefined
    }
    expect(error?.line).toBe(2)
    expect(error?.column).toBe(4)
  })
})

describe('the span, not the string', () => {
  it('ignores an ampersand that is PAST the end of the span', () => {
    /* The condition `ampersand >= end` alone excludes: the next element's markup. Without
     * it, decoding the text of one element refuses on a reference in the one after it. */
    const source = '<A>plain</A>&nbsp;'
    expect(decodeXmlReferences(source, 3, 8, { line: 1, lineStart: 0 }, 'text')).toBe('plain')
  })

  it('ignores an ampersand BEFORE the start of the span', () => {
    const source = '&amp;<A>plain</A>'
    expect(decodeXmlReferences(source, 8, 13, { line: 1, lineStart: 0 }, 'text')).toBe('plain')
  })

  it('decodes an empty span to an empty string', () => {
    expect(decodeXmlReferences('<A></A>', 3, 3, { line: 1, lineStart: 0 }, 'text')).toBe('')
  })
})
