/*
 * Character-level facts about XML, and the one line-counting rule the whole folder uses.
 *
 * WHY THIS IS A FILE AND NOT THREE COPIES. The scanner counts lines while it walks
 * markup; the reference decoder counts lines while it walks a text run, because
 * `&nbsp;` on the third line of a narration has to be reported on the third line. Two
 * implementations of "what is a line break" would disagree on exactly one input — a lone
 * CR, which is what a file exported by an old Windows tool is full of — and the symptom
 * would be an import error pointing at the wrong line of a file the user cannot read
 * anyway. The same argument `csv/text.ts` makes for its folding rules.
 *
 * WHITESPACE HERE IS XML'S S PRODUCTION AND NOTHING ELSE: #x20, #x9, #xD, #xA. It is
 * DELIBERATELY narrower than JavaScript's `\s`, which also matches U+00A0 and the other
 * Unicode spaces. A non-breaking space in a ledger name is a character somebody typed;
 * folding it away here would make two different ledgers compare equal. `csv/text.ts`
 * folds U+00A0 on purpose because it is matching a column HEADING against a known name,
 * which is a different job from carrying a value through.
 *
 * THE BOM RULE IS DUPLICATED FROM `csv/text.ts` RATHER THAN IMPORTED, and that is the
 * one piece of duplication in this folder. Importing it would make the XML reader depend
 * on the CSV reader for no better reason than that both formats start at byte zero. If a
 * third importer arrives, hoist it to `importers/text.ts` — noted for the integration
 * step rather than done here, because that file is not this batch's to create.
 */

/** U+FEFF. At position zero it is a byte order mark; anywhere else it is a character. */
export const BYTE_ORDER_MARK = '\uFEFF'

/**
 * Remove a leading byte order mark and say whether there was one.
 *
 * Node hands a UTF-8 BOM through as a real U+FEFF when a file is read as 'utf8'. Left in
 * place it sits immediately before `<?xml`, so the declaration is not at the start of the
 * document, every conforming parser refuses the file, and the error is about a construct
 * the user cannot see. Strip it once, here, at the door.
 *
 * Idempotent, so both `parseXml` and `scanXml` may call it and the positions they report
 * agree. Every line and column in this folder is counted in the text AFTER the mark is
 * removed, which is also what a text editor shows: editors hide the mark too.
 */
export function stripByteOrderMark(text: string): {
  text: string
  hadByteOrderMark: boolean
} {
  if (text.startsWith(BYTE_ORDER_MARK)) {
    return { text: text.slice(BYTE_ORDER_MARK.length), hadByteOrderMark: true }
  }
  return { text, hadByteOrderMark: false }
}

/** A 1-based line and a 1-based column, as a text editor counts them. */
export interface XmlPosition {
  readonly line: number
  readonly column: number
}

/**
 * A forward-only scanning position.
 *
 * `lineStart` is the index of the first character of the current line, so the column is
 * arithmetic rather than a search. Forward-only is the point: every position this folder
 * reports is either the cursor now or one that was CAPTURED when an element opened, so
 * nothing ever has to count backwards. That is what lets an unclosed `<VOUCHER>` be
 * reported at the line it opened on and not at the end of the file.
 *
 * Columns are counted in UTF-16 units, so an astral character such as an emoji advances
 * the column by two. Editors disagree with each other about this; the file offset is at
 * least unambiguous.
 */
export interface XmlCursor {
  index: number
  line: number
  lineStart: number
}

/** A cursor at the start of the text, or seeded at a known position. */
export function cursorAt(index = 0, line = 1, lineStart = 0): XmlCursor {
  return { index, line, lineStart }
}

/** The 1-based column the cursor is on. */
export function columnOf(cursor: XmlCursor): number {
  return cursor.index - cursor.lineStart + 1
}

/** The cursor's position, detached from the cursor so it survives further scanning. */
export function positionOf(cursor: XmlCursor): XmlPosition {
  return { line: cursor.line, column: columnOf(cursor) }
}

/*
 * A LINE BREAK IS `\n`, OR A `\r` THAT IS NOT FOLLOWED BY ONE.
 *
 * Written this way round rather than as "consume two characters for a CRLF" so that the
 * cursor advances exactly one character at a time and can therefore be asked to stop
 * anywhere — including between the CR and the LF of a pair. The two-character form
 * overshoots its target there, and the cursor then disagrees with the index the scanner
 * believes it is at; the symptom is every position after the first Windows line ending in
 * the file being off by one.
 */
function isLineBreakAt(text: string, index: number): boolean {
  const character = text.charAt(index)
  if (character === '\n') {
    return true
  }
  return character === '\r' && text.charAt(index + 1) !== '\n'
}

/** Move the cursor forward to `target`, counting the lines it passes. Never moves back. */
export function seekTo(text: string, cursor: XmlCursor, target: number): void {
  let index = cursor.index
  while (index < target) {
    if (isLineBreakAt(text, index)) {
      cursor.line += 1
      cursor.lineStart = index + 1
    }
    index += 1
  }
  cursor.index = index
}

/**
 * The position of an index, counted from the top of the text.
 *
 * For error paths only — it is O(index). Anything on the hot path carries a cursor.
 */
export function positionAt(text: string, index: number): XmlPosition {
  const cursor = cursorAt()
  seekTo(text, cursor, index)
  return positionOf(cursor)
}

