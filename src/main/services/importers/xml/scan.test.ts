import { describe, expect, it } from 'vitest'

import { XmlError, type XmlIssue } from './errors'
import { scanXml, XML_DEFAULTS, type XmlEvent, type XmlScanOptions } from './scan'

const events = (text: string, options: XmlScanOptions = {}): XmlEvent[] => [
  ...scanXml(text, options),
]

/** A compact shape for asserting a whole stream at once. */
const shape = (text: string, options: XmlScanOptions = {}): unknown[] =>
  events(text, options).map((event) => {
    switch (event.kind) {
      case 'open':
        return [event.kind, event.name, event.isSelfClosing]
      case 'close':
        return [event.kind, event.name]
      case 'text':
        return [event.kind, event.text, event.isWhitespace, event.isCdata]
      case 'comment':
        return [event.kind, event.text]
      case 'instruction':
        return [event.kind, event.target, event.data]
      case 'declaration':
        return [event.kind, event.version, event.encoding, event.standalone]
    }
  })

const thrown = (text: string, options: XmlScanOptions = {}): XmlError => {
  try {
    events(text, options)
  } catch (error) {
    if (error instanceof XmlError) {
      return error
    }
    throw error
  }
  throw new Error(`scanning ${JSON.stringify(text.slice(0, 40))} did not throw`)
}

const issuesOf = (text: string, options: XmlScanOptions = {}): XmlIssue[] => {
  const issues: XmlIssue[] = []
  events(text, { ...options, onIssue: (issue) => issues.push(issue) })
  return issues
}

const NUL = String.fromCharCode(0)
const BOM = String.fromCharCode(0xfeff)
const REPLACEMENT = String.fromCharCode(0xfffd)

describe('elements, attributes and nesting', () => {
  it('yields an open and a close around the text between them', () => {
    expect(shape('<A>hi</A>')).toEqual([
      ['open', 'A', false],
      ['text', 'hi', false, false],
      ['close', 'A'],
    ])
  })

  it('yields BOTH an open and a close for a self-closing element', () => {
    /* Every consumer of this stream tracks depth. A `<X/>` that opened without closing
     * would need a special case in each of them, and one of them would not have it. */
    expect(shape('<A><B/></A>')).toEqual([
      ['open', 'A', false],
      ['open', 'B', true],
      ['close', 'B'],
      ['close', 'A'],
    ])
  })

  it('reads mixed content as text, element, text', () => {
    expect(shape('<A>before <B>bold</B> after</A>')).toEqual([
      ['open', 'A', false],
      ['text', 'before ', false, false],
      ['open', 'B', false],
      ['text', 'bold', false, false],
      ['close', 'B'],
      ['text', ' after', false, false],
      ['close', 'A'],
    ])
  })

  it('reads attributes in either quote style, each holding the other kind', () => {
    const [open] = events(`<A zeta="single 'quotes'" alpha='double "quotes"'/>`)
    expect(open?.kind === 'open' ? open.attributes : undefined).toEqual({
      zeta: "single 'quotes'",
      alpha: 'double "quotes"',
    })
  })

  it('keeps attributes in DOCUMENT order, not sorted', () => {
    const [open] = events('<A zeta="1" alpha="2" mid="3"/>')
    const keys = open?.kind === 'open' ? Object.keys(open.attributes) : []
    expect(keys).toEqual(['zeta', 'alpha', 'mid'])
  })

  it('keeps an attribute called __proto__ as a string, which a plain object drops', () => {
    /* Probed: `({})['__proto__'] = 'x'` creates no own property and reads back as
     * `Object.prototype`. The attribute name comes from the file, so the file chooses the
     * key, and a null-prototype object is the only shape where every key behaves. */
    const [open] = events('<A __proto__="one" constructor="two" hasOwnProperty="three"/>')
    const attributes = open?.kind === 'open' ? open.attributes : {}
    expect(Object.keys(attributes)).toEqual(['__proto__', 'constructor', 'hasOwnProperty'])
    expect(attributes['__proto__']).toBe('one')
    expect(typeof attributes['constructor']).toBe('string')
    expect(attributes['hasOwnProperty']).toBe('three')
  })

  it("refuses a '<' inside an attribute value, which is what an unclosed quote looks like", () => {
    /* Not pedantry about the specification: the alternative is swallowing the next hundred
     * tags into one attribute value and reporting nothing at all. */
    const error = thrown('<A x="a<b"/>')
    expect(error.code).toBe('XML_ATTRIBUTE_MALFORMED')
    expect(error.message).toContain('&lt;')
  })

  it('reads an empty attribute value as present and empty', () => {
    const [open] = events('<A x="" y="1"/>')
    expect(open?.kind === 'open' ? open.attributes : undefined).toEqual({ x: '', y: '1' })
  })

  it('decodes references in text and in attribute values', () => {
    const [open, text] = events('<A note="a &amp; b">c &lt; d</A>')
    expect(open?.kind === 'open' ? open.attributes['note'] : undefined).toBe('a & b')
    expect(text?.kind === 'text' ? text.text : undefined).toBe('c < d')
  })

  it('reads an element with no content at all as an open and a close', () => {
    expect(shape('<A></A>')).toEqual([
      ['open', 'A', false],
      ['close', 'A'],
    ])
  })

  it('allows whitespace around the parts of a tag', () => {
    expect(shape('<A  x = "1"  />')).toEqual([
      ['open', 'A', true],
      ['close', 'A'],
    ])
  })
})

