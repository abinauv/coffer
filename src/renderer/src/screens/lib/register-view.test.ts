import { describe, expect, it } from 'vitest'
import { searchWidth, showingLabel } from './register-view'

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
