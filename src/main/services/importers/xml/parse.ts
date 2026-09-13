/*
 * Two ways to read a document, over one scanner.
 *
 *   parseXml          the whole thing as a tree. For a file you can hold in memory.
 *   readXmlSubtrees   one matching subtree at a time. For a file you cannot.
 *
 * WHY BOTH, AND WHY THE SECOND ONE IS THE INTERESTING ONE. The export this reader was
 * built for is a long, shallow repetition: an outer envelope, and inside it some tens of
 * thousands of message elements that each hold one voucher or one ledger. A caller wants
 * those one at a time - validate it, post it, forget it - and never wants the whole file
 * as objects, because the tree for a hundred-megabyte export is several times its size.
 * `readXmlSubtrees` builds exactly one subtree at a time, hands it over, and drops it.
 *
 * THE MATCH IS A PREDICATE THE CALLER SUPPLIES, and no tag name appears anywhere in this
 * folder. Which element is a message, and which of its children is a voucher, is a fact
 * about one exporter's format; it belongs to the module that understands that format, and
 * putting it here would make the XML reader wrong for the second exporter that arrives.
 *
 *   for (const { element } of readXmlSubtrees(text, ({ name, path }) =>
 *     name === 'MESSAGE' && path[0] === 'ENVELOPE')) { ... }
 *
 * A MATCH INSIDE A MATCH IS NOT YIELDED AGAIN. Once a subtree is being built, the
 * predicate is not asked about anything inside it: it is already in the element the caller
 * was handed. Otherwise a caller matching on a name that nests would get the outer element
 * and then the inner one again, and would post the same voucher twice.
 *
 * ---------------------------------------------------------------------------
 * WHITESPACE: THE PARSER TRIMS NOTHING, EVER.
 *
 * Tally pads its exports, so `<NARRATION>` arrives surrounded by newlines and indentation
 * and the temptation to trim on the way out is strong. It is wrong, and not marginally:
 * THE PARSER CANNOT TELL LAYOUT FROM CONTENT. These two are the same document to XML,
 *
 *     <NARRATION>Freight   charges</NARRATION>
 *     <NARRATION>
 *       Freight   charges
 *     </NARRATION>
 *
 * and both hold the run of three spaces the person who typed them meant. Trimming the ends
 * is right for the second and a no-op for the first; collapsing the middle destroys both.
 * A parser that trimmed would be making a per-field decision - identifier or prose - with
 * none of the information needed to make it.
 *
 * So: text arrives exactly as written, and TWO tools are offered instead.
 *   `isWhitespace` on a text node says the run is nothing but layout, so a caller walking
 *      children can skip an exporter's indentation without touching any real value.
 *   `collapseXmlSpace` (text.ts) is applied BY THE CALLER, per field. A ledger name is an
 *      identifier and wants it; a narration is prose and must not have it.
 *
 * The one thing that IS normalised is line endings, because XML 1.0 §2.11 requires it and
 * because it is the same argument `csv/parse.ts` makes: a line ending is transport. The
 * same narration exported on Windows and on Linux has to produce the same string, or every
 * row of a re-import looks new.
 * ---------------------------------------------------------------------------
 */

import { XmlError, xmlErrorAt, type XmlIssue } from './errors'
import { childElements, type XmlElement, type XmlNode } from './nodes'
import {
  scanXml,
  XML_DEFAULTS,
  type XmlDeclaration,
  type XmlEvent,
  type XmlOpenEvent,
  type XmlScanOptions,
  type XmlTextEvent,
} from './scan'
import { positionAt, stripByteOrderMark } from './text'

export type XmlParseOptions = XmlScanOptions

/** A document that parsed: its root, what it said about itself, and what was noticed. */
export interface XmlDocument {
  readonly root: XmlElement
  /** The `<?xml ... ?>`, when the file had one. */
  readonly declaration?: XmlDeclaration
  /** True when the text began with U+FEFF. Worth surfacing: it explains a lot. */
  readonly hadByteOrderMark: boolean
  /** Warnings. A document that produced no data was refused, not reported — see errors.ts. */
  readonly issues: readonly XmlIssue[]
}

/**
 * Read a whole document into a tree.
 *
 * @throws XmlError for anything malformed, for a `<!DOCTYPE`, or for a cap exceeded. Every
 *   one carries a line and a column.
 */