describe('comments, processing instructions and CDATA', () => {
  it('yields a comment and does not decode anything inside it', () => {
    expect(shape('<A><!-- &nbsp; and <b> --></A>')).toEqual([
      ['open', 'A', false],
      ['comment', ' &nbsp; and <b> '],
      ['close', 'A'],
    ])
  })

  it('ACCEPTS a comment containing a double hyphen, which XML forbids', () => {
    /* Decided, and the line is: refuse where accepting would mean GUESSING what the file
     * says, accept where the meaning is unambiguous. `--` inside a comment is unambiguous,
     * the comment is discarded anyway, and refusing a whole company's export over a
     * decorative rule of hyphens is the wrong trade. `&#X26;` is on the other side of the
     * line, because there we would be choosing between a reference and literal text. */
    expect(shape('<A><!-- a -- b --></A>')[1]).toEqual(['comment', ' a -- b '])
  })

  it('closes a comment at the FIRST `-->`, so `--->` leaves the hyphen inside', () => {
    expect(shape('<A><!-- a ---></A>')[1]).toEqual(['comment', ' a -'])
    expect(shape('<A><!----></A>')[1]).toEqual(['comment', ''])
  })

  it('yields a processing instruction with its target and its data verbatim', () => {
    expect(shape('<A><?tally  do this ?></A>')[1]).toEqual(['instruction', 'tally', 'do this '])
  })

  it('reads a processing instruction with no data at all', () => {
    /* The condition `cursor.index < closeAt` alone excludes: `<?tally?>` needs no space
     * because it has no data for a space to separate. */
    expect(shape('<A><?tally?></A>')[1]).toEqual(['instruction', 'tally', ''])
  })

  it('needs a space between a target and its data', () => {
    expect(thrown('<A><?tally"x"?></A>').code).toBe('XML_INVALID_NAME')
  })

  it('yields CDATA as text, with no decoding and no markup', () => {
    expect(shape('<A><![CDATA[&amp; <b> ]]></A>')[1]).toEqual(['text', '&amp; <b> ', false, true])
  })

  it('carries a literal `]]>` through two CDATA sections, which is the only way to write it', () => {
    expect(shape('<A><![CDATA[a]]]]><![CDATA[>b]]></A>')).toEqual([
      ['open', 'A', false],
      ['text', 'a]]', false, true],
      ['text', '>b', false, true],
      ['close', 'A'],
    ])
    /* The two runs concatenate to the one string the author meant, which is what the tree
     * hands a caller once they have been coalesced. */
    expect(
      events('<A><![CDATA[a]]]]><![CDATA[>b]]></A>')
        .filter((event) => event.kind === 'text')
        .map((event) => (event.kind === 'text' ? event.text : ''))
        .join(''),
    ).toBe('a]]>b')
  })

  it('accepts a bare `]]>` in ordinary text', () => {
    /* Forbidden by the letter of the specification and unambiguous in practice. Same line
     * as the double hyphen above. */
    expect(shape('<A>a]]>b</A>')[1]).toEqual(['text', 'a]]>b', false, false])
  })

  it('marks a whitespace-only CDATA section as whitespace', () => {
    expect(shape('<A><![CDATA[  ]]></A>')[1]).toEqual(['text', '  ', true, true])
  })

  it('allows a comment and an instruction outside the root but not a CDATA section', () => {
    expect(shape('<!--x--><?p d?><A/>')).toEqual([
      ['comment', 'x'],
      ['instruction', 'p', 'd'],
      ['open', 'A', true],
      ['close', 'A'],
    ])
    expect(thrown('<![CDATA[x]]><A/>').code).toBe('XML_CONTENT_OUTSIDE_ROOT')
  })
})

