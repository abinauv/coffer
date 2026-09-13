/*
 * The document tree, and the handful of accessors that stop every caller writing its own.
 *
 * TWO KINDS OF NODE AND NO MORE: an element and a run of text. Comments and processing
 * instructions are read, checked for well-formedness and then DROPPED, because nothing in
 * a set of books is written in a comment and a tree that carries them makes every child
 * walk in every caller filter them out first. `scanXml` still yields them, so a caller who
 * genuinely wants them can have them.
 *
 * `firstChildElement` IS NAMED FOR WHAT IT DOES. CONVENTIONS §6 records that `.find`
 * cannot tell "the one X" from "the first of two", and that a rule written with it
 * silently becomes document order. So the function that returns one child says `first` in
 * its name, and a caller that means "the one AMOUNT" is expected to use `childElements`
 * and count - which is why that one returns every match rather than stopping.
 */

/** An element: a name, its attributes, and its children in document order. */
export interface XmlElement {
  readonly kind: 'element'
  readonly name: string
  /** Values by attribute name, decoded. Backed by a null-prototype object — see `scan.ts`. */
  readonly attributes: Readonly<Record<string, string>>
  readonly children: readonly XmlNode[]
  /** 1-based line of the element's opening `<`. */
  readonly line: number
  /** 1-based column of the element's opening `<`, in UTF-16 units. */
  readonly column: number
}

/**
 * A run of text.
 *
 * Adjacent runs are coalesced, so `a<![CDATA[b]]>c` is ONE node holding `abc`, and there
 * is no flag saying which characters came out of the CDATA section. That is the same
 * decision `csv/parse.ts` makes about quotation marks and for the same reason: CDATA is
 * TRANSPORT, NOT MEANING. The same narration exported by two tools differs in whether it
 * is wrapped in CDATA and in nothing else, so a caller that could see the difference would
 * be able to write a rule that changes answer between two exports of one voucher.
 */
export interface XmlText {
  readonly kind: 'text'
  readonly text: string
  /** True when the run is nothing but XML whitespace. See the note in `parse.ts`. */
  readonly isWhitespace: boolean
  readonly line: number
  readonly column: number
}

export type XmlNode = XmlElement | XmlText

/** True when the node is an element. */
export function isElement(node: XmlNode): node is XmlElement {
  return node.kind === 'element'
}

/** True when the node is a run of text. */
export function isText(node: XmlNode): node is XmlText {
  return node.kind === 'text'
}

/**
 * Every direct child element, in document order; optionally only those with a given name.
 *
 * Returns all of them, never the first. A caller enforcing "exactly one AMOUNT" needs the
 * count to say so.
 */
export function childElements(element: XmlElement, name?: string): readonly XmlElement[] {
  const found: XmlElement[] = []
  for (const child of element.children) {
    if (child.kind === 'element' && (name === undefined || child.name === name)) {
      found.push(child)
    }
  }
  return found
}

/**
 * The FIRST direct child element with this name, or `undefined`.
 *
 * Named `first` on purpose. Where the rule is "the one X", this is the wrong function.
 */
export function firstChildElement(element: XmlElement, name: string): XmlElement | undefined {
  for (const child of element.children) {
    if (child.kind === 'element' && child.name === name) {
      return child
    }
  }
  return undefined
}

/**
 * The value of an attribute, or `undefined`.
 *
 * Goes through `hasOwnProperty` rather than a truthiness test so that an attribute whose
 * value is the empty string is present and empty, not absent — the `""` distinction
 * `csv/parse.ts` argues out at length. `written=""` is a fact a Tally export states.
 */
export function attributeOf(element: XmlElement, name: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(element.attributes, name)) {
    return undefined
  }
  return element.attributes[name]
}

/**
 * All of the text under an element, in document order, concatenated.
 *
 * Includes the text of descendants, so mixed content comes back whole. NOTHING IS
 * TRIMMED: compose with `collapseXmlSpace` per field where that is right, and see the
 * whitespace note in `parse.ts` for where it is not.
 *
 * Iterative, not recursive. A document nested to `maxDepth` is nested to `maxDepth` here
 * too, and a stack overflow in an accessor would be a strange way to fail an import.
 */
export function textOf(element: XmlElement): string {
  let collected = ''
  const stack: XmlNode[] = [element]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) {
      break
    }
    if (node.kind === 'text') {
      collected += node.text
      continue
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index]
      if (child !== undefined) {
        stack.push(child)
      }
    }
  }
  return collected
}
