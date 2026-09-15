/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { archivedNote, searchWidth, showingLabel } from './register-view'

describe('archivedNote', () => {
  it('says where the archived records went while they are hidden, and nothing once shown', () => {
    expect(archivedNote(false)).toBe(' Archived records are hidden — show them to include them.')
    expect(archivedNote(true)).toBe('')
  })
})

describe('showingLabel', () => {
  it('says which rows are on the page and how many there are in all', () => {
    expect(showingLabel(0, 50, 184)).toBe('Showing 1–50 of 184')
    expect(showingLabel(150, 34, 184)).toBe('Showing 151–184 of 184')
  })

  it('does not draw a range from a number to itself', () => {
    expect(showingLabel(50, 1, 51)).toBe('Showing 51 of 51')
  })

  /* A count that could not be read leaves the line saying only what it knows. */
  it('leaves the count off when there is none', () => {
    expect(showingLabel(0, 3, null)).toBe('Showing 1–3')
  })

  it('says nothing on an empty page', () => {
    expect(showingLabel(0, 0, 0)).toBe('')
  })
})

describe('searchWidth', () => {
  /* B12: one ch per character of the sentence, and the icon's inset on top. */
  it('is at least as wide as the placeholder, plus the icon', () => {
    expect(searchWidth('Search by number, customer or narration')).toBe(
      'calc(39ch + var(--space-10))',
    )
  })
})

/*
 * Two layout bugs that no rendered test can see, because no stylesheet loads in one. Each
 * test reads the rule that fixed it, so deleting or weakening the rule fails here.
 */
describe('the stylesheet', () => {
  const css = readFileSync(resolve('src/renderer/src/screens/screens.css'), 'utf8')

  const rule = (selector: string): string => {
    const start = css.indexOf(`${selector} {`)
    if (start < 0) throw new Error(`No rule for ${selector}`)
    return css.slice(start, css.indexOf('}', start))
  }

  /* B22: `.ledger-table td` set `start` and outranked the bare figure class. */
  it('right-aligns a figure column with a selector that outranks the cell rule', () => {
    expect(rule('.ledger-table .ledger-table__figure')).toMatch(/text-align:\s*end/)
    expect(css).not.toMatch(/\n\.ledger-table__figure \{[^}]*text-align/)
  })

  /* B17: `.toolbar` lines up bottom edges, which put "Show archived" below the search's text
   * line. A list's toolbar centres its row, and the hand-rolled toggle it used is gone. */
  it('centres a list toolbar, and has no second checkbox style', () => {
    expect(rule('.list__toolbar')).toMatch(/align-items:\s*center/)
    expect(css).not.toMatch(/\.toolbar__toggle/)
  })

  /* Negative money takes the negative ink on every report, not only on the Overview. */
  it('draws a negative figure cell in the negative ink', () => {
    expect(rule('.ledger-table .ledger-table__figure--negative')).toMatch(
      /color:\s*var\(--figure-negative\)/,
    )
  })

  /* A code in a table is set like a code in a field: mono, with a slashed zero. */
  it('sets a code column in the identifier face, and a date column in the figure one', () => {
    expect(rule('.ledger-table__code')).toMatch(/font-family:\s*var\(--font-mono\)/)
    expect(rule('.ledger-table__code')).toMatch(/var\(--numeric-identifier\)/)
    expect(rule('.ledger-table__date')).not.toMatch(/font-mono/)
  })

  /* At 1024 px a list's Archive and Delete were clipped by the card, with nothing to say so. */
  it('scrolls a wide table inside its card rather than clipping it', () => {
    expect(rule('.register')).toMatch(/overflow-x:\s*auto/)
    expect(rule('.register')).not.toMatch(/overflow:\s*hidden/)
  })

  /* The editor's visually hidden line labels escaped the grid's scroll box and gave the
   * whole window a sideways scrollbar. A positioned box contains them. */
  it('contains what is inside the line grid', () => {
    expect(rule('.editor__lines')).toMatch(/position:\s*relative/)
    expect(rule('.editor__lines')).toMatch(/overflow:\s*auto/)
  })
})