describe('whitespace', () => {
  it('flags a run that is nothing but layout, and does not touch it', () => {
    expect(shape('<A>\n  <B>x</B>\n</A>')).toEqual([
      ['open', 'A', false],
      ['text', '\n  ', true, false],
      ['open', 'B', false],
      ['text', 'x', false, false],
      ['close', 'B'],
      ['text', '\n', true, false],
      ['close', 'A'],
    ])
  })

  it('keeps the internal spacing of a narration exactly as written', () => {
    const [, text] = events('<A>   Two  inner  spaces   </A>')
    expect(text?.kind === 'text' ? text.text : undefined).toBe('   Two  inner  spaces   ')
  })

  it('normalises line endings in text, because a line ending is transport', () => {
    const [, text] = events('<A>one\r\ntwo\rthree\nfour</A>')
    expect(text?.kind === 'text' ? text.text : undefined).toBe('one\ntwo\nthree\nfour')
  })

  it('allows whitespace outside the root and refuses anything else there', () => {
    /* Both halves of `openElements.length === 0 && !isWhitespace`. Delete the whitespace
     * half and every indented document is refused; delete the depth half and stray text
     * inside an element is refused too. */
    expect(shape('\n<A/>\n')).toEqual([
      ['text', '\n', true, false],
      ['open', 'A', true],
      ['close', 'A'],
      ['text', '\n', true, false],
    ])
    expect(thrown('junk\n<A/>').code).toBe('XML_CONTENT_OUTSIDE_ROOT')
  })
})

describe('the byte order mark and positions', () => {
  it('strips a leading mark and counts positions in the text without it', () => {
    const [open] = events(`${BOM}<A/>`)
    expect(open?.line).toBe(1)
    expect(open?.column).toBe(1)
  })

  it('gives every event the line and column of its opening character', () => {
    const opened = events('<A>\r\n  <B x="1">t</B>\r\n</A>').filter(
      (event) => event.kind === 'open',
    )
    expect(opened.map((event) => [event.line, event.column])).toEqual([
      [1, 1],
      [2, 3],
    ])
  })

  it('counts a lone CR as a line, which an exporter of a certain age produces', () => {
    const opened = events('<A>\r<B/>\r</A>').filter((event) => event.kind === 'open')
    expect(opened.map((event) => event.line)).toEqual([1, 2])
  })
})

describe('the XML declaration', () => {
  it('reads version, encoding and standalone', () => {
    expect(shape(`<?xml version="1.0" encoding="UTF-8" standalone='yes'?><A/>`)[0]).toEqual([
      'declaration',
      '1.0',
      'UTF-8',
      'yes',
    ])
  })

  it('leaves what the document did not say as undefined', () => {
    expect(shape('<?xml version="1.0"?><A/>')[0]).toEqual([
      'declaration',
      '1.0',
      undefined,
      undefined,
    ])
  })

  it('takes the FIRST value when a key is written twice', () => {
    expect(shape('<?xml version="1.0" version="2.0"?><A/>')[0]).toEqual([
      'declaration',
      '1.0',
      undefined,
      undefined,
    ])
  })

  it('refuses a declaration that is not at the very start, whitespace included', () => {
    expect(thrown(' <?xml version="1.0"?><A/>').code).toBe('XML_DECLARATION_MISPLACED')
    expect(thrown('<A/><?xml version="1.0"?>').code).toBe('XML_DECLARATION_MISPLACED')
    /* And accepts one that follows a byte order mark, because the mark is stripped first. */
    expect(shape(`${BOM}<?xml version="1.0"?><A/>`)[0]).toEqual([
      'declaration',
      '1.0',
      undefined,
      undefined,
    ])
  })

  it('refuses the reserved target in capitals rather than reading it as a declaration', () => {
    expect(thrown('<?XML version="1.0"?><A/>').code).toBe('XML_RESERVED_TARGET')
    expect(thrown('<?Xml version="1.0"?><A/>').code).toBe('XML_RESERVED_TARGET')
  })
})

