import { describe, expect, it } from 'vitest'

import { XmlError, type XmlIssue } from './errors'
import { attributeOf, childElements, firstChildElement, isElement, isText, textOf } from './nodes'
import { findElements, parseXml, readXmlSubtrees, type XmlParseOptions } from './parse'
import { collapseXmlSpace } from './text'

const BOM = String.fromCharCode(0xfeff)

const thrown = (text: string, options: XmlParseOptions = {}): XmlError => {
  try {
    parseXml(text, options)
  } catch (error) {
    if (error instanceof XmlError) {
      return error
    }
    throw error
  }
  throw new Error(`parsing ${JSON.stringify(text.slice(0, 40))} did not throw`)
}

describe('parseXml — the tree', () => {
  it('builds elements, attributes and children in document order', () => {
    const { root } = parseXml('<A id="1"><C/><B>x</B></A>')
    expect(root.name).toBe('A')
    /* toEqual, not toStrictEqual: the attribute record has a null prototype on purpose and
     * toStrictEqual compares prototypes. Verified rather than assumed. */
    expect(root.attributes).toEqual({ id: '1' })
    expect(childElements(root).map((child) => child.name)).toEqual(['C', 'B'])
  })

  it('gives every node the position of its opening character', () => {
    const { root } = parseXml('<A>\n  <B>x</B>\n</A>')
    const b = firstChildElement(root, 'B')
    expect([root.line, root.column]).toEqual([1, 1])
    expect([b?.line, b?.column]).toEqual([2, 3])
  })

  it('reads a self-closing element as an element with no children', () => {
    const { root } = parseXml('<A><B/></A>')
    expect(firstChildElement(root, 'B')?.children).toEqual([])
  })

  it('reports a byte order mark and still reads the document', () => {
    const document = parseXml(`${BOM}<A>x</A>`)
    expect(document.hadByteOrderMark).toBe(true)
    expect(textOf(document.root)).toBe('x')
    expect(parseXml('<A>x</A>').hadByteOrderMark).toBe(false)
  })

  it('carries the declaration through, and leaves it out when there was none', () => {
    expect(parseXml('<?xml version="1.0" encoding="UTF-8"?><A/>').declaration).toEqual({
      version: '1.0',
      encoding: 'UTF-8',
      standalone: undefined,
      line: 1,
      column: 1,
    })
    expect(parseXml('<A/>').declaration).toBeUndefined()
  })

  it('drops comments and processing instructions from the tree', () => {
    const { root } = parseXml('<A><!--c--><?p d?><B/></A>')
    expect(root.children.map((child) => child.kind)).toEqual(['element'])
  })

  it('refuses a document with no element in it, at the end of the file', () => {
    const error = thrown('<!-- only a comment -->\n')
    expect(error.code).toBe('XML_NO_ROOT')
    expect(error.line).toBe(2)
    expect(thrown('').code).toBe('XML_NO_ROOT')
  })

  it('collects issues and forwards them to a caller who asked', () => {
    const seen: XmlIssue[] = []
    const document = parseXml('<?xml version="1.0" encoding="UTF-16"?><A/>', {
      onIssue: (issue) => seen.push(issue),
    })
    expect(document.issues.map((issue) => issue.code)).toEqual(['ENCODING_UNVERIFIED'])
    expect(seen).toEqual(document.issues)
  })

  it('reports no issues for an ordinary document', () => {
    expect(parseXml('<A>x</A>').issues).toEqual([])
  })
})

