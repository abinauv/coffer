/*
 * An XML 1.0 scanner: text in, a stream of events out.
 *
 * NO DEPENDENCY, ON PURPOSE, AND THE PRECEDENT IS THE POINT. Node has no XML parser, and
 * adding a package is a decision this project takes one at a time. `companies/archive.ts`
 * hand-writes the part of ZIP a two-file backup uses; `csv/parse.ts` hand-writes RFC 4180
 * in two hundred lines. The part of XML that a Tally export uses is the same size, and the
 * same trade applies: no supply chain, and the failure modes are ours to name.
 *
 * IT IS ALSO A SECURITY DECISION, WHICH IS THE HALF THAT MATTERS MORE. A Tally export is a
 * file somebody downloads and hands to this parser, and the three well-known XML attacks
 * are all attacks on PARSER FEATURES:
 *
 *   NO DTD PROCESSING.        A `<!DOCTYPE` is refused outright, by name, with a line and a
 *                             column — not skipped, not ignored. Skipping one silently is
 *                             worse than refusing, because it invites the caller to assume
 *                             a doctype was understood and handled.
 *   NO EXTERNAL ENTITIES.     Nothing here resolves a SYSTEM or PUBLIC identifier, so there
 *                             is no code path that opens a file or a URL. XXE — reading
 *                             /etc/passwd or the user's key file into a ledger name — is
 *                             not mitigated here, it is absent.
 *   NO ENTITY EXPANSION.      Beyond the five XML itself defines, each of which expands to
 *                             exactly one character from a constant in `entities.ts`. A
 *                             document cannot declare an entity, so no entity can refer to
 *                             another, so billion-laughs has nothing to recurse on.
 *
 * These are properties of what is not implemented, not limits that have been tuned. The
 * only way to lose one is to add a feature.
 *
 * AND IT IS AN ALLOCATION SURFACE, in exactly the sense `csv/parse.ts` means it. Nesting
 * one element inside another ten million times is a ten-million-deep tree; one unclosed
 * quotation mark in an attribute turns the rest of the file into one value. So there are
 * four caps, they are on by default, and exceeding one is a refusal that says where. The
 * scanner itself is ITERATIVE — an explicit stack, no recursion anywhere — so a deep
 * document cannot overflow the JavaScript stack before a cap can be reached. `maxDepth`
 * protects the CALLER, whose walk of the tree may well recurse.
 *
 * WHAT "STREAMING-FRIENDLY" HONESTLY MEANS HERE. The caller hands over a string, so the
 * input is already in memory and there is nothing to stream on the way in — the file
 * reading, and with it the question of which paths a user can be talked into opening,
 * stays with the caller, once, at the file dialog. What this avoids is holding the OUTPUT:
 * `scanXml` is a generator that allocates one event at a time, and `readXmlSubtrees`
 * (parse.ts) builds one subtree, hands it over and forgets it. A hundred-megabyte export
 * of forty thousand vouchers is walked one voucher at a time.
 *
 * A SELF-CLOSING ELEMENT EMITS BOTH AN OPEN AND A CLOSE, at the same position, with
 * `isSelfClosing` set on the open. Every consumer of this stream tracks depth, and making
 * `<X/>` the one shape that does not balance means every consumer needs the special case
 * and one of them will not have it.
 */

import { decodeXmlReferences } from './entities'
import { requirePositiveInteger, xmlErrorAt, type XmlIssue } from './errors'
import {
  cursorAt,
  findForbiddenCharacter,
  isXmlWhitespace,
  isXmlWhitespaceOnly,
  positionAt,
  positionOf,
  readXmlName,
  REPLACEMENT_CHARACTER,
  seekTo,
  stripByteOrderMark,
  type XmlPosition,
} from './text'

/**
 * Defaults for every cap. Exported so a caller can see what it is opting out of.
 *
 * The numbers are sized on a real Tally export rather than on a round figure: a company
 * with forty thousand vouchers exports roughly a million elements, nested about eight
 * deep, with no single narration over a few hundred characters.
 */
