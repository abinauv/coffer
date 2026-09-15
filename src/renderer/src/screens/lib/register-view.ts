/*
 * What every register shares: the line that says where on the list you are, and how wide
 * its search box is.
 *
 * The document and voucher registers page the same way — one row more than is drawn, so
 * Next knows there is somewhere to go — and since 5b each also asks main how many rows its
 * filters match, for "Showing 1–50 of 184". The count is a second read and may fail on
 * its own; the page still draws, and the line leaves off what it does not know.
 */

/**
 * "Showing 1–50 of 184", from the offset of the page, the rows on it, and the count.
 *
 * Null count is a count that could not be read, and the line says only what it knows. One
 * row is "Showing 51 of 51" rather than a range from a number to itself.
 */
export function showingLabel(offset: number, rowsOnPage: number, total: number | null): string {
  if (rowsOnPage === 0) return ''
  const from = offset + 1
  const to = offset + rowsOnPage
  const range = from === to ? String(from) : `${String(from)}–${String(to)}`
  return total === null ? `Showing ${range}` : `Showing ${range} of ${String(total)}`
}

/*
 * B12: A SEARCH BOX THAT CUT OFF ITS OWN PLACEHOLDER. The box took the width its input
 * happened to have, and "Search by number, party or narration" ended at "narr". The width
 * now comes from the placeholder: one `ch` per character is at least as wide as the text in
 * the interface face, and the icon's inset is added on top.
 */
export function searchWidth(placeholder: string): string {
  return `calc(${String(placeholder.length)}ch + var(--space-10))`
}
