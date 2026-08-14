/*
 * Reading a formatted figure — WITHOUT DOING ARITHMETIC ON IT.
 *
 * docs/CONVENTIONS.md §1.7: the renderer never computes money. It also never
 * parses money, because `Number('1,20,000.55')` is how a rounding bug gets in
 * through the back door. Every amount arrives from main already formatted, and
 * the only thing the UI legitimately needs to know about it is which of three
 * states to colour it: negative, zero, or neither.
 *
 * So this is a character scan, not a parse. It looks at signs and digits and never
 * builds a number from them. It is deliberately the only place in the renderer
 * allowed to look inside a monetary string at all.
 */

export type FigureSign = 'negative' | 'zero' | 'positive'

const MINUS_SIGNS = new Set(['-', '−', '–', '—'])

/**
 * Classifies an already-formatted amount.
 *
 * Handles both conventions main may send: a leading minus, and the accounting
 * parenthesis — `(1,200.00)` is a credit, not a note. A string with no digits at
 * all ('—', 'n/a', '') reads as zero, which is what those placeholders mean.
 */
export function figureSign(formatted: string): FigureSign {
  const text = formatted.trim()
  if (text === '') return 'zero'

  const isParenthesised = text.startsWith('(') && text.endsWith(')')
  let isNegative = isParenthesised
  let hasDigit = false
  let hasNonZeroDigit = false

  for (const character of text) {
    if (character >= '0' && character <= '9') {
      hasDigit = true
      if (character !== '0') hasNonZeroDigit = true
      continue
    }
    /* A sign only counts before the first digit: '1,200-' is not a negative and
     * neither is the dash in a date or a range. */
    if (!hasDigit && MINUS_SIGNS.has(character)) isNegative = true
  }

  if (!hasDigit || !hasNonZeroDigit) return 'zero'
  return isNegative ? 'negative' : 'positive'
}

/** The class a figure should carry, so every screen colours money identically. */
export function figureClassName(formatted: string, extra?: string): string {
  const sign = figureSign(formatted)
  const tone = sign === 'positive' ? '' : ` figure--${sign}`
  return `figure${tone}${extra === undefined ? '' : ` ${extra}`}`
}
