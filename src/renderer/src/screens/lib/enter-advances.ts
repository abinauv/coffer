/*
 * Enter advances, it never submits (design system §04, rule 1).
 *
 * Nobody has ever meant to post a voucher by pressing Enter one time too many, and a
 * keyboard-heavy data entry screen is exactly where that extra press happens: the last
 * field of the last line is one keystroke away from the primary button. So Enter moves to
 * the next field, and on the last field of the last line it opens a new line — which is
 * what the person typing actually wanted. Accepting the document is always Ctrl Enter.
 *
 * WHAT COUNTS AS A FIELD is what the person can type or choose in: an enabled input or
 * select that is not read-only. A read-only Due box and a disabled control on an issued
 * document are skipped rather than focused, because landing on one looks like the screen
 * has stopped responding.
 *
 * DOM in, decision out. Nothing here focuses anything or changes any state — the editor
 * does that — so every branch is testable without a screen.
 */

export type Advance =
  /** Move the cursor here. */
  | { kind: 'focus'; element: HTMLElement }
  /** The end of the last line: the editor adds one and focuses its first field. */
  | { kind: 'add-line' }
  /** Nothing to advance to. The cursor stays where it is. */
  | { kind: 'none' }

/** A control Enter may land on. */
export function isAdvanceField(element: Element): boolean {
  if (element instanceof HTMLInputElement) {
    return !element.disabled && !element.readOnly && element.type !== 'hidden'
  }
  if (element instanceof HTMLSelectElement) return !element.disabled
  return false
}

/** Every field inside `container`, in the order the document is read. */
export function fieldsIn(container: ParentNode): HTMLElement[] {
  return [...container.querySelectorAll('input, select')].filter(isAdvanceField) as HTMLElement[]
}

/**
 * Where Enter goes from `current`.
 *
 * A line's row is marked with `data-line-key`, so the last field of a row is a question
 * about that row rather than about the table: the next row's first field, or a new line
 * when there is no next row.
 */
export function advanceFrom(container: ParentNode, current: Element): Advance {
  const fields = fieldsIn(container)
  const index = fields.indexOf(current as HTMLElement)
  if (index < 0) return { kind: 'none' }

  const row = current.closest('[data-line-key]')
  if (row !== null) {
    const inRow = fieldsIn(row)
    const isLastOfRow = inRow[inRow.length - 1] === current
    if (isLastOfRow) {
      const rows = [...container.querySelectorAll('[data-line-key]')]
      const isLastRow = rows[rows.length - 1] === row
      if (isLastRow) return { kind: 'add-line' }
      const next = fieldsIn(rows[rows.indexOf(row) + 1] as ParentNode)[0]
      return next === undefined ? { kind: 'none' } : { kind: 'focus', element: next }
    }
  }

  const next = fields[index + 1]
  return next === undefined ? { kind: 'none' } : { kind: 'focus', element: next }
}

/**
 * Whether this keystroke is the plain Enter that advances.
 *
 * Ctrl Enter accepts the document and Shift Enter is nobody's business here, so both are
 * left alone. A textarea keeps its own Enter: the narration is prose, and a note that
 * cannot hold two lines is a note people work around by not writing one.
 */
export function isAdvanceKey(event: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  target: EventTarget | null
}): boolean {
  if (event.key !== 'Enter') return false
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
  return event.target instanceof Element && isAdvanceField(event.target)
}
