/*
 * The golden fixtures, run end to end: text -> events -> a tree, and text -> subtrees.
 *
 * The per-module tests beside this one can each pass while the joins between them are
 * wrong. A scanner that emitted a byte order mark as part of the first tag name is correct
 * by every test in `text.test.ts`, and every test of `readXmlName` still passes.
 *
 * The refusal table is here rather than inline for a second reason: "an import failure says
 * WHERE" is a promise about the whole module, and one table somebody can read is the only
 * form in which it can be checked at a glance. The line and column in each row were read
 * off a running parser, not reasoned out.
 */

import { describe, expect, it } from 'vitest'

import { XmlError } from './errors'
import { attributeOf, childElements, firstChildElement, textOf, type XmlElement } from './nodes'
import { findElements, parseXml, readXmlSubtrees } from './parse'
import { scanXml } from './scan'
import { collapseXmlSpace } from './text'

import fixture from './__fixtures__/documents.json'

interface RefusalCase {
  name: string
  xml: string
  code: string
  line: number
  column: number
}

const golden = fixture as unknown as {
  why: string
  documents: Record<string, { why: string; xml: string; expected: unknown }>
  refusals: { why: string; cases: RefusalCase[] }
}

const document = (name: string): { xml: string; expected: unknown } => {
  const found = golden.documents[name]
  if (found === undefined) {
    throw new Error(`No fixture called ${name}`)
  }
  return found
}

/** The text of each named child, which is how a caller reads a flat record element. */
const fieldsOf = (element: XmlElement): Record<string, string> => {
  const fields: Record<string, string> = {}
  for (const child of childElements(element)) {
    fields[child.name] = textOf(child)
  }
  return fields
}

describe('tallyLike — an envelope of repeated messages, walked one at a time', () => {
  const { xml, expected } = document('tallyLike')
  const rows = expected as {
    ordinal: number
    path: string[]
    child: string
    attributes: Record<string, string>
    fields: Record<string, string>
    collapsedNarration: string | null
  }[]

  const walk = (): { subtree: { ordinal: number; path: readonly string[] }; child: XmlElement }[] =>
    [...readXmlSubtrees(xml, ({ name, path }) => name === 'TALLYMESSAGE' && path.length === 4)].map(
      (subtree) => {
        const child = childElements(subtree.element)[0]
        if (child === undefined) {
          throw new Error(`message ${String(subtree.ordinal)} has no child element`)
        }
        return { subtree, child }
      },
    )

  it('yields one subtree per message, in document order', () => {
    const walked = walk()
    expect(walked).toHaveLength(rows.length)
    expect(walked.map((entry) => entry.subtree.ordinal)).toEqual(rows.map((row) => row.ordinal))
    expect(walked.map((entry) => entry.child.name)).toEqual(rows.map((row) => row.child))
  })

  it('reads the path to each message the same way for all of them', () => {
    for (const entry of walk()) {
      expect(entry.subtree.path).toEqual(rows[entry.subtree.ordinal - 1]?.path)
    }
  })

  it('reads every attribute and every field of every message', () => {
    /* The rows, not a count and not a total. The messages are not in date order and not
     * grouped by kind, so a walk that sorted or grouped would produce the same count. */
    for (const entry of walk()) {
      const row = rows[entry.subtree.ordinal - 1]
      expect(entry.child.attributes, entry.child.name).toEqual(row?.attributes)
      expect(fieldsOf(entry.child), entry.child.name).toEqual(row?.fields)
    }
  })

  it('leaves a narration untrimmed and lets the caller collapse it', () => {
    for (const entry of walk()) {
      const row = rows[entry.subtree.ordinal - 1]
      const narration = firstChildElement(entry.child, 'NARRATION')
      if (row?.collapsedNarration == null) {
        expect(narration).toBeUndefined()
        continue
      }
      expect(textOf(narration ?? entry.child)).toBe(row.fields['NARRATION'])
      expect(collapseXmlSpace(textOf(narration ?? entry.child))).toBe(row.collapsedNarration)
    }
  })

  it('gives the same records through the tree as through the walk', () => {
    const { root } = parseXml(xml)
    const messages = findElements(root, 'TALLYMESSAGE')
    expect(messages).toHaveLength(rows.length)
    expect(
      messages.map((message) => {
        const child = childElements(message)[0]
        return child === undefined ? null : fieldsOf(child)
      }),
    ).toEqual(rows.map((row) => row.fields))
  })

  it('reports nothing about a UTF-8 file and finds no byte order mark', () => {
    const parsed = parseXml(xml)
    expect(parsed.issues).toEqual([])
    expect(parsed.hadByteOrderMark).toBe(false)
    expect(parsed.declaration?.encoding).toBe('UTF-8')
  })
})