export const XML_DEFAULTS = {
  /**
   * Nesting depth, root counted as 1.
   *
   * Tally nests about eight deep. 256 is far past anything an exporter produces and far
   * short of what a recursive walk in the caller would survive.
   */
  maxDepth: 256,
  /** Elements in one document. Two million is about eighty thousand vouchers. */
  maxElements: 2_000_000,
  /** One run of text. A megabyte in a single narration is an unclosed tag, not prose. */
  maxTextLength: 1_000_000,
  /** Attributes on one element. The analogue of csv's `maxFieldsPerRow`, and for the same
   * reason: an element with ten million attributes is one element and a ten-million-entry
   * object, so the element cap alone does not bound it. */
  maxAttributesPerElement: 256,
} as const

export interface XmlScanOptions {
  readonly maxDepth?: number
  readonly maxElements?: number
  readonly maxTextLength?: number
  readonly maxAttributesPerElement?: number
  /**
   * Called for each observation about a document that nonetheless parsed.
   *
   * A callback rather than a returned array because this is a generator: there is no
   * moment at which "the issues" are complete other than the end of the walk, and a
   * caller that stops early would silently get a partial list from a field it did not
   * know was partial. `parseXml` collects them for the callers that read to the end.
   */
  readonly onIssue?: (issue: XmlIssue) => void
}

/** The `<?xml ... ?>` at the top of a document, if it had one. */
export interface XmlDeclaration {
  readonly version?: string
  readonly encoding?: string
  readonly standalone?: string
  readonly line: number
  readonly column: number
}

export interface XmlDeclarationEvent extends XmlDeclaration {
  readonly kind: 'declaration'
}

export interface XmlOpenEvent {
  readonly kind: 'open'
  readonly name: string
  /**
   * Attribute values by name, already decoded.
   *
   * Backed by a null-prototype object, which is not fussiness: the probe for this batch
   * wrote `__proto__` into an ordinary `{}` and the key VANISHED — no own property, and
   * reading it back returned `Object.prototype`, an object where the type says `string`.
   * An attribute name comes from the file, so the file chooses the key.
   */
  readonly attributes: Readonly<Record<string, string>>
  readonly isSelfClosing: boolean
  readonly line: number
  readonly column: number
}

export interface XmlCloseEvent {
  readonly kind: 'close'
  readonly name: string
  readonly line: number
  readonly column: number
}

export interface XmlTextEvent {
  readonly kind: 'text'
  /** Decoded and line-ending normalised. Never trimmed — see the whitespace note below. */
  readonly text: string
  /**
   * True when the text is empty or is nothing but XML whitespace, so a caller can skip
   * the indentation an exporter pads with WITHOUT trimming anything.
   *
   * Computed on the decoded text, so a deliberately written `&#32;` counts as whitespace
   * too. A caller that must keep every space the author wrote cannot use this flag.
   */
  readonly isWhitespace: boolean
  /** True when the run came from a CDATA section. The tree drops this — see `parse.ts`. */
  readonly isCdata: boolean
  readonly line: number
  readonly column: number
}

export interface XmlCommentEvent {
  readonly kind: 'comment'
  readonly text: string
  readonly line: number
  readonly column: number
}

export interface XmlInstructionEvent {
  readonly kind: 'instruction'
  readonly target: string
  readonly data: string
  readonly line: number
  readonly column: number
}

export type XmlEvent =
  | XmlDeclarationEvent
  | XmlOpenEvent
  | XmlCloseEvent
  | XmlTextEvent
  | XmlCommentEvent
  | XmlInstructionEvent

/*
 * ENCODINGS THIS MODULE WILL VOUCH FOR, WHICH IS A SHORTER LIST THAN IT LOOKS.
 *
 * US-ASCII is here because it is a strict subset of UTF-8: a file that really is ASCII
 * decodes identically either way, so a declaration saying so cannot be wrong in a way
 * that matters. ISO-8859-1, Windows-1252 and UTF-16 are not, and are not.
 */
const VOUCHED_ENCODINGS = new Set(['UTF-8', 'UTF8', 'US-ASCII', 'ASCII'])

const LINE_ENDING = /\r\n|\r/g

