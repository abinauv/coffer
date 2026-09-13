/*
 * Text normalisation shared by everything in this folder.
 *
 * It lives in one file because three separate modules need the SAME answer to "are
 * these two pieces of text the same?" — the header matcher (" VALUE DATE " and
 * "value date" are one column), the amount parser (a non-breaking space between the
 * currency symbol and the digits is not a difference), and the duplicate fingerprint
 * (a narration re-exported with different spacing is not a new transaction). Three
 * copies of a folding rule is three chances for two of them to drift, and the symptom
 * would be a duplicate check that disagrees with the column matcher about the same
 * file.
 *
 * WHAT GETS FOLDED, AND WHY EACH ONE IS HERE RATHER THAN IMAGINED:
 *
 *   NFC          A vendor name typed with a combining accent and the same name typed
 *                with the precomposed character are the same name. They are different
 *                strings, they render identically, and no user can see the difference.
 *   Zero-width   U+200B..U+200D, U+2060 and U+00AD arrive from statements that were
 *                copied out of a web page. They are invisible, so a header that
 *                carries one looks exactly like the header that does not, and the
 *                column silently fails to match.
 *   U+FEFF       The byte order mark. In the middle of a string it is a zero-width
 *                no-break space. JavaScript's `\s` matches it, so folding whitespace
 *                first would turn it into a real space instead of removing it — hence
 *                it is stripped with the other invisibles, before whitespace folding.
 *   Whitespace   Runs of any whitespace, including U+00A0, become one plain space,
 *                and the ends are trimmed. Tabs inside a quoted narration are common
 *                and mean nothing.
 *
 * WHAT IS NOT FOLDED: case. Case folding is a decision each caller makes for itself —
 * `normaliseHeading` folds it because a heading is an identifier, and `foldText` does
 * not because an amount parser must not lowercase and a narration kept for display
 * must not either.
 */

/** U+FEFF. At the very start of a file it is a byte order mark; anywhere else it is noise. */
export const BYTE_ORDER_MARK = '\uFEFF'

/*
 * Invisible characters with no textual meaning. Removed rather than replaced with a
 * space: they are joiners and marks, and turning one into a space would split a word.
 * U+FEFF is in this class deliberately — see the header.
 */
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g

/** Any run of whitespace. `\s` already covers U+00A0, U+2000-U+200A, U+202F and U+3000. */
const WHITESPACE_RUN = /\s+/g

/**
 * Remove a leading byte order mark and say whether there was one.
 *
 * This matters more than it looks. Excel writes a UTF-8 BOM, banks export from Excel,
 * and Node hands the BOM through as a real U+FEFF character when a file is read as
 * 'utf8'. It lands at the front of the FIRST HEADING and nowhere else — so every column
 * in the file matches its expected name except the first one, which reads exactly like
 * a mapping bug in the first column and is not one. Strip it once, here, at the door.
 *
 * Only position zero. A U+FEFF later in the file is data (well, noise) and is handled
 * by `foldText`, not by pretending the file has a second header.
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

/**
 * Normalise a piece of text for comparison: NFC, no invisibles, single spaces, trimmed.
 *
 * Case is preserved. See the module header for why.
 */
export function foldText(text: string): string {
  return text.normalize('NFC').replace(INVISIBLE, '').replace(WHITESPACE_RUN, ' ').trim()
}

/**
 * Normalise a column heading into the key columns are matched by.
 *
 * `foldText` plus lower case, so "Value Date", "value date" and " VALUE DATE " are one
 * column. Lower rather than upper because the two differ for a handful of scripts and
 * the direction has to be fixed somewhere; nothing in a bank statement heading is
 * affected either way.
 */
export function normaliseHeading(text: string): string {
  return foldText(text).toLowerCase()
}

/** True when text carries nothing but whitespace and invisibles. */
export function isBlank(text: string): boolean {
  return foldText(text) === ''
}