describe('the encoding declaration is REPORTED, not refused', () => {
  it('warns about an encoding it cannot vouch for, and still reads the document', () => {
    const issues = issuesOf('<?xml version="1.0" encoding="UTF-16"?><A>x</A>')
    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe('ENCODING_UNVERIFIED')
    expect(issues[0]?.severity).toBe('warning')
    expect(issues[0]?.value).toBe('UTF-16')
    expect(issues[0]?.line).toBe(1)
    /* The data came through. Refusing here would refuse a UTF-16 export that the caller
     * decoded CORRECTLY, which is the file the importer exists to read. */
    expect(shape('<?xml version="1.0" encoding="UTF-16"?><A>x</A>')[2]).toEqual([
      'text',
      'x',
      false,
      false,
    ])
  })

  it('says nothing about UTF-8, however it is spelled, or about ASCII', () => {
    for (const encoding of ['UTF-8', 'utf-8', ' utf8 ', 'US-ASCII', 'ascii']) {
      expect(issuesOf(`<?xml version="1.0" encoding="${encoding}"?><A/>`), encoding).toEqual([])
    }
  })

  it('says nothing when there is no declaration and nothing when it names no encoding', () => {
    expect(issuesOf('<A/>')).toEqual([])
    expect(issuesOf('<?xml version="1.0"?><A/>')).toEqual([])
  })

  it('warns about ISO-8859-1, the case no check on the TEXT could ever catch', () => {
    /* Measured: a UTF-8 file read as ISO-8859-1 produces no forbidden character and no
     * U+FFFD. Every character in it is legal. For that failure the declaration is the only
     * signal there is, which is exactly why it has to reach the user. */
    const mojibake = Buffer.from('<A>Café</A>', 'utf8').toString('latin1')
    expect(issuesOf(mojibake)).toEqual([])
    expect(issuesOf('<?xml version="1.0" encoding="ISO-8859-1"?><A/>')).toHaveLength(1)
  })

  it('reports replacement characters, with a count and the first position', () => {
    const issues = issuesOf(`<A>Caf${REPLACEMENT} ${REPLACEMENT}</A>`)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe('REPLACEMENT_CHARACTER')
    expect(issues[0]?.severity).toBe('warning')
    expect(issues[0]?.message).toContain('2 replacement characters')
    expect(issues[0]?.line).toBe(1)
    expect(issues[0]?.column).toBe(7)
  })

  it('does not report a replacement character that is not there', () => {
    expect(issuesOf('<A>Cafe</A>')).toEqual([])
  })
})

describe('a DOCTYPE is refused, by name', () => {
  it('refuses one, whatever case it is written in', () => {
    for (const text of ['<!DOCTYPE A><A/>', '<!doctype A><A/>', '<!DocType A><A/>']) {
      expect(thrown(text).code, text).toBe('XML_DOCTYPE_FORBIDDEN')
    }
  })

  it('refuses the billion-laughs shape at the doctype, before any entity is read', () => {
    const bomb =
      '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>' +
      '<lolz>&lol2;</lolz>'
    const error = thrown(bomb)
    expect(error.code).toBe('XML_DOCTYPE_FORBIDDEN')
    expect(error.line).toBe(1)
    expect(error.column).toBe(1)
  })

  it('refuses an external entity declaration the same way', () => {
    const xxe = '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>'
    expect(thrown(xxe).code).toBe('XML_DOCTYPE_FORBIDDEN')
  })

  it('refuses any other `<!` construct rather than stepping over it', () => {
    expect(thrown('<!ENTITY x "y"><A/>').code).toBe('XML_INVALID_MARKUP')
    expect(thrown('<A><!ATTLIST B x CDATA #IMPLIED></A>').code).toBe('XML_INVALID_MARKUP')
    expect(thrown('<A><!junk></A>').code).toBe('XML_INVALID_MARKUP')
  })
})

