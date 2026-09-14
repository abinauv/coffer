/*
 * The empty state.
 *
 * What must hold: the title is the element the caller asked for (a heading on one screen
 * and a sentence under a heading on another), the mark is not read out, and the action and
 * shortcut appear only when given.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('makes the title a heading when the page asks for one', () => {
    render(<EmptyState title="No companies yet" titleAs="h2" />)

    expect(screen.getByRole('heading', { level: 2, name: 'No companies yet' })).toBeVisible()
  })

  /* Under a section that already has a heading, the sentence must not add a level. */
  it('leaves the title a sentence when it sits under a heading already', () => {
    render(<EmptyState title="Nothing has been raised yet" titleAs="p" />)

    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.getByText('Nothing has been raised yet').tagName).toBe('P')
  })

  it('draws the mark for the eye only', () => {
    const { container } = render(<EmptyState title="No sales invoices yet" titleAs="h2" />)

    expect(container.querySelector('.empty__mark')).toHaveAttribute('aria-hidden', 'true')
  })

  it('shows the body, the one action and its key when they are given', () => {
    render(
      <EmptyState
        title="No sales invoices yet"
        titleAs="h2"
        action={<button type="button">New sales invoice</button>}
        shortcut="or press N"
      >
        <p>Raise the first one and it appears here, newest first.</p>
      </EmptyState>,
    )

    expect(screen.getByText('Raise the first one and it appears here, newest first.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'New sales invoice' })).toBeVisible()
    expect(screen.getByText('or press N')).toBeVisible()
  })

  it('leaves out every part that was not given', () => {
    const { container } = render(<EmptyState title="No units yet" titleAs="h2" />)

    expect(container.querySelector('.empty__body')).toBeNull()
    expect(container.querySelector('.empty__actions')).toBeNull()
    expect(container.querySelector('.empty__shortcut')).toBeNull()
  })
})