describe('nasty — everything awkward in one file', () => {
  const { xml, expected } = document('nasty')
  const want = expected as {
    hadByteOrderMark: boolean
    declaration: { version: string; encoding: string }
    issues: { code: string; severity: string; value: string }[]
    rootName: string
    attributeOrder: string[]
    attributes: Record<string, string>
    brackets: string
    refs: string
    refsLength: number
    mixed: string
    spaced: string
    spacedCollapsed: string
    endings: string
    tabbedAttribute: string
    tabbedText: string
    split: string
    splitChildCount: number
    deepestName: string
    deepestDepth: number
    emptyChildren: number
    instruction: { target: string; data: string }
    commentText: string
  }

  const parsed = parseXml(xml)
  const textIn = (name: string): string => {
    const element = firstChildElement(parsed.root, name)
    if (element === undefined) {
      throw new Error(`no <${name}> in the nasty fixture`)
    }
    return textOf(element)
  }

  it('strips the byte order mark and still reads the declaration behind it', () => {
    expect(parsed.hadByteOrderMark).toBe(want.hadByteOrderMark)
    expect(parsed.declaration?.version).toBe(want.declaration.version)
    expect(parsed.declaration?.encoding).toBe(want.declaration.encoding)
  })

  it('warns about the encoding it cannot vouch for, and reads the file anyway', () => {
    expect(
      parsed.issues.map((issue) => ({
        code: issue.code,
        severity: issue.severity,
        value: issue.value,
      })),
    ).toEqual(want.issues)
  })

  it('keeps attributes in document order, each in the other quote style', () => {
    expect(parsed.root.name).toBe(want.rootName)
    expect(Object.keys(parsed.root.attributes)).toEqual(want.attributeOrder)
    expect(parsed.root.attributes).toEqual(want.attributes)
    expect(attributeOf(parsed.root, 'zeta')).toBe(want.attributes['zeta'])
  })

  it('carries a literal ]]> through a split CDATA section', () => {
    expect(textIn('BRACKETS')).toBe(want.brackets)
  })

  it('decodes decimal, hexadecimal, named and astral references', () => {
    const refs = textIn('REFS')
    expect(refs).toBe(want.refs)
    expect(refs.length).toBe(want.refsLength)
  })

  it('reads mixed content whole', () => {
    expect(textIn('MIXED')).toBe(want.mixed)
  })

  it('leaves internal spacing alone and lets the caller collapse it', () => {
    expect(textIn('SPACED')).toBe(want.spaced)
    expect(collapseXmlSpace(textIn('SPACED'))).toBe(want.spacedCollapsed)
  })

  it('folds literal line endings and keeps a referenced carriage return', () => {
    expect(textIn('ENDINGS')).toBe(want.endings)
  })

  it('replaces a literal tab in an attribute and keeps one in text', () => {
    const tabbed = firstChildElement(parsed.root, 'TABBED')
    expect(tabbed === undefined ? undefined : attributeOf(tabbed, 'note')).toBe(
      want.tabbedAttribute,
    )
    expect(textIn('TABBED')).toBe(want.tabbedText)
  })

  it('coalesces text split by a comment and a CDATA section into one node', () => {
    const split = firstChildElement(parsed.root, 'SPLIT')
    expect(split?.children).toHaveLength(want.splitChildCount)
    expect(textIn('SPLIT')).toBe(want.split)
  })

  it('reads the deep branch to the bottom', () => {
    const deepest = [...readXmlSubtrees(xml, ({ name }) => name === want.deepestName)]
    expect(deepest).toHaveLength(1)
    expect((deepest[0]?.path.length ?? 0) + 1).toBe(want.deepestDepth)
    expect(textOf(deepest[0]?.element ?? parsed.root)).toBe('bottom')
  })

  it('reads a self-closing element as empty', () => {
    expect(firstChildElement(parsed.root, 'EMPTY')?.children).toHaveLength(want.emptyChildren)
  })

  it('keeps a processing instruction and a double-hyphen comment in the event stream', () => {
    const stream = [...scanXml(xml)]
    const instruction = stream.find((event) => event.kind === 'instruction')
    expect(instruction?.kind === 'instruction' ? instruction.target : undefined).toBe(
      want.instruction.target,
    )
    expect(instruction?.kind === 'instruction' ? instruction.data : undefined).toBe(
      want.instruction.data,
    )
    const comment = stream.find((event) => event.kind === 'comment')
    expect(comment?.kind === 'comment' ? comment.text : undefined).toBe(want.commentText)
  })

  it('drops both of them from the tree', () => {
    expect(
      parsed.root.children.filter((child) => child.kind === 'element').map((child) => child.name),
    ).toEqual([
      'BRACKETS',
      'REFS',
      'MIXED',
      'SPACED',
      'ENDINGS',
      'TABBED',
      'SPLIT',
      'DEEP',
      'EMPTY',
    ])
  })
})

describe('refusals — every named error, and where it says the problem is', () => {
  const cases = golden.refusals.cases

  it('has a case for every one it claims to cover', () => {
    expect(cases.length).toBeGreaterThan(20)
    expect(new Set(cases.map((row) => row.code)).size).toBeGreaterThan(15)
  })

  it.each(cases.map((row): [string, RefusalCase] => [row.name, row]))('%s', (_name, row) => {
    let error: XmlError | undefined
    try {
      parseXml(row.xml)
    } catch (caught) {
      error = caught instanceof XmlError ? caught : undefined
    }
    expect(error?.code).toBe(row.code)
    expect(error?.line).toBe(row.line)
    expect(error?.column).toBe(row.column)
    expect(error?.message).toContain(`Line ${String(row.line)}, column ${String(row.column)}`)
  })

  it('refuses the same documents through the streaming reader, at the same place', () => {
    /* Both readers go through one scanner. If they ever stop agreeing, one of them is
     * recovering from something the other refuses, which is the failure that would let half
     * a broken export in. */
    for (const row of cases) {
      let code = ''
      let line = 0
      try {
        expect([...readXmlSubtrees(row.xml, () => false)], row.name).toEqual([])
      } catch (caught) {
        if (caught instanceof XmlError) {
          code = caught.code
          line = caught.line ?? 0
        }
      }
      /* XML_NO_ROOT is parseXml's alone: a walk that matched nothing has nothing to say
       * about a document that held nothing. */
      if (row.code === 'XML_NO_ROOT') {
        expect(code, row.name).toBe('')
        continue
      }
      expect(code, row.name).toBe(row.code)
      expect(line, row.name).toBe(row.line)
    }
  })
})
