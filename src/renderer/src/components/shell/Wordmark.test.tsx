/*
 * The horizontal lockup.
 *
 * What must hold is that the name is readable text and the mark beside it is not read at
 * all, so assistive technology hears the product once.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BRAND } from '../../../../branding'
import { Wordmark } from './Wordmark'

describe('Wordmark', () => {
  it('says the product name in words', () => {
    render(<Wordmark />)

    expect(screen.getByText(BRAND.name)).toHaveClass('wordmark__name')
  })

  it('draws the mark beside the name, hidden from assistive technology', () => {
    const { container } = render(<Wordmark />)

    const mark = container.querySelector('.brand-mark')
    expect(mark).toHaveAttribute('aria-hidden', 'true')
    expect(mark).toHaveAttribute('width', '17')
  })

  it('takes the mark size it was given', () => {
    const { container } = render(<Wordmark markSize={32} />)

    expect(container.querySelector('.brand-mark')).toHaveAttribute('width', '32')
  })

  it('carries an extra class beside its own', () => {
    const { container } = render(<Wordmark className="titlebar__wordmark" />)

    expect(container.firstElementChild).toHaveClass('wordmark', 'titlebar__wordmark')
  })
})
