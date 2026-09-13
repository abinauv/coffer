/*
 * Reading XML that somebody exported from their old accounting system.
 * Import from here, not from the individual files.
 *
 * THE SECOND THING IN `services/importers/`, built the same way and for the same reason as
 * the first: once, ahead of the callers that need it, so that two importers do not grow two
 * XML readers with two answers to what `&nbsp;` means and two places for a `<!DOCTYPE` to
 * be waved through.
 *
 * THE WHOLE MODULE IS PURE. Nothing here opens a file. The caller supplies the text, which
 * keeps every part of it testable against a string fixture and leaves the I/O decision —
 * and with it the question of which paths a user can be persuaded to read from — with the
 * caller, where it is answered once, at the file dialog.
 *
 * IT KNOWS NOTHING ABOUT ANY EXPORTER'S FORMAT. No tag name appears in this folder. What an
 * envelope is called, which element holds a voucher, how a date is written: all of that
 * belongs to the module that understands that format, and encoding any of it here would
 * make this reader subtly wrong for the second format that arrives.
 *
 * The pipeline, and what each step refuses to decide for you:
 *
 *   scanXml           text -> one event at a time. Knows nothing about your structure and
 *                     holds nothing but the open-element stack.
 *   parseXml          text -> a tree, plus what the file said about itself and what was
 *                     noticed about it. Trims nothing.
 *   readXmlSubtrees   text -> the subtrees a predicate you supply matches, one at a time,
 *                     never holding the file.
 *   collapseXmlSpace  the whitespace decision, offered per field rather than taken for you.
 *
 * SECURITY, IN ONE LINE EACH, ARGUED IN `scan.ts`: no DTD processing (a `<!DOCTYPE` is
 * refused by name), no external entity resolution (there is no code path that opens
 * anything), and no entity expansion beyond the five XML defines. Plus four caps, on by
 * default, on depth, element count, text length and attribute count.
 */

export { scanXml, XML_DEFAULTS } from './scan'
export type {
  XmlCloseEvent,
  XmlCommentEvent,
  XmlDeclaration,
  XmlDeclarationEvent,
  XmlEvent,
  XmlInstructionEvent,
  XmlOpenEvent,
  XmlScanOptions,
  XmlTextEvent,
} from './scan'

export { findElements, parseXml, readXmlSubtrees } from './parse'
export type { XmlDocument, XmlParseOptions, XmlSubtree, XmlSubtreeContext } from './parse'

export { attributeOf, childElements, firstChildElement, isElement, isText, textOf } from './nodes'
export type { XmlElement, XmlNode, XmlText } from './nodes'

export { PREDEFINED_ENTITY_NAMES, decodeXmlReferences } from './entities'
export type { ReferenceContext } from './entities'

export { isXmlError, XmlError } from './errors'
export type { XmlErrorCode, XmlIssue, XmlIssueCode, XmlIssueSeverity } from './errors'

export {
  BYTE_ORDER_MARK,
  collapseXmlSpace,
  isXmlName,
  isXmlWhitespace,
  isXmlWhitespaceOnly,
  REPLACEMENT_CHARACTER,
  stripByteOrderMark,
} from './text'
export type { XmlPosition } from './text'
