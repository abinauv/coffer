/*
 * The mark's geometry.
 *
 * These pin the brand sheet's construction to the numbers the SVG, the packaging icon and
 * the launch assets are drawn from. A change to any of them is a change to the identity,
 * so it should fail here and be made on purpose.
 */

import { describe, expect, it } from 'vitest'
import {
  MARK_GRID,
  MARK_INNER,
  MARK_MIN_SIZE,
  MARK_OUTER,
  MARK_SOLID_BELOW,
  markPaths,
  markShapes,
  markSize,
  markSvg,
  rectPath,
} from './brand-mark'

/* The sheet draws on an 8×8 grid; the mark is drawn in a 24-unit box. */
const UNIT = MARK_GRID / 8

describe('the construction', () => {
  it('insets the outer frame 1 unit, 0.6 thick, with a 0.3 corner', () => {
    expect(MARK_OUTER.inset).toBeCloseTo(1 * UNIT)
    expect(MARK_OUTER.stroke).toBeCloseTo(0.6 * UNIT)
    expect(MARK_OUTER.radius).toBeCloseTo(0.3 * UNIT)
  })

  it('insets the inner frame 3 units, 0.6 thick, with a sharper 0.1 corner', () => {
    expect(MARK_INNER.inset).toBeCloseTo(3 * UNIT)
    expect(MARK_INNER.stroke).toBeCloseTo(0.6 * UNIT)
    expect(MARK_INNER.radius).toBeCloseTo(0.1 * UNIT)
    expect(MARK_INNER.radius).toBeLessThan(MARK_OUTER.radius)
  })

  it('is centred: every shape is a square the same distance from both edges', () => {
    const shapes = markShapes(64)
    const rects = [
      shapes.outer.outside,
      shapes.outer.hole,
      shapes.inner.outside,
      ...(shapes.inner.solid ? [] : [shapes.inner.hole]),
    ]
    for (const rect of rects) {
      expect(rect.x).toBe(rect.y)
      expect(rect.x + rect.size + rect.x).toBeCloseTo(MARK_GRID)
    }
  })

  it('keeps the stroke inside each frame, the way a border does', () => {
    const { outer } = markShapes(64)
    expect(outer.hole.x - outer.outside.x).toBeCloseTo(MARK_OUTER.stroke)
    expect(outer.hole.radius).toBe(0)
  })
})

describe('sizes', () => {
  it('never draws below 16px', () => {
    expect(markSize(8)).toBe(MARK_MIN_SIZE)
    expect(markSize(Number.NaN)).toBe(MARK_MIN_SIZE)
    expect(markSize(17)).toBe(17)
  })

  it('draws the inner square as a frame from 20px', () => {
    expect(markShapes(MARK_SOLID_BELOW).inner.solid).toBe(false)
  })

  it('fills the inner square below 20px', () => {
    expect(markShapes(MARK_SOLID_BELOW - 1).inner.solid).toBe(true)
  })

  it('holds the outer frame at two device pixels when small', () => {
    const { outer } = markShapes(16)
    const strokePx = ((outer.hole.x - outer.outside.x) * 16) / MARK_GRID
    expect(strokePx).toBeCloseTo(2)
  })

  it('leaves a visible gap between the frame and a solid inner square at 16px', () => {
    const { outer, inner } = markShapes(16)
    const gapPx = ((inner.outside.x - outer.hole.x) * 16) / MARK_GRID
    expect(gapPx).toBeGreaterThanOrEqual(2)
  })

  it('uses the construction stroke at larger sizes', () => {
    const { outer } = markShapes(128)
    expect(outer.hole.x - outer.outside.x).toBeCloseTo(MARK_OUTER.stroke)
  })
})

describe('paths', () => {
  it('draws a square corner with straight lines only', () => {
    expect(rectPath({ x: 1, y: 1, size: 2, radius: 0 })).toBe('M1 1H3V3H1Z')
  })

  it('draws a rounded corner with four arcs', () => {
    expect(rectPath({ x: 0, y: 0, size: 4, radius: 1 }).match(/A/g)).toHaveLength(4)
  })

  it('gives each frame an outside and a hole', () => {
    const paths = markPaths(24)
    expect(paths.outer.match(/M/g)).toHaveLength(2)
    expect(paths.inner.match(/M/g)).toHaveLength(2)
  })

  it('builds a standalone SVG in the colour asked for, filled even-odd', () => {
    const svg = markSvg(88, '#FFFFFF')
    expect(svg).toContain('viewBox="0 0 24 24"')
    expect(svg).toContain('width="88"')
    expect(svg.match(/fill="#FFFFFF"/g)).toHaveLength(2)
    expect(svg.match(/fill-rule="evenodd"/g)).toHaveLength(2)
  })
})
