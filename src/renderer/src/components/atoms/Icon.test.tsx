/*
 * The icon.
 *
 * Two things are worth pinning and neither is "it renders an svg".
 *
 * THE PATH COMES FROM THE NAME. `ICON_PATHS` is the only place glyph geometry lives,
 * and a component that drew the wrong entry would still draw something — so the `d` is
 * compared against the table, for two different names, rather than merely checked for
 * being non-empty.
 *
 * THE STROKE IS DERIVED FROM THE SIZE, by a compound expression with two boundaries.
 * Each boundary is tested from both sides, because a test that only ever passes 16 can
 * be satisfied by a function that returns 1.75 unconditionally.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ICON_PATHS } from '../../lib/icons'
import { Icon } from './Icon'

function svgOf(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('svg')
  if (!(svg instanceof SVGSVGElement)) throw new Error('No <svg> was rendered')
  return svg
}

describe('the glyph', () => {
  it('draws the path the name maps to', () => {
    const { container } = render(<Icon name="ledger" />)

    expect(svgOf(container).querySelector('path')).toHaveAttribute('d', ICON_PATHS.ledger)
  })

  /* A second name, because one name cannot tell a lookup from a constant. */
  it('draws a different path for a different name', () => {
    const { container } = render(<Icon name="lock" />)

    expect(svgOf(container).querySelector('path')).toHaveAttribute('d', ICON_PATHS.lock)
    expect(ICON_PATHS.lock).not.toBe(ICON_PATHS.ledger)
  })

  it('is drawn on the 24-grid whatever it is scaled to', () => {
    const { container } = render(<Icon name="check" size={40} />)

    expect(svgOf(container)).toHaveAttribute('viewBox', '0 0 24 24')
  })
})

describe('size', () => {
  it('is 16 square unless asked otherwise', () => {
    const { container } = render(<Icon name="check" />)

    const svg = svgOf(container)
    expect(svg).toHaveAttribute('width', '16')
    expect(svg).toHaveAttribute('height', '16')
  })

  it('takes the size it was given, on both axes', () => {
    const { container } = render(<Icon name="check" size={22} />)

    const svg = svgOf(container)
    expect(svg).toHaveAttribute('width', '22')
    expect(svg).toHaveAttribute('height', '22')
  })
})

/*
 * `strokeWidth ?? (size <= 14 ? 1.6 : size >= 22 ? 1.9 : 1.75)`.
 *
 * Three outcomes, two boundaries. 14 and 15 separate the thin branch from the middle
 * one; 21 and 22 separate the middle from the thick one. Without the pair on each side,
 * either comparison could be `<` instead of `<=` and nothing here would move.
 */
describe('stroke weight', () => {
  it.each([
    [12, '1.6'],
    [14, '1.6'],
    [15, '1.75'],
    [16, '1.75'],
    [21, '1.75'],
    [22, '1.9'],
    [24, '1.9'],
  ])('is %s px wide at stroke %s', (size, stroke) => {
    const { container } = render(<Icon name="check" size={size} />)

    expect(svgOf(container)).toHaveAttribute('stroke-width', stroke)
  })

  it('takes an explicit stroke over the one the size implies', () => {
    const { container } = render(<Icon name="check" size={12} strokeWidth={3} />)

    expect(svgOf(container)).toHaveAttribute('stroke-width', '3')
  })
})

describe('accessibility', () => {
  /*
   * Decorative by default, and that default is load-bearing: nearly every icon in the
   * product sits beside a label that already says the same thing, and an icon that
   * announces itself makes a screen reader read every button twice.
   */
  it('is hidden from assistive technology when it has no title', () => {
    const { container } = render(<Icon name="check" />)

    const svg = svgOf(container)
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).not.toHaveAttribute('role')
    expect(svg.querySelector('title')).toBeNull()
  })

  it('becomes an image with a name when it is given a title', () => {
    render(<Icon name="lock" title="Locked" />)

    const image = screen.getByRole('img', { name: 'Locked' })
    expect(image).not.toHaveAttribute('aria-hidden')
  })

  /* Never a tab stop. IE-era SVG defaults still bite in Chromium under some
   * settings, and a decorative glyph in the tab order is a keyboard trap nobody
   * can see. */
  it('is never focusable', () => {
    const { container } = render(<Icon name="check" title="Done" />)

    expect(svgOf(container)).toHaveAttribute('focusable', 'false')
  })

  it('carries an extra class when one is given', () => {
    const { container } = render(<Icon name="check" className="field__icon" />)

    expect(svgOf(container)).toHaveClass('field__icon')
  })
})