/** XML's S production: space, tab, carriage return, line feed. Not `\s`. See the header. */
export function isXmlWhitespace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\r' || character === '\n'
}

/** True when the text is empty or is nothing but XML whitespace. */
export function isXmlWhitespaceOnly(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (!isXmlWhitespace(text.charAt(index))) {
      return false
    }
  }
  return true
}

const XML_WHITESPACE_RUN = /[ \t\r\n]+/g

/**
 * Trim, and collapse each run of XML whitespace to one space.
 *
 * NOT APPLIED BY THE PARSER. It is offered so a caller can apply it per FIELD, which is
 * the only place the decision can be made correctly: a ledger name is an identifier and
 * wants collapsing, a narration is prose and does not. See the whitespace note in
 * `parse.ts`.
 */
export function collapseXmlSpace(text: string): string {
  return text.replace(XML_WHITESPACE_RUN, ' ').trim()
}

/*
 * XML 1.0 Char: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF].
 *
 * Everything else is not merely discouraged, it CANNOT APPEAR in an XML document — which
 * makes this the one check that catches a file decoded with the wrong encoding. UTF-16
 * bytes read as UTF-8 are ASCII interleaved with U+0000, so a mis-decoded Tally export
 * trips this at its second character rather than parsing on into ledger names with NULs
 * inside them. Measured, not assumed: the probe for this batch decoded a real UTF-16
 * document the wrong way and read the code points back.
 *
 * The `u` flag matters. Without it an unpaired surrogate is invisible to a negated class
 * built from code-point ranges; with it, a lone U+D800 is a code point in its own right,
 * falls in none of the ranges above, and is caught.
 */
/* eslint-disable no-control-regex --
 * The rule exists to catch a control character somebody typed by accident. These three are
 * the only controls XML permits, they are named by the Char production, and the class is
 * NEGATED: removing them from it would refuse every file with a tab or a newline in it. */
const FORBIDDEN_CHARACTER =
  /[^\u{9}\u{A}\u{D}\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/u
/* eslint-enable no-control-regex */

/** The index of the first character XML forbids, or -1. */
export function findForbiddenCharacter(text: string): number {
  return text.search(FORBIDDEN_CHARACTER)
}

/** True when a code point may appear in an XML document. The Char production, as a test. */
export function isAllowedXmlCodePoint(codePoint: number): boolean {
  if (codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd) {
    return true
  }
  if (codePoint >= 0x20 && codePoint <= 0xd7ff) {
    return true
  }
  if (codePoint >= 0xe000 && codePoint <= 0xfffd) {
    return true
  }
  return codePoint >= 0x10000 && codePoint <= 0x10ffff
}

/** U+FFFD, what a decoder leaves behind when the bytes were not what it was told they were. */
export const REPLACEMENT_CHARACTER = '\uFFFD'

/*
 * XML 1.0 (Fifth Edition) NameStartChar and NameChar, verbatim.
 *
 * Written out rather than approximated as ASCII-plus-underscore because Tally is not the
 * only exporter this will ever meet and a name is not always ASCII: a Spanish or a Hindi
 * tag is well-formed XML, and rejecting it would be this module inventing a rule. The
 * ranges are a fixed constant of the specification and do not drift.
 */
const NAME_START = String.raw`:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD`
const NAME_REST = String.raw`${NAME_START}\-.0-9\u00B7\u0300-\u036F\u203F-\u2040`

const NAME_START_CHAR = new RegExp(String.raw`^(?:[${NAME_START}]|[\u{10000}-\u{EFFFF}])`, 'u')

/*
 * Sticky, so a name can be read at an index without slicing the document first.
 *
 * `lastIndex` is module state, which is safe here for one reason worth stating: it is
 * assigned and read in the same two statements of `readXmlName`, with no `yield` and no
 * call in between. Two scans of two documents can be alive at once — they are generators
 * — but neither can be suspended inside that pair.
 */
/* eslint-disable no-misleading-character-class --
 * The rule warns that a combining mark in a character class matches on its own rather than
 * as part of the letter it sits on. That is exactly what NameChar means: U+0300-U+036F are
 * listed in the production as characters a name may CONTAIN, and a name is matched one code
 * point at a time. Both regexes carry the `u` flag, so a surrogate pair is one code point
 * and the misleading case the rule is really about cannot arise. */
const NAME_AT = new RegExp(
  String.raw`(?:[${NAME_START}]|[\u{10000}-\u{EFFFF}])(?:[${NAME_REST}]|[\u{10000}-\u{EFFFF}])*`,
  'uy',
)

const WHOLE_NAME = new RegExp(
  String.raw`^(?:[${NAME_START}]|[\u{10000}-\u{EFFFF}])(?:[${NAME_REST}]|[\u{10000}-\u{EFFFF}])*$`,
  'u',
)
/* eslint-enable no-misleading-character-class */

/** True when the character could begin a name — what separates a tag from a stray `<`. */
export function isXmlNameStart(character: string): boolean {
  return NAME_START_CHAR.test(character)
}

/** True when the whole string is an XML Name. */
export function isXmlName(text: string): boolean {
  return WHOLE_NAME.test(text)
}

/** The name at `index`, or an empty string when there is not one. */
export function readXmlName(text: string, index: number): string {
  NAME_AT.lastIndex = index
  const match = NAME_AT.exec(text)
  return match === null ? '' : match[0]
}
