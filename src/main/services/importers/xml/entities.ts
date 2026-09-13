/*
 * Turning `&...;` into characters, and refusing everything else that starts with an `&`.
 *
 * FIVE NAMED REFERENCES AND NO SIXTH. `&amp;` `&lt;` `&gt;` `&apos;` `&quot;` are the only
 * ones XML itself defines; every other name — `&nbsp;`, `&copy;`, `&eacute;` — is declared
 * by a DTD, and this module refuses DTDs (see `scan.ts`). So an unknown name is refused BY
 * NAME rather than passed through. That is not pedantry: a `&nbsp;` that reaches a ledger
 * narration as the six literal characters `&nbsp;` is a data bug that survives every
 * downstream check, prints on an invoice, and is discovered by a customer.
 *
 * NO ENTITY EXPANSION OF ANY KIND. The five above expand to exactly one character each and
 * their replacement text is a constant in this file. There is no table a document can add
 * to, so there is no recursion, so billion-laughs has nothing to stand on. This is a
 * property of the design, not a limit that has been set carefully.
 *
 * ORDER OF OPERATIONS, WHICH IS NOT THE OBVIOUS ONE. XML 1.0 §2.11 normalises line endings
 * in the LITERAL text before references are resolved, and that ordering is load-bearing:
 * a literal CRLF becomes one LF, while `&#xD;` produces a real carriage return that
 * survives, because it was never literal text. Decoding first and normalising after would
 * silently destroy the second case. So this walks the run once, normalising the literal
 * spans as it copies them and appending decoded references verbatim.
 *
 * WHAT WAS PROBED RATHER THAN ASSUMED, because every one of these is a silent wrong answer
 * rather than a crash:
 *
 *   Number('')          is 0.        A missing digit run would have decoded to a NUL.
 *   Number('0x10')      is 16.       `&#0x10;` would have decoded, as the wrong character.
 *   parseInt('26zz')    is 26.       `&#26zz;` would have decoded, silently.
 *   fromCodePoint(0xD83D) does not throw — it returns a lone surrogate of length 1, an
 *                       ill-formed string that JSON.stringify will happily emit.
 *   fromCodePoint(0x110000) throws RangeError, which is the only one that would have been
 *                       noticed.
 *
 * So the digits are validated by pattern first, the range is checked explicitly, and the
 * Char production is checked before `fromCodePoint` is called at all.
 */

import { xmlErrorAt, type XmlError, type XmlErrorCode } from './errors'
import {
  cursorAt,
  isAllowedXmlCodePoint,
  isXmlName,
  positionOf,
  seekTo,
  type XmlPosition,
} from './text'

/**
 * The five, and nothing else.
 *
 * A `Map` rather than an object literal, for a reason the probe for this batch found:
 * looking `constructor` up in a `Record<string, string>` object literal returns a
 * FUNCTION, and `__proto__` written into one is silently dropped and reads back as
 * `Object.prototype`. Both are values TypeScript has been told are strings. A `Map` has no
 * inherited keys, so `&constructor;` is an unknown entity like any other.
 */
const PREDEFINED_ENTITIES = new Map<string, string>([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['apos', "'"],
  ['quot', '"'],
])

/** The names XML defines, for a message that can list them. */
export const PREDEFINED_ENTITY_NAMES: readonly string[] = [...PREDEFINED_ENTITIES.keys()]

/**
 * Where a run of text came from, which decides how literal whitespace is treated.
 *
 * `text`   — element content. Line endings normalise to LF and nothing else changes.
 * `attribute` — an attribute value. XML 1.0 §3.3.3 additionally replaces each literal tab
 *            and line break with a space. It applies here to EVERY attribute because this
 *            reader refuses DTDs, so every attribute is of type CDATA by definition and
 *            there is no declared type that could say otherwise. A `&#xA;` is untouched:
 *            the rule is about literal whitespace, and that is the distinction that makes
 *            the round trip through an XML writer stable.
 */
export type ReferenceContext = 'text' | 'attribute'

/**
 * Longest `&...;` this module will look for before calling an ampersand a stray one.
 *
 * A window rather than "search to the end of the run": without it, a lone `&` in a
 * narration makes the reader scan a megabyte for a semicolon it will find in some
 * unrelated sentence, and then quote that megabyte back at the user as the offending
 * entity name. The longest legitimate body is `#x10FFFF`, at eight characters.
 */
const MAX_REFERENCE_BODY = 32

const LINE_ENDING = /\r\n|\r/g
const LITERAL_ATTRIBUTE_WHITESPACE = /[\n\t]/g
const DECIMAL_DIGITS = /^[0-9]+$/
const HEX_DIGITS = /^[0-9a-fA-F]+$/

/**
 * Decode `source[start..end)` — normalising line endings, resolving references.
 *
 * The span is given as indices into the whole document rather than as a slice so that a
 * bad reference can be reported at its real line and column: `origin` seeds a cursor with
 * the line the span starts on and the index its line started at, and the cursor walks
 * forward to each ampersand from there.
 *
 * @throws XmlError for an unknown entity, a stray ampersand, or a numeric reference to
 *   something that is not a character XML allows.
 */
