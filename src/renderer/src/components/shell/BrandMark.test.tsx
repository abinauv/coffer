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

  /* Two frames, each filled even-odd: without the rule a frame's hole is painted over and
   * the mark becomes two nested solid squares, which the brand sheet calls a stop button. */
  it('draws the outer and inner frames as even-odd paths', () => {
    const { container } = render(<BrandMark size={24} />)

    const mark = markIn(container)
    for (const part of ['.brand-mark__outer', '.brand-mark__inner']) {
      const path = mark.querySelector(part)
      expect(path?.tagName).toBe('path')
      expect(path).toHaveAttribute('fill-rule', 'evenodd')
    }
  })

  it('draws the inner square as a frame from 20px up', () => {
    const { container } = render(<BrandMark size={20} />)

    const mark = markIn(container)
    expect(mark).toHaveAttribute('data-inner', 'frame')
    /* An outside edge and a hole: two subpaths. */
    expect(mark.querySelector('.brand-mark__inner')?.getAttribute('d')?.match(/M/g)).toHaveLength(2)
  })

  it('fills the inner square below 20px, where a hole would close up', () => {
    const { container } = render(<BrandMark size={17} />)

    const mark = markIn(container)
    expect(mark).toHaveAttribute('data-inner', 'solid')
    expect(mark.querySelector('.brand-mark__inner')?.getAttribute('d')?.match(/M/g)).toHaveLength(1)
  })

  it('is never drawn below 16px', () => {
    const { container } = render(<BrandMark size={12} />)

    const mark = markIn(container)
    expect(mark).toHaveAttribute('width', '16')
    expect(mark).toHaveAttribute('height', '16')
  })
})