export function parseXml(text: string, options: XmlParseOptions = {}): XmlDocument {
  const { text: body, hadByteOrderMark } = stripByteOrderMark(text)
  const maxTextLength = options.maxTextLength ?? XML_DEFAULTS.maxTextLength

  const issues: XmlIssue[] = []
  const forward = options.onIssue
  const collect = (issue: XmlIssue): void => {
    issues.push(issue)
    if (forward !== undefined) {
      forward(issue)
    }
  }

  const stack: DraftElement[] = []
  let root: XmlElement | undefined
  let declaration: XmlDeclaration | undefined

  for (const event of scanXml(body, { ...options, onIssue: collect })) {
    if (event.kind === 'declaration') {
      declaration = {
        version: event.version,
        encoding: event.encoding,
        standalone: event.standalone,
        line: event.line,
        column: event.column,
      }
      continue
    }
    const finished = applyEvent(stack, event, maxTextLength)
    if (finished !== undefined) {
      root = finished
    }
  }

  if (root === undefined) {
    throw xmlErrorAt(
      'XML_NO_ROOT',
      positionAt(body, body.length),
      'This file has no XML element in it. An XML document has exactly one outermost ' +
        'element, and Coffer reached the end of this file without finding one.',
    )
  }

  return declaration === undefined
    ? { root, hadByteOrderMark, issues }
    : { root, declaration, hadByteOrderMark, issues }
}

/** What the predicate is told about an element that has just opened. */
export interface XmlSubtreeContext {
  readonly name: string
  /** 1 for the outermost element. */
  readonly depth: number
  /** The names of its ancestors, outermost first. Does NOT include this element. */
  readonly path: readonly string[]
}

/** One matched subtree, complete, with where it sat. */
export interface XmlSubtree {
  readonly element: XmlElement
  /** The names of its ancestors, outermost first. */
  readonly path: readonly string[]
  /**
   * 1-based position among the subtrees yielded so far.
   *
   * 1-based because it exists to go into a message — "voucher 412 could not be posted" —
   * and the person reading that counts from one, the same reason `csv`'s `ImportIssue`
   * carries a `rowNumber` beside its `line`.
   */
  readonly ordinal: number
}

/**
 * Walk a document, yielding each subtree the predicate matches, one at a time.
 *
 * Holds one subtree and a list of ancestor names, never the whole document. The
 * enclosing structure is still fully checked as it is walked: a mismatched tag or an
 * unclosed element after the last match still refuses the file, so a truncated export
 * cannot be half-imported silently.
 *
 * @throws XmlError, exactly as `parseXml` does, at the point in the walk it is reached —
 *   which means a caller that has already been handed subtrees can still see the import
 *   fail. That is deliberate; the alternative is importing the first half of a broken file.
 */
export function* readXmlSubtrees(
  text: string,
  matches: (context: XmlSubtreeContext) => boolean,
  options: XmlParseOptions = {},
): Generator<XmlSubtree, void, undefined> {
  const { text: body } = stripByteOrderMark(text)
  const maxTextLength = options.maxTextLength ?? XML_DEFAULTS.maxTextLength

  const path: string[] = []
  let capture: DraftElement[] | undefined
  let capturePath: readonly string[] = []
  let ordinal = 0

  for (const event of scanXml(body, options)) {
    if (capture !== undefined) {
      const finished = applyEvent(capture, event, maxTextLength)
      if (finished !== undefined) {
        ordinal += 1
        yield { element: finished, path: capturePath, ordinal }
        capture = undefined
      }
      continue
    }

    if (event.kind === 'open') {
      const context: XmlSubtreeContext = {
        name: event.name,
        depth: path.length + 1,
        path: [...path],
      }
      if (matches(context)) {
        capture = [draftOf(event)]
        capturePath = context.path
      } else {
        path.push(event.name)
      }
      continue
    }

    if (event.kind === 'close') {
      /* Only reached for an element that was NOT matched: a matched one's close is
       * consumed by the capture above, which is what keeps `path` balanced. */
      path.pop()
    }
  }
}

/**
 * Every element under `root` with this name, at any depth, in document order.
 *
 * A convenience for the tree API, and deliberately NOT the streaming one: it holds every
 * match at once. Where the document is large, `readXmlSubtrees` is the function.
 */