export function decodeXmlReferences(
  source: string,
  start: number,
  end: number,
  origin: { readonly line: number; readonly lineStart: number },
  context: ReferenceContext,
): string {
  let decoded = ''
  let literalStart = start
  let index = start
  const cursor = cursorAt(start, origin.line, origin.lineStart)

  while (index < end) {
    const ampersand = source.indexOf('&', index)
    if (ampersand < 0 || ampersand >= end) {
      break
    }
    decoded += normaliseLiteral(source.slice(literalStart, ampersand), context)
    seekTo(source, cursor, ampersand)
    const reference = readReference(source, ampersand, end, positionOf(cursor))
    decoded += reference.value
    index = reference.next
    literalStart = reference.next
  }

  return decoded + normaliseLiteral(source.slice(literalStart, end), context)
}

// ---- Internals ------------------------------------------------------------

function normaliseLiteral(span: string, context: ReferenceContext): string {
  const normalised = span.replace(LINE_ENDING, '\n')
  if (context === 'attribute') {
    return normalised.replace(LITERAL_ATTRIBUTE_WHITESPACE, ' ')
  }
  return normalised
}

interface ReadReference {
  readonly value: string
  /** Index just past the `;`. */
  readonly next: number
}

function readReference(
  source: string,
  ampersand: number,
  end: number,
  position: XmlPosition,
): ReadReference {
  const window = source.slice(ampersand + 1, Math.min(end, ampersand + 1 + MAX_REFERENCE_BODY))
  const semicolon = window.indexOf(';')
  if (semicolon < 0) {
    throw strayAmpersand(position, window)
  }
  const body = window.slice(0, semicolon)
  const next = ampersand + 1 + semicolon + 1

  if (body === '') {
    throw strayAmpersand(position, window)
  }

  if (body.startsWith('#')) {
    return { value: decodeNumeric(body, position), next }
  }

  const predefined = PREDEFINED_ENTITIES.get(body)
  if (predefined !== undefined) {
    return { value: predefined, next }
  }

  if (isXmlName(body)) {
    throw xmlErrorAt(
      'XML_UNKNOWN_ENTITY',
      position,
      `&${body}; is not a reference XML defines. The only named references are ` +
        `${PREDEFINED_ENTITY_NAMES.map((name) => `&${name};`).join(' ')} — anything else ` +
        'needs a document type declaration, which Coffer does not read. Write the character ' +
        `itself, or a numeric reference such as &#160; for a non-breaking space.`,
    )
  }

  throw strayAmpersand(position, window)
}

function strayAmpersand(position: XmlPosition, window: string): XmlError {
  const shown = window.length > 12 ? `${window.slice(0, 12)}...` : window
  return xmlErrorAt(
    'XML_INVALID_REFERENCE',
    position,
    `&${shown} is not a reference. An ampersand that is part of the text has to be ` +
      'written as &amp;.',
  )
}

function decodeNumeric(body: string, position: XmlPosition): string {
  const isHex = body.startsWith('#x')
  const digits = body.slice(isHex ? 2 : 1)
  const pattern = isHex ? HEX_DIGITS : DECIMAL_DIGITS

  if (body.startsWith('#X')) {
    /* The production is `&#x`, lower case, and this is refused rather than guessed at:
     * `&#X26;` is either a mistyped reference or five literal characters, and a reader
     * that picks one is deciding what the file says. */
    throw invalidReference(
      position,
      body,
      'A hexadecimal character reference is written with a lower-case x, as &#x26;.',
    )
  }

  if (!pattern.test(digits)) {
    throw invalidReference(
      position,
      body,
      isHex
        ? 'A hexadecimal character reference contains only the digits 0-9 and a-f.'
        : 'A character reference contains only the digits 0-9, or 0-9 and a-f after &#x.',
    )
  }

  const codePoint = Number.parseInt(digits, isHex ? 16 : 10)

  if (!Number.isSafeInteger(codePoint) || codePoint > 0x10ffff) {
    throw invalidCharacterReference(
      position,
      body,
      'There is no such character: the highest there is, is &#x10FFFF;.',
    )
  }

  if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
    throw invalidCharacterReference(
      position,
      body,
      'That is one half of a surrogate pair, not a character. A character above U+FFFF is ' +
        'written as a single reference to its code point, as &#x1F600; and not as two ' +
        'references to its halves.',
    )
  }

  if (!isAllowedXmlCodePoint(codePoint)) {
    throw invalidCharacterReference(
      position,
      body,
      `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} is a character XML does ` +
        'not allow in a document at all. Only tab, newline and carriage return are ' +
        'permitted below U+0020.',
    )
  }

  return String.fromCodePoint(codePoint)
}

function invalidReference(position: XmlPosition, body: string, advice: string): XmlError {
  return referenceError('XML_INVALID_REFERENCE', position, body, advice)
}

function invalidCharacterReference(position: XmlPosition, body: string, advice: string): XmlError {
  return referenceError('XML_INVALID_CHARACTER_REFERENCE', position, body, advice)
}

function referenceError(
  code: XmlErrorCode,
  position: XmlPosition,
  body: string,
  advice: string,
): XmlError {
  return xmlErrorAt(code, position, `&${body}; cannot be read. ${advice}`)
}