describe('malformed input, each with a position', () => {
  const cases: readonly [string, string, number, number][] = [
    ['<A>\n  <B>x', 'XML_UNCLOSED_ELEMENT', 2, 3],
    ['<A>\n<B>x</A>', 'XML_MISMATCHED_TAG', 2, 5],
    ['<A/>\n</B>', 'XML_UNEXPECTED_CLOSE_TAG', 2, 1],
    ['<A>\na < b\n</A>', 'XML_INVALID_NAME', 2, 3],
    ['<A>\na & b\n</A>', 'XML_INVALID_REFERENCE', 2, 3],
    ['<A>\na&nbsp;b\n</A>', 'XML_UNKNOWN_ENTITY', 2, 2],
    ['<A>\n<B DATE="2027', 'XML_UNTERMINATED_TAG', 2, 4],
    ['<A>\n<BB', 'XML_UNTERMINATED_TAG', 2, 1],
    ['<A>\n<B x=1/>\n</A>', 'XML_ATTRIBUTE_UNQUOTED', 2, 6],
    ['<A>\n<B checked/>\n</A>', 'XML_ATTRIBUTE_MALFORMED', 2, 4],
    ['<A x="1"y="2"/>', 'XML_ATTRIBUTE_MALFORMED', 1, 9],
    ['<A x="1" x="2"/>', 'XML_DUPLICATE_ATTRIBUTE', 1, 10],
    ['<A/>\n<B/>', 'XML_MULTIPLE_ROOTS', 2, 1],
    ['<A>\n<!-- unfinished\n</A>', 'XML_UNTERMINATED_COMMENT', 2, 1],
    ['<A>\n<![CDATA[unfinished\n</A>', 'XML_UNTERMINATED_CDATA', 2, 1],
    ['<A>\n<?pi unfinished\n</A>', 'XML_UNTERMINATED_PI', 2, 1],
    ['<A>\n</A x="1">', 'XML_INVALID_NAME', 2, 5],
    ['<A>\n<B / >\n</A>', 'XML_ATTRIBUTE_MALFORMED', 2, 4],
    ['<A>text<', 'XML_UNTERMINATED_TAG', 1, 8],
  ]

  it.each(cases)('%s is %s at line %i, column %i', (text, code, line, column) => {
    const error = thrown(text)
    expect(error.code).toBe(code)
    expect(error.line).toBe(line)
    expect(error.column).toBe(column)
    /* The numbers are in the sentence too, so a dialog that shows only the message still
     * sends the user to the right place. */
    expect(error.message).toContain(`Line ${String(line)}, column ${String(column)}`)
  })

  it('reports an unclosed element where it OPENED, and counts how many are open', () => {
    const error = thrown('<ENVELOPE>\n <BODY>\n  <VOUCHER>\n')
    expect(error.code).toBe('XML_UNCLOSED_ELEMENT')
    expect(error.line).toBe(3)
    expect(error.message).toContain('<VOUCHER>')
    expect(error.message).toContain('3 elements are still open')
  })

  it('names both elements when a close tag does not match', () => {
    const error = thrown('<VOUCHER>\n<LEDGER>x</VOUCHER>')
    expect(error.message).toContain('</VOUCHER>')
    expect(error.message).toContain('<LEDGER>')
    expect(error.message).toContain('line 2')
  })

  it('refuses a character XML forbids before it reads a single tag', () => {
    const error = thrown(`<A>ledger${NUL}name</A>`)
    expect(error.code).toBe('XML_INVALID_CHARACTER')
    expect(error.column).toBe(10)
    expect(error.message).toContain('U+0000')
  })

  it('catches a UTF-16 export read as UTF-8 at its second character', () => {
    const misread = Buffer.from('<?xml version="1.0" encoding="UTF-16"?><A/>', 'utf16le').toString(
      'utf8',
    )
    const error = thrown(misread)
    expect(error.code).toBe('XML_INVALID_CHARACTER')
    expect(error.line).toBe(1)
    expect(error.column).toBe(2)
  })
})

