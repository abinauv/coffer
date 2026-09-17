/*
 * Two layout rules that a screen test cannot see, read off the stylesheets.
 *
 * happy-dom lays nothing out, so neither of these failures reaches a rendered test: a
 * welcome screen pushed above the top of its canvas and a line grid whose price box shows
 * "82." both render every element a query can find. Both were found by driving the built
 * app at a real window size (B34, B35), and these hold the fixes.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const shell = readFileSync(resolve('src/renderer/src/styles/shell.css'), 'utf8')
const screens = readFileSync(resolve('src/renderer/src/screens/screens.css'), 'utf8')

/** Every declaration block for `selector`, joined — a class may be styled in two places. */
function rules(css: string, selector: string): string {
  const blocks: string[] = []
  const pattern = new RegExp(
    `(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`,
    'g',
  )
  for (const match of css.matchAll(pattern)) blocks.push(match[2] ?? '')
  return blocks.join('\n')
}

describe('the welcome canvas (B35)', () => {
  /* Centred without `safe`, a screen taller than the window overflows upwards as well as
   * down, and a canvas only scrolls down: the top of the recovery-codes step was
   * unreachable in a 900 px window. */
  it('centres only what fits, and starts at the top what does not', () => {
    const canvas = rules(shell, '.app__canvas')
    expect(canvas).toMatch(/align-items:\s*safe center/)
    expect(canvas).not.toMatch(/place-items:\s*center/)
  })
})

describe('the document line grid (B34)', () => {
  /* One minimum for the whole table let the word columns take the room and squeeze the
   * figures until a price read "82.". Each figure column holds its own width instead. */
  it('gives the table no single minimum width', () => {
    expect(rules(screens, '.editor__table')).not.toMatch(/min-width/)
  })

  it.each([
    [5, 'quantity'],
    [7, 'unit price'],
    [8, 'discount'],
    [9, 'tax rate'],
  ])('holds a width for column %i, the %s', (column) => {
    expect(rules(screens, `.editor__table td:nth-child(${String(column)}) .field`)).toMatch(
      /min-width:\s*\d/,
    )
  })

  it('never wraps a saved amount', () => {
    expect(rules(screens, '.editor__table td.editor__amount')).toMatch(/white-space:\s*nowrap/)
  })
})