describe('parseXml — text nodes', () => {
  it('coalesces text that a comment split, because a comment is not a separator', () => {
    const { root } = parseXml('<A>one<!--x-->two</A>')
    expect(root.children).toHaveLength(1)
    expect(textOf(root)).toBe('onetwo')
  })

  it('coalesces text and CDATA into one node with no trace of which was which', () => {
    /* CDATA is TRANSPORT, NOT MEANING — the same decision csv/parse.ts makes about quoting.
     * The same narration exported by two tools differs in whether it is wrapped, and in
     * nothing else, so a caller must not be able to tell. */
    const { root } = parseXml('<A>one<![CDATA[two]]>three</A>')
    expect(root.children).toHaveLength(1)
    expect(textOf(root)).toBe('onetwothree')
    expect(textOf(parseXml('<A>onetwothree</A>').root)).toBe(textOf(root))
  })

  it('does NOT merge text across an element — the other half of the merge condition', () => {
    /* `last.kind === 'text'` alone excludes this. Without it the text after `<B/>` would be
     * appended to the text before it and the element would lose its place in the run. */
    const { root } = parseXml('<A>one<B/>two</A>')
    expect(root.children.map((child) => child.kind)).toEqual(['text', 'element', 'text'])
  })

  it('starts a fresh run when there is no previous child at all', () => {
    const { root } = parseXml('<A>one</A>')
    expect(root.children).toHaveLength(1)
    expect(root.children[0]?.kind).toBe('text')
  })

  it('keeps the position of where a coalesced run STARTED', () => {
    const { root } = parseXml('<A>\none<!--x-->two</A>')
    const first = root.children[0]
    expect(first?.kind === 'text' ? [first.line, first.column] : undefined).toEqual([1, 4])
  })

  it('is whitespace only when BOTH halves of a merge are', () => {
    const spaced = parseXml('<A> <!--x--> </A>').root.children[0]
    expect(spaced?.kind === 'text' ? spaced.isWhitespace : undefined).toBe(true)
    const mixed = parseXml('<A> <!--x-->y</A>').root.children[0]
    expect(mixed?.kind === 'text' ? mixed.isWhitespace : undefined).toBe(false)
  })

  it('caps the COALESCED length as well as each run, which the scanner cannot', () => {
    /* Each run is one character and comfortably under the cap; together they are not.
     * `a<!--x-->a<!--x-->a...` is how a million-character node is built out of runs that
     * every per-run check waves through. */
    const built = `<A>${'a<!--x-->'.repeat(10)}a</A>`
    const error = thrown(built, { maxTextLength: 5 })
    expect(error.code).toBe('XML_TEXT_TOO_LONG')
    expect(error.line).toBe(1)
    expect(error.column).toBe(4)
    expect(textOf(parseXml(built, { maxTextLength: 11 }).root)).toBe('a'.repeat(11))
  })

  it('drops whitespace between the declaration and the root, which belongs to no element', () => {
    const { root } = parseXml('<?xml version="1.0"?>\n<A>x</A>\n')
    expect(root.children).toHaveLength(1)
    expect(textOf(root)).toBe('x')
  })
})

describe('the whitespace decision: the parser trims nothing', () => {
  it('keeps indentation and internal spacing exactly as written', () => {
    const { root } = parseXml('<A>\n   Two  inner  spaces\n  </A>')
    expect(textOf(root)).toBe('\n   Two  inner  spaces\n  ')
  })

  it('makes the two spellings of one narration DIFFERENT, which is why nothing is trimmed', () => {
    /* The parser cannot tell layout from content. Trimming is right for the padded form and
     * a no-op for the tight one; collapsing the middle destroys the spacing in both. */
    const padded = textOf(parseXml('<N>\n  Freight   charges\n</N>').root)
    const tight = textOf(parseXml('<N>Freight   charges</N>').root)
    expect(padded).not.toBe(tight)
    expect(collapseXmlSpace(padded)).toBe('Freight charges')
    expect(collapseXmlSpace(padded)).toBe(collapseXmlSpace(tight))
  })

  it('flags a layout-only run so a caller can skip it without touching a value', () => {
    const { root } = parseXml('<A>\n  <B>x</B>\n</A>')
    const kept = root.children.filter((child) => child.kind === 'element' || !child.isWhitespace)
    expect(kept.map((child) => (child.kind === 'element' ? child.name : child.text))).toEqual(['B'])
  })

  it('normalises line endings, so a Windows re-export is the same string', () => {
    expect(textOf(parseXml('<A>one\r\ntwo</A>').root)).toBe(
      textOf(parseXml('<A>one\ntwo</A>').root),
    )
  })
})