describe('the caps on untrusted input', () => {
  it('refuses nesting deeper than the limit and allows nesting exactly at it', () => {
    expect(scanXml('<A/>', { maxDepth: 1 }).next().value).toMatchObject({ name: 'A' })
    const error = thrown('<A><B/></A>', { maxDepth: 1 })
    expect(error.code).toBe('XML_TOO_DEEP')
    expect(error.column).toBe(4)
    expect(events('<A><B/></A>', { maxDepth: 2 })).toHaveLength(4)
  })

  it('refuses more elements than the limit and allows exactly the limit', () => {
    expect(thrown('<A><B/><C/></A>', { maxElements: 2 }).code).toBe('XML_TOO_MANY_ELEMENTS')
    expect(events('<A><B/></A>', { maxElements: 2 })).toHaveLength(4)
  })

  it('refuses a run of text longer than the limit and allows exactly the limit', () => {
    expect(thrown('<A>abcd</A>', { maxTextLength: 3 }).code).toBe('XML_TEXT_TOO_LONG')
    expect(thrown('<A><![CDATA[abcd]]></A>', { maxTextLength: 3 }).code).toBe('XML_TEXT_TOO_LONG')
    expect(thrown('<A x="abcd"/>', { maxTextLength: 3 }).code).toBe('XML_TEXT_TOO_LONG')
    expect(events('<A>abc</A>', { maxTextLength: 3 })).toHaveLength(3)
  })

  it('refuses more attributes on one element than the limit', () => {
    /* The element cap alone does not bound this: an element with ten million attributes is
     * ONE element. The same reason csv/parse.ts caps fields per row as well as rows. */
    expect(thrown('<A x="1" y="2"/>', { maxAttributesPerElement: 1 }).code).toBe(
      'XML_TOO_MANY_ATTRIBUTES',
    )
    expect(events('<A x="1"/>', { maxAttributesPerElement: 1 })).toHaveLength(2)
  })

  it('refuses a limit of zero rather than reading it as "no limit"', () => {
    /* The test is whether zero describes something that CAN EXIST. `maxDecimalPlaces: 0` in
     * the csv batch was accepted because whole rupees exist; zero elements is not a
     * document, zero depth is a root that cannot open, and zero characters of text is
     * nothing anyone can say. All three are refused at the door, as a size cap of 0 was
     * there — read as "unlimited" they would be a cap that had quietly stopped existing. */
    for (const bad of [0, -0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const key of [
        'maxDepth',
        'maxElements',
        'maxTextLength',
        'maxAttributesPerElement',
      ] as const) {
        const error = thrown('<A/>', { [key]: bad })
        expect(error.code, `${key} ${String(bad)}`).toBe('XML_LIMIT_INVALID')
        expect(error.message).toContain(key)
      }
    }
  })

  it('is the ONE error with no position, because it is about the caller and not the file', () => {
    const error = thrown('<A/>', { maxDepth: 0 })
    expect(error.line).toBeUndefined()
    expect(error.column).toBeUndefined()
  })

  it('accepts a limit of exactly one everywhere', () => {
    expect(
      events('<A x="1"/>', {
        maxDepth: 1,
        maxElements: 1,
        maxTextLength: 1,
        maxAttributesPerElement: 1,
      }),
    ).toHaveLength(2)
  })

  it('validates the caps before it looks at the document, so a bad file cannot mask one', () => {
    expect(thrown('<A><B></A>', { maxDepth: 0 }).code).toBe('XML_LIMIT_INVALID')
  })

  it('ships defaults that a real export fits inside', () => {
    expect(XML_DEFAULTS.maxDepth).toBeGreaterThan(64)
    expect(XML_DEFAULTS.maxElements).toBeGreaterThan(500_000)
    expect(XML_DEFAULTS.maxTextLength).toBeGreaterThan(10_000)
    expect(XML_DEFAULTS.maxAttributesPerElement).toBeGreaterThan(16)
  })

  it('does not overflow the stack on a document deeper than the default cap', () => {
    /* The scanner keeps an explicit stack, so a hostile document reaches the CAP rather
     * than a RangeError. A recursive-descent parser fails the other way round, and a
     * "Maximum call stack size exceeded" tells a user nothing about their file. */
    const deep = `${'<a>'.repeat(5_000)}x${'</a>'.repeat(5_000)}`
    const error = thrown(deep, { maxDepth: 4_000 })
    expect(error.code).toBe('XML_TOO_DEEP')
  })
})

describe('degenerate documents', () => {
  it('yields nothing for an empty document and for one that is only a mark', () => {
    expect(events('')).toEqual([])
    expect(events(BOM)).toEqual([])
  })

  it('reads a document that is only a comment', () => {
    expect(shape('<!-- nothing here -->')).toEqual([['comment', ' nothing here ']])
  })

  it('stops at the first problem rather than collecting them', () => {
    /* XML is refused, not reported, and this is why: after `</A>` closes `<B>` there is no
     * honest reading of what follows. A parser that recovered would produce a tree, and
     * the tree would be confidently wrong. */
    expect(thrown('<A><B>x</A><C>y</C>').code).toBe('XML_MISMATCHED_TAG')
  })
})