export function findElements(root: XmlElement, name: string): readonly XmlElement[] {
  const found: XmlElement[] = []
  const stack: XmlElement[] = [root]
  while (stack.length > 0) {
    const element = stack.pop()
    if (element === undefined) {
      break
    }
    if (element.name === name) {
      found.push(element)
    }
    const children = childElements(element)
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]
      if (child !== undefined) {
        stack.push(child)
      }
    }
  }
  return found
}

// ---- Internals ------------------------------------------------------------

/*
 * An element under construction.
 *
 * Structurally an `XmlElement` with a mutable child list, which TypeScript accepts as one
 * without a cast: a `XmlNode[]` is assignable to a `readonly XmlNode[]`. So a draft can be
 * pushed straight into its parent's children and becomes read-only at that boundary, with
 * no copy and no assertion.
 */
interface DraftElement {
  readonly kind: 'element'
  readonly name: string
  readonly attributes: Readonly<Record<string, string>>
  readonly children: XmlNode[]
  readonly line: number
  readonly column: number
}

function draftOf(event: XmlOpenEvent): DraftElement {
  return {
    kind: 'element',
    name: event.name,
    attributes: event.attributes,
    children: [],
    line: event.line,
    column: event.column,
  }
}

/**
 * Apply one event to a stack of drafts. Returns the element that COMPLETED the stack.
 *
 * One function rather than a switch in each of the two readers, so there is one answer to
 * how text coalesces and one place for it to be wrong. The switch is exhaustive over
 * `XmlEvent` with no `default`: adding an event kind stops this compiling, because
 * `noImplicitReturns` then sees a path with no return.
 */
function applyEvent(
  stack: DraftElement[],
  event: XmlEvent,
  maxTextLength: number,
): XmlElement | undefined {
  switch (event.kind) {
    case 'open':
      stack.push(draftOf(event))
      return undefined
    case 'close': {
      const finished = stack.pop()
      if (finished === undefined) {
        /* Not a user error: `scanXml` refuses an unbalanced document itself, so reaching
         * here means the scanner and this loop disagree. CONVENTIONS §5 — throw. */
        throw new Error('scanXml closed an element it had not opened')
      }
      const parent = stack[stack.length - 1]
      if (parent === undefined) {
        return finished
      }
      parent.children.push(finished)
      return undefined
    }
    case 'text': {
      const parent = stack[stack.length - 1]
      if (parent !== undefined) {
        appendText(parent, event, maxTextLength)
      }
      /* No parent means text outside the root, which the scanner has already refused
       * unless it is whitespace. Whitespace between the declaration and the root is not
       * part of any element and is dropped here. */
      return undefined
    }
    case 'declaration':
    case 'comment':
    case 'instruction':
      return undefined
  }
}

/*
 * Coalescing, and the second place the text cap has to be applied.
 *
 * `scanXml` caps one RUN of text, which bounds one allocation. It does not bound this:
 * `a<!--x-->a<!--x-->a...` is a million runs of one character each, every one of them
 * comfortably under the cap, that coalesce into a single million-character node. So the
 * merged length is checked here as well, against the same limit, and reported at the
 * position the run STARTED - which is where a reader has to go to see what happened.
 */
function appendText(parent: DraftElement, event: XmlTextEvent, maxTextLength: number): void {
  const last = parent.children[parent.children.length - 1]
  if (last !== undefined && last.kind === 'text') {
    const merged = last.text + event.text
    if (merged.length > maxTextLength) {
      throw new XmlError(
        'XML_TEXT_TOO_LONG',
        `Line ${String(last.line)}, column ${String(last.column)}: the text of ` +
          `<${parent.name}> reaches ${String(merged.length)} characters, which is more than ` +
          `the ${String(maxTextLength)} Coffer reads at once.`,
        { line: last.line, column: last.column },
      )
    }
    parent.children[parent.children.length - 1] = {
      kind: 'text',
      text: merged,
      /* Both halves have to be whitespace for the whole to be. */
      isWhitespace: last.isWhitespace && event.isWhitespace,
      line: last.line,
      column: last.column,
    }
    return
  }
  parent.children.push({
    kind: 'text',
    text: event.text,
    isWhitespace: event.isWhitespace,
    line: event.line,
    column: event.column,
  })
}