describe('accessors', () => {
  const { root } = parseXml(
    '<V><AMOUNT>10</AMOUNT>text<AMOUNT>20</AMOUNT><NARRATION x="">n</NARRATION></V>',
  )

  it('returns EVERY matching child, so a caller can tell one from the first of two', () => {
    /* CONVENTIONS §6: `.find` silently implements "whichever is listed first". A rule that
     * says "the one AMOUNT" needs the count, and this document has two. */
    expect(childElements(root, 'AMOUNT').map((child) => textOf(child))).toEqual(['10', '20'])
    expect(childElements(root, 'AMOUNT')).toHaveLength(2)
  })

  it('returns every child element when no name is given, and no text nodes', () => {
    expect(childElements(root).map((child) => child.name)).toEqual([
      'AMOUNT',
      'AMOUNT',
      'NARRATION',
    ])
  })

  it('returns the FIRST match from firstChildElement, and says so in its name', () => {
    expect(textOf(firstChildElement(root, 'AMOUNT') ?? root)).toBe('10')
    expect(firstChildElement(root, 'MISSING')).toBeUndefined()
  })

  it('tells an empty attribute from an absent one', () => {
    const narration = firstChildElement(root, 'NARRATION')
    expect(narration === undefined ? undefined : attributeOf(narration, 'x')).toBe('')
    expect(narration === undefined ? undefined : attributeOf(narration, 'y')).toBeUndefined()
  })

  it('does not answer for an inherited key', () => {
    const plain = parseXml('<A/>').root
    expect(attributeOf(plain, 'constructor')).toBeUndefined()
    expect(attributeOf(plain, '__proto__')).toBeUndefined()
    expect(attributeOf(parseXml('<A __proto__="v"/>').root, '__proto__')).toBe('v')
  })

  it('concatenates every descendant text in document order', () => {
    expect(textOf(parseXml('<A>a<B>b<C>c</C>d</B>e</A>').root)).toBe('abcde')
  })

  it('walks deeply without recursing', () => {
    const depth = 200
    const deep = `${'<a>'.repeat(depth)}bottom${'</a>'.repeat(depth)}`
    expect(textOf(parseXml(deep).root)).toBe('bottom')
  })

  it('narrows a node with the guards', () => {
    const first = parseXml('<A>t<B/></A>').root.children
    expect(first.map((node) => [isElement(node), isText(node)])).toEqual([
      [false, true],
      [true, false],
    ])
  })
})

describe('findElements', () => {
  it('finds every element with a name, at any depth, in document order', () => {
    const { root } = parseXml('<E><M id="3"/><B><M id="1"/></B><M id="2"/></E>')
    expect(findElements(root, 'M').map((element) => element.attributes['id'])).toEqual([
      '3',
      '1',
      '2',
    ])
  })

  it('includes the root itself when it matches', () => {
    expect(findElements(parseXml('<M><M/></M>').root, 'M')).toHaveLength(2)
  })

  it('returns nothing for a name that is not there', () => {
    expect(findElements(parseXml('<A/>').root, 'B')).toEqual([])
  })
})

