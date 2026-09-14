/*
 * The density floors, held against the stylesheet itself.
 *
 * WHY THE CSS AND NOT A COMPUTED STYLE. No stylesheet is loaded in a renderer test, so a
 * computed `min-height` would be empty whatever tokens.css said. The rule this guards is a
 * rule about token values, so the test reads the tokens.
 *
 * The rules, from the design system (§02) and docs/design.md §4:
 *
 *   - Compact never shrinks a hit target below 24px. Every height it sets is at least
 *     `--hit-min`. The handoff shipped `--control-height-sm: 22px`, which this caught (B11).
 *   - Compact never shrinks type. It may move padding and heights and nothing else, so no
 *     type token appears in its block at all.
 *   - Density is four numbers. The compact block redefines only density tokens.
 */

import { describe, expect, it } from 'vitest'
import tokens from './tokens.css?raw'

/** The declarations inside the first rule whose selector is exactly `selector`. */
function block(selector: string): Map<string, string> {
  const start = tokens.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`tokens.css has no ${selector} block`)
  const body = tokens.slice(tokens.indexOf('{', start) + 1, tokens.indexOf('}', start))
  const declarations = new Map<string, string>()
  for (const match of body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    declarations.set(match[1] ?? '', (match[2] ?? '').trim())
  }
  return declarations
}

/** A token's value in pixels, following one `var()` and reading `rem` at 16px. */
function px(value: string, scope: Map<string, string>, root: Map<string, string>): number {
  const reference = /^var\((--[\w-]+)\)$/.exec(value)
  if (reference) {
    const name = reference[1] ?? ''
    const resolved = scope.get(name) ?? root.get(name)
    if (resolved === undefined) throw new Error(`${name} is not defined`)
    return px(resolved, scope, root)
  }
  const pixels = /^(-?[\d.]+)px$/.exec(value)
  if (pixels) return Number(pixels[1])
  const rems = /^(-?[\d.]+)rem$/.exec(value)
  if (rems) return Number(rems[1]) * 16
  throw new Error(`cannot read "${value}" as a length`)
}

const root = block(':root')
const compact = block(":root[data-density='compact']")

describe('the compact density', () => {
  it('keeps every control and row at or above the hit minimum', () => {
    const hitMin = px(root.get('--hit-min') ?? '', root, root)
    expect(hitMin).toBe(24)

    for (const name of ['--control-height', '--control-height-sm', '--row-height']) {
      const value = compact.get(name)
      expect(value, `${name} is set by compact`).toBeDefined()
      expect(px(value ?? '', compact, root), name).toBeGreaterThanOrEqual(hitMin)
    }
  })

  it('does not touch type', () => {
    const typeTokens = [...compact.keys()].filter((name) =>
      /^--(text|leading|weight|tracking|font)/.test(name),
    )
    expect(typeTokens).toEqual([])
  })

  it('moves only density numbers', () => {
    expect([...compact.keys()].sort()).toEqual(
      [
        '--control-height',
        '--control-height-sm',
        '--row-height',
        '--row-pad-x',
        '--row-pad-y',
        '--screen-pad',
      ].sort(),
    )
  })
})

describe('the comfortable density', () => {
  it('keeps every control and row at or above the hit minimum too', () => {
    for (const name of ['--control-height', '--control-height-sm', '--row-height']) {
      expect(px(root.get(name) ?? '', root, root), name).toBeGreaterThanOrEqual(24)
    }
  })
})

describe('type', () => {
  /* 11px exists for keycaps and column micro-labels, and the tokens file says so beside
   * it: never a sentence. Everything else meets the 12px floor. */
  it('sets no type token below 12px except the one reserved for keycaps and micro-labels', () => {
    const small = [...root.entries()]
      .filter(([name]) => name.startsWith('--text-'))
      .filter(([, value]) => px(value, root, root) < 12)
      .map(([name]) => name)
    expect(small).toEqual(['--text-2xs'])
  })
})