/** `version="1.0" encoding="UTF-8" standalone="yes"`, in either quote style. */
const DECLARATION_ATTRIBUTE = /([A-Za-z][A-Za-z0-9]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

interface OpenElement {
  readonly name: string
  readonly position: XmlPosition
}

/**
 * Walk XML text, yielding one event at a time.
 *
 * @throws XmlError for anything malformed, for a `<!DOCTYPE`, for a character XML forbids,
 *   and for a cap that is exceeded or a cap that is not a positive whole number. Every one
 *   of those except the cap arguments carries a line and a column.
 */
export function* scanXml(
  text: string,
  options: XmlScanOptions = {},
): Generator<XmlEvent, void, undefined> {
  const maxDepth = requirePositiveInteger(options.maxDepth ?? XML_DEFAULTS.maxDepth, 'maxDepth')
  const maxElements = requirePositiveInteger(
    options.maxElements ?? XML_DEFAULTS.maxElements,
    'maxElements',
  )
  const maxTextLength = requirePositiveInteger(
    options.maxTextLength ?? XML_DEFAULTS.maxTextLength,
    'maxTextLength',
  )
  const maxAttributes = requirePositiveInteger(
    options.maxAttributesPerElement ?? XML_DEFAULTS.maxAttributesPerElement,
    'maxAttributesPerElement',
  )

  const { text: body } = stripByteOrderMark(text)
  const onIssue = options.onIssue

  /*
   * THE FIRST THING, BEFORE A SINGLE TAG IS READ: is this text even a decoded XML
   * document? A character the Char production forbids means the bytes were not what the
   * decoder was told, and the commonest case by far is a UTF-16 export read as UTF-8,
   * which is ASCII interleaved with NULs from its second character onward. Parsing on
   * would produce a tree of ledger names with NULs inside them and no error anywhere.
   */
  const forbidden = findForbiddenCharacter(body)
  if (forbidden >= 0) {
    const codePoint = body.codePointAt(forbidden) ?? 0
    throw xmlErrorAt(
      'XML_INVALID_CHARACTER',
      positionAt(body, forbidden),
      `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} cannot appear in an XML ` +
        'document at all. This nearly always means the file was saved in one encoding and ' +
        'read as another - a file exported as UTF-16 and read as UTF-8 looks exactly like ' +
        'this. Re-export it as UTF-8.',
    )
  }

  if (onIssue !== undefined) {
    reportReplacementCharacters(body, onIssue)
  }

  const cursor = cursorAt()
  const openElements: OpenElement[] = []
  let elementCount = 0
  let rootSeen = false

  const here = (): XmlPosition => positionOf(cursor)
  const advance = (to: number): void => {
    seekTo(body, cursor, to)
  }
  const skipWhitespace = (): boolean => {
    const from = cursor.index
    let at = from
    while (at < body.length && isXmlWhitespace(body.charAt(at))) {
      at += 1
    }
    advance(at)
    return at > from
  }

  while (cursor.index < body.length) {
    const lessThan = body.indexOf('<', cursor.index)
    const textEnd = lessThan < 0 ? body.length : lessThan

    if (textEnd > cursor.index) {
      const start = cursor.index
      const position = here()
      /* The cap is measured on the text AS WRITTEN, which is the allocation. A decoded
       * run is never longer: `&#x1F600;` is nine characters in and two out. */
      if (textEnd - start > maxTextLength) {
        throw xmlErrorAt(
          'XML_TEXT_TOO_LONG',
          position,
          `This run of text is ${String(textEnd - start)} characters long, which is more ` +
            `than the ${String(maxTextLength)} Coffer reads at once. That is usually a tag ` +
            'that was opened and never closed.',
        )
      }
      const value = decodeXmlReferences(
        body,
        start,
        textEnd,
        { line: cursor.line, lineStart: cursor.lineStart },
        'text',
      )
      advance(textEnd)
      const isWhitespace = isXmlWhitespaceOnly(value)
      if (openElements.length === 0 && !isWhitespace) {
        throw xmlErrorAt(
          'XML_CONTENT_OUTSIDE_ROOT',
          position,
          'There is text outside the outermost element. An XML document holds exactly one ' +
            'element, and everything else has to be inside it.',
        )
      }
      yield {
        kind: 'text',
        text: value,
        isWhitespace,
        isCdata: false,
        line: position.line,
        column: position.column,
      }
    }

    if (lessThan < 0) {
      break
    }

    const tagPosition = here()
    const second = body.charAt(lessThan + 1)

    if (second === '') {
      throw xmlErrorAt(
        'XML_UNTERMINATED_TAG',
        tagPosition,
        "The document ends with a '<'. A '<' that is part of the text has to be written " +
          'as &lt;.',
      )
    }

    if (second === '/') {
      advance(lessThan + 2)
      const name = readXmlName(body, cursor.index)
      if (name === '') {
        throw xmlErrorAt(
          'XML_INVALID_NAME',
          tagPosition,
          'A closing tag has to name the element it closes, as </VOUCHER>.',
        )
      }
      advance(cursor.index + name.length)
      skipWhitespace()
      if (cursor.index >= body.length) {
        throw xmlErrorAt(
          'XML_UNTERMINATED_TAG',
          tagPosition,
          `The document ends in the middle of </${name}>.`,
        )
      }
      if (body.charAt(cursor.index) !== '>') {
        throw xmlErrorAt(
          'XML_INVALID_NAME',
          here(),
          `</${name}> has something after the name. A closing tag carries no attributes.`,
        )
      }
      const innermost = openElements[openElements.length - 1]
      if (innermost === undefined) {
        throw xmlErrorAt(
          'XML_UNEXPECTED_CLOSE_TAG',
          tagPosition,
          `</${name}> closes an element that was never opened.`,
        )
      }
      if (innermost.name !== name) {
        throw xmlErrorAt(
          'XML_MISMATCHED_TAG',
          tagPosition,
          `</${name}> does not close <${innermost.name}>, which opened on line ` +
            `${String(innermost.position.line)}, column ${String(innermost.position.column)} ` +
            'and is still open.',
        )
      }
      openElements.pop()
      advance(cursor.index + 1)
      yield { kind: 'close', name, line: tagPosition.line, column: tagPosition.column }
      continue
    }

    if (second === '?') {
      advance(lessThan + 2)
      const target = readXmlName(body, cursor.index)
      if (target === '') {
        throw xmlErrorAt(
          'XML_INVALID_NAME',
          tagPosition,
          'A processing instruction has to name a target, as <?target ... ?>.',
        )
      }
      advance(cursor.index + target.length)
      const closeAt = body.indexOf('?>', cursor.index)
      if (closeAt < 0) {
        throw xmlErrorAt(
          'XML_UNTERMINATED_PI',
          tagPosition,
          `<?${target} was opened and the document ends before its ?>.`,
        )
      }

      if (target.toLowerCase() === 'xml') {
        if (target !== 'xml') {
          throw xmlErrorAt(
            'XML_RESERVED_TARGET',
            tagPosition,
            `<?${target} is a reserved target. An XML declaration is spelled <?xml, in ` +
              'lower case.',
          )
        }
        if (lessThan !== 0) {
          throw xmlErrorAt(
            'XML_DECLARATION_MISPLACED',
            tagPosition,
            'An XML declaration has to be the very first thing in the document - before ' +
              'any whitespace, text or comment, and after a byte order mark if there is one.',
          )
        }
        const declaration = readDeclaration(body.slice(cursor.index, closeAt), tagPosition)
        advance(closeAt + 2)
        if (onIssue !== undefined) {
          reportEncoding(declaration, onIssue)
        }
        yield { kind: 'declaration', ...declaration }
        continue
      }

      const hadSpace = skipWhitespace()
      if (!hadSpace && cursor.index < closeAt) {
        throw xmlErrorAt(
          'XML_INVALID_NAME',
          here(),
          `<?${target} needs a space between its target and its data.`,
        )
      }
      const data = body.slice(cursor.index, closeAt).replace(LINE_ENDING, '\n')
      advance(closeAt + 2)
      yield {
        kind: 'instruction',
        target,
        data,
        line: tagPosition.line,
        column: tagPosition.column,
      }
      continue
    }

    if (second === '!') {
      if (body.startsWith('<!--', lessThan)) {
        const contentStart = lessThan + 4
        const contentEnd = body.indexOf('-->', contentStart)
        if (contentEnd < 0) {
          throw xmlErrorAt(
            'XML_UNTERMINATED_COMMENT',
            tagPosition,
            'A comment was opened with <!-- and the document ends before its -->.',
          )
        }
        const comment = body.slice(contentStart, contentEnd).replace(LINE_ENDING, '\n')
        advance(contentEnd + 3)
        yield {
          kind: 'comment',
          text: comment,
          line: tagPosition.line,
          column: tagPosition.column,
        }
        continue
      }

      if (body.startsWith('<![CDATA[', lessThan)) {
        const contentStart = lessThan + 9
        const contentEnd = body.indexOf(']]>', contentStart)
        if (contentEnd < 0) {
          throw xmlErrorAt(
            'XML_UNTERMINATED_CDATA',
            tagPosition,
            'A CDATA section was opened and the document ends before its ]]>.',
          )
        }
        if (contentEnd - contentStart > maxTextLength) {
          throw xmlErrorAt(
            'XML_TEXT_TOO_LONG',
            tagPosition,
            `This CDATA section is ${String(contentEnd - contentStart)} characters long, ` +
              `which is more than the ${String(maxTextLength)} Coffer reads at once.`,
          )
        }
        if (openElements.length === 0) {
          throw xmlErrorAt(
            'XML_CONTENT_OUTSIDE_ROOT',
            tagPosition,
            'There is a CDATA section outside the outermost element. An XML document holds ' +
              'exactly one element, and all of its content has to be inside it.',
          )
        }
        const value = body.slice(contentStart, contentEnd).replace(LINE_ENDING, '\n')
        advance(contentEnd + 3)
        yield {
          kind: 'text',
          text: value,
          isWhitespace: isXmlWhitespaceOnly(value),
          isCdata: true,
          line: tagPosition.line,
          column: tagPosition.column,
        }
        continue
      }

      if (body.slice(lessThan, lessThan + 9).toUpperCase() === '<!DOCTYPE') {
        /* Refused by name, and never skipped. See the security note in the header: both
         * XXE and billion-laughs arrive through a doctype, and a parser that quietly
         * stepped over one would be telling its caller it had dealt with it. */
        throw xmlErrorAt(
          'XML_DOCTYPE_FORBIDDEN',
          tagPosition,
          'This file has a document type declaration (<!DOCTYPE). Coffer does not read ' +
            'them: a DTD can define entities that expand without limit or that pull in ' +
            'other files, so it is a way to attack the machine reading the import rather ' +
            'than a way to describe accounting data. Remove the <!DOCTYPE line and import ' +
            'the file again.',
        )
      }

      throw xmlErrorAt(
        'XML_INVALID_MARKUP',
        tagPosition,
        "A '<!' here begins something that is neither a comment nor a CDATA section. " +
          'Coffer reads elements, text, comments and CDATA, and nothing else.',
      )
    }

    // An opening tag.
    advance(lessThan + 1)
    const name = readXmlName(body, cursor.index)
    if (name === '') {
      throw xmlErrorAt(
        'XML_INVALID_NAME',
        tagPosition,
        "A '<' here does not begin a tag. A '<' that is part of the text has to be " +
          'written as &lt;.',
      )
    }
    const isRoot = openElements.length === 0
    if (isRoot && rootSeen) {
      throw xmlErrorAt(
        'XML_MULTIPLE_ROOTS',
        tagPosition,
        `<${name}> is a second outermost element. An XML document holds exactly one.`,
      )
    }
    if (openElements.length + 1 > maxDepth) {
      throw xmlErrorAt(
        'XML_TOO_DEEP',
        tagPosition,
        `<${name}> is nested ${String(openElements.length + 1)} deep, which is deeper than ` +
          `the ${String(maxDepth)} Coffer reads.`,
      )
    }
    elementCount += 1
    if (elementCount > maxElements) {
      throw xmlErrorAt(
        'XML_TOO_MANY_ELEMENTS',
        tagPosition,
        `This file has more than ${String(maxElements)} elements, which is more than Coffer ` +
          'reads at once.',
      )
    }
    advance(cursor.index + name.length)

    const attributes = Object.create(null) as Record<string, string>
    let attributeCount = 0
    let isSelfClosing = false

    for (;;) {
      const hadSpace = skipWhitespace()
      const character = body.charAt(cursor.index)

      if (character === '') {
        throw xmlErrorAt(
          'XML_UNTERMINATED_TAG',
          tagPosition,
          `The document ends inside the tag <${name}.`,
        )
      }
      if (character === '>') {
        advance(cursor.index + 1)
        break
      }
      if (character === '/') {
        if (body.charAt(cursor.index + 1) !== '>') {
          throw xmlErrorAt(
            'XML_ATTRIBUTE_MALFORMED',
            here(),
            `<${name} has a '/' that is not the start of a self-closing '/>'.`,
          )
        }
        isSelfClosing = true
        advance(cursor.index + 2)
        break
      }
      if (!hadSpace) {
        /* The condition this alone excludes: `<X a="1"b="2">`, where both attributes are
         * individually well formed and only the space between them is missing. Without
         * this check the scanner reads `b` as a second attribute and the file imports. */
        throw xmlErrorAt(
          'XML_ATTRIBUTE_MALFORMED',
          here(),
          `<${name}> needs a space between one attribute and the next.`,
        )
      }

      const attributePosition = here()
      const attributeName = readXmlName(body, cursor.index)
      if (attributeName === '') {
        throw xmlErrorAt(
          'XML_ATTRIBUTE_MALFORMED',
          attributePosition,
          `<${name}> has something in its opening tag that is not an attribute name.`,
        )
      }
      advance(cursor.index + attributeName.length)
      skipWhitespace()
      if (body.charAt(cursor.index) !== '=') {
        throw xmlErrorAt(
          'XML_ATTRIBUTE_MALFORMED',
          attributePosition,
          `${attributeName} has no value. XML has no bare attributes: write ` +
            `${attributeName}="..." or leave it out.`,
        )
      }
      advance(cursor.index + 1)
      skipWhitespace()
      const quote = body.charAt(cursor.index)
      if (quote !== '"' && quote !== "'") {
        throw xmlErrorAt(
          'XML_ATTRIBUTE_UNQUOTED',
          here(),
          `The value of ${attributeName} is not in quotation marks. Every XML attribute ` +
            `value is quoted, as ${attributeName}="..." or ${attributeName}='...'.`,
        )
      }
      const valueStart = cursor.index + 1
      const valueEnd = body.indexOf(quote, valueStart)
      if (valueEnd < 0) {
        throw xmlErrorAt(
          'XML_UNTERMINATED_TAG',
          attributePosition,
          `The value of ${attributeName} opens with a quotation mark that is never closed, ` +
            'so the rest of the file was read as one value.',
        )
      }
      if (body.slice(valueStart, valueEnd).includes('<')) {
        /* Not pedantry about the spec: a '<' inside an attribute value is what an
         * unclosed quotation mark looks like from here, and the alternative is swallowing
         * the next hundred tags into one attribute and reporting nothing. */
        throw xmlErrorAt(
          'XML_ATTRIBUTE_MALFORMED',
          attributePosition,
          `The value of ${attributeName} contains a '<'. That usually means its quotation ` +
            "mark was never closed; a '<' that is part of a value is written as &lt;.",
        )
      }
      if (valueEnd - valueStart > maxTextLength) {
        throw xmlErrorAt(
          'XML_TEXT_TOO_LONG',
          attributePosition,
          `The value of ${attributeName} is ${String(valueEnd - valueStart)} characters ` +
            `long, which is more than the ${String(maxTextLength)} Coffer reads at once.`,
        )
      }
      advance(valueStart)
      const value = decodeXmlReferences(
        body,
        valueStart,
        valueEnd,
        { line: cursor.line, lineStart: cursor.lineStart },
        'attribute',
      )
      advance(valueEnd + 1)

      if (Object.prototype.hasOwnProperty.call(attributes, attributeName)) {
        throw xmlErrorAt(
          'XML_DUPLICATE_ATTRIBUTE',
          attributePosition,
          `<${name}> carries ${attributeName} twice. Which of the two values was meant is ` +
            'not something Coffer can decide.',
        )
      }
      attributeCount += 1
      if (attributeCount > maxAttributes) {
        throw xmlErrorAt(
          'XML_TOO_MANY_ATTRIBUTES',
          tagPosition,
          `<${name}> has more than ${String(maxAttributes)} attributes, which is more than ` +
            'Coffer reads at once.',
        )
      }
      attributes[attributeName] = value
    }

    if (isRoot) {
      rootSeen = true
    }
    yield {
      kind: 'open',
      name,
      attributes,
      isSelfClosing,
      line: tagPosition.line,
      column: tagPosition.column,
    }
    if (isSelfClosing) {
      yield { kind: 'close', name, line: tagPosition.line, column: tagPosition.column }
    } else {
      openElements.push({ name, position: tagPosition })
    }
  }

  const unclosed = openElements[openElements.length - 1]
  if (unclosed !== undefined) {
    /* Reported at the line the element OPENED on, not at the end of the file, for the same
     * reason csv/parse.ts reports an unterminated quote where the quote opened: the end of
     * the file is where the symptom is, and the opening tag is where the fix is. */
    const others =
      openElements.length > 1
        ? ` (${String(openElements.length)} elements are still open where the file ends)`
        : ''
    throw xmlErrorAt(
      'XML_UNCLOSED_ELEMENT',
      unclosed.position,
      `<${unclosed.name}> was opened here and never closed${others}.`,
    )
  }
}

// ---- Internals ------------------------------------------------------------

function readDeclaration(span: string, position: XmlPosition): XmlDeclaration {
  const found = new Map<string, string>()
  for (const match of span.matchAll(DECLARATION_ATTRIBUTE)) {
    const key = match[1]
    const value = match[2] ?? match[3]
    if (key !== undefined && value !== undefined && !found.has(key)) {
      found.set(key, value)
    }
  }
  return {
    version: found.get('version'),
    encoding: found.get('encoding'),
    standalone: found.get('standalone'),
    line: position.line,
    column: position.column,
  }
}

/*
 * THE ENCODING DECLARATION IS REPORTED AND NOT REFUSED, AND THE REASON IS MEASURABLE.
 *
 * The declaration describes the BYTES of a file this module never saw: by the time the
 * text arrives here somebody has already decoded it, and the string is either right or it
 * is mojibake, with nothing in the declaration to say which. Tally has historically
 * exported UTF-16 and ISO-8859-1, so a caller that read the file correctly - by sniffing
 * the BOM, or by being told - arrives with a perfectly good string and a declaration
 * saying UTF-16. REFUSING ON THE DECLARATION WOULD REFUSE THAT FILE, which is the exact
 * file the importer exists to read.
 *
 * What is refused instead is the EVIDENCE of a bad decode, which unlike the declaration is
 * a property of the string in hand: a character the Char production forbids. It is checked
 * before anything else in `scanXml`, and it catches the whole UTF-16-read-as-UTF-8 class
 * at the second character of the file.
 *
 * AND THE HALF THAT SETTLED IT, WHICH WAS PROBED AND NOT REASONED: a UTF-8 file read as
 * ISO-8859-1 produces no forbidden character and no U+FFFD at all. It is `Cafe` with two
 * ordinary Latin letters where an accent should be - legal XML, every character allowed,
 * and undetectable from the text. For that failure the declaration is the ONLY signal
 * there is, which is precisely why it must reach the user as a warning rather than being
 * consumed by a check that would have thrown it away.
 */
function reportEncoding(declaration: XmlDeclaration, onIssue: (issue: XmlIssue) => void): void {
  const encoding = declaration.encoding
  if (encoding === undefined || VOUCHED_ENCODINGS.has(encoding.trim().toUpperCase())) {
    return
  }
  onIssue({
    code: 'ENCODING_UNVERIFIED',
    severity: 'warning',
    message:
      `This file says it is written in ${encoding}, and Coffer was handed it as text that ` +
      'had already been decoded, so it cannot check. The data has been read; if names or ' +
      'narrations come through with strange characters in them, re-export the file as ' +
      'UTF-8 and import it again.',
    line: declaration.line,
    column: declaration.column,
    value: encoding,
  })
}

function reportReplacementCharacters(body: string, onIssue: (issue: XmlIssue) => void): void {
  const first = body.indexOf(REPLACEMENT_CHARACTER)
  if (first < 0) {
    return
  }
  let count = 0
  for (let index = 0; index < body.length; index += 1) {
    if (body.charAt(index) === REPLACEMENT_CHARACTER) {
      count += 1
    }
  }
  const position = positionAt(body, first)
  onIssue({
    code: 'REPLACEMENT_CHARACTER',
    severity: 'warning',
    message:
      `This file contains ${String(count)} replacement character${count === 1 ? '' : 's'} ` +
      '(U+FFFD), the first on line ' +
      `${String(position.line)}, column ${String(position.column)}. That character is what ` +
      'a decoder leaves behind when the bytes were not what it was told they were, so some ' +
      'text in this file has already been lost. Re-export it as UTF-8.',
    line: position.line,
    column: position.column,
  })
}