describe('readXmlSubtrees — walking one element at a time', () => {
  /* Ids run 3, 1, 2 and the kinds interleave, so a walk that sorted or grouped on the way
   * through would disagree with this list. */
  const text = '<E><B><M id="3"><V>c</V></M><L id="1"/><M id="2"><V>a</V></M></B></E>'

  it('yields the matches in document order, with a 1-based ordinal and the path', () => {
    const found = [...readXmlSubtrees(text, ({ name }) => name === 'M')]
    expect(
      found.map((subtree) => [
        subtree.ordinal,
        subtree.element.attributes['id'],
        textOf(subtree.element),
      ]),
    ).toEqual([
      [1, '3', 'c'],
      [2, '2', 'a'],
    ])
    expect(found[0]?.path).toEqual(['E', 'B'])
  })

  it('tells the predicate the name, the depth and the ancestors', () => {
    const seen: [string, number, readonly string[]][] = []
    const matched = [
      ...readXmlSubtrees(text, (context) => {
        seen.push([context.name, context.depth, context.path])
        return false
      }),
    ]
    expect(matched).toEqual([])
    expect(seen).toEqual([
      ['E', 1, []],
      ['B', 2, ['E']],
      ['M', 3, ['E', 'B']],
      ['V', 4, ['E', 'B', 'M']],
      ['L', 3, ['E', 'B']],
      ['M', 3, ['E', 'B']],
      ['V', 4, ['E', 'B', 'M']],
    ])
  })

  it('lets a predicate select on depth alone, with no tag name anywhere', () => {
    const found = [...readXmlSubtrees(text, ({ depth }) => depth === 3)]
    expect(found.map((subtree) => subtree.element.name)).toEqual(['M', 'L', 'M'])
  })

  it('does not yield a match that is INSIDE a match', () => {
    /* The caller already has the inner one: it is in the element they were handed. Yielding
     * it again would post the same voucher twice. */
    const nested = [...readXmlSubtrees('<E><M><M/></M><M/></E>', ({ name }) => name === 'M')]
    expect(nested).toHaveLength(2)
    expect(childElements(nested[0]?.element ?? parseXml('<x/>').root, 'M')).toHaveLength(1)
  })

  it('yields a self-closing match as an element with no children', () => {
    const found = [...readXmlSubtrees('<E><M/></E>', ({ name }) => name === 'M')]
    expect(found).toHaveLength(1)
    expect(found[0]?.element.children).toEqual([])
  })

  it('keeps the ancestor path balanced across matched and unmatched elements', () => {
    const found = [
      ...readXmlSubtrees('<E><B><M/></B><M/><B><M/></B></E>', ({ name }) => name === 'M'),
    ]
    expect(found.map((subtree) => subtree.path)).toEqual([['E', 'B'], ['E'], ['E', 'B']])
  })

  it('yields nothing when the predicate matches nothing, and still checks the document', () => {
    expect([...readXmlSubtrees('<E><M/></E>', () => false)]).toEqual([])
    expect(() => [...readXmlSubtrees('<E><M/>', () => false)]).toThrow(XmlError)
  })

  it('matches the root itself', () => {
    const found = [...readXmlSubtrees('<E><M/></E>', ({ depth }) => depth === 1)]
    expect(found).toHaveLength(1)
    expect(found[0]?.element.name).toBe('E')
    expect(found[0]?.path).toEqual([])
  })

  it('refuses mid-walk on a truncated file, AFTER handing over what it had read', () => {
    /* Deliberate. The alternative is importing the first half of a broken export and
     * telling nobody. */
    const walked: string[] = []
    let code = ''
    try {
      for (const subtree of readXmlSubtrees('<E><M>a</M><M>b</M><M>', ({ name }) => name === 'M')) {
        walked.push(textOf(subtree.element))
      }
    } catch (error) {
      code = error instanceof XmlError ? error.code : String(error)
    }
    expect(walked).toEqual(['a', 'b'])
    expect(code).toBe('XML_UNCLOSED_ELEMENT')
  })

  it('walks a large document without building a tree of it', () => {
    /* The claim is that memory is one subtree. What is asserted here is the observable
     * half: every message is seen, in order, from a document far larger than the tree of it
     * would be comfortable. */
    const message = '<M><V>x</V><W>y</W></M>'
    const large = `<E>${message.repeat(20_000)}</E>`
    let count = 0
    let lastText = ''
    for (const subtree of readXmlSubtrees(large, ({ name }) => name === 'M')) {
      count += 1
      lastText = textOf(subtree.element)
      expect(subtree.ordinal).toBe(count)
    }
    expect(count).toBe(20_000)
    expect(lastText).toBe('xy')
  })

  it('carries the caps through to the scanner', () => {
    expect(() => [...readXmlSubtrees('<E><M/></E>', () => false, { maxDepth: 1 })]).toThrowError(
      /nested 2 deep/,
    )
    expect(() => [...readXmlSubtrees('<E/>', () => false, { maxDepth: 0 })]).toThrowError(
      /at least 1/,
    )
  })
})
