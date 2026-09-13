/*
 * The Coffer mark.
 *
 * Drawn rather than imported, which is what makes it worth a test at all: an `<img>`
 * would be an asset with an `alt`, and this is an inline `<svg>` sitting immediately
 * beside the product name in the title bar. So the thing that must be true is that it is
 * DECORATIVE — the name is already there in words, and a mark that announces itself
 * makes a screen reader read the product name twice at the top of every window.
 */

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BrandMark } from './BrandMark'

function markIn(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('svg')
  if (!(svg instanceof SVGSVGElement)) throw new Error('No mark was drawn')
  return svg
}

describe('BrandMark', () => {
  it('is hidden from assistive technology and out of the tab order', () => {
    const { container } = render(<BrandMark />)

    const mark = markIn(container)
    expect(mark).toHaveAttribute('aria-hidden', 'true')
    expect(mark).toHaveAttribute('focusable', 'false')
  })

  it('is 20 square unless a size is given', () => {
    const { container } = render(<BrandMark />)

    const mark = markIn(container)
    expect(mark).toHaveAttribute('width', '20')
    expect(mark).toHaveAttribute('height', '20')
  })

  it('takes the size it was given, on both axes', () => {
    const { container } = render(<BrandMark size={17} />)

    const mark = markIn(container)
    expect(mark).toHaveAttribute('width', '17')
    expect(mark).toHaveAttribute('height', '17')
  })

  it('scales rather than crops — the grid does not move with the size', () => {
    const { container } = render(<BrandMark size={64} />)

    expect(markIn(container)).toHaveAttribute('viewBox', '0 0 24 24')
  })

  it('carries an extra class beside its own', () => {
    const { container } = render(<BrandMark className="titlebar__mark" />)

    expect(markIn(container)).toHaveClass('brand-mark', 'titlebar__mark')
  })

  /* The strongbox, its two ledger rules and the dial. Each part carries its own class
   * because each takes its colour from a different token — a mark drawn as one path
   * would be a single flat silhouette. */
  it('draws the box, the rules and the dial as separately styled parts', () => {
    const { container } = render(<BrandMark />)

    const mark = markIn(container)
    expect(mark.querySelector('.brand-mark__body')?.tagName).toBe('rect')
    expect(mark.querySelector('.brand-mark__rules')?.tagName).toBe('path')
    expect(mark.querySelector('.brand-mark__dial')?.tagName).toBe('circle')
  })
})
