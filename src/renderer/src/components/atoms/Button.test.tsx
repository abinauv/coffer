/*
 * The button.
 *
 * Variants and sizes are iterated from TOTAL RECORDS over their unions, so a fifth
 * variant added later fails to compile here until it is answered for (CONVENTIONS §1.9).
 *
 * Two behaviours get more than a class assertion, because both have bitten real
 * products:
 *
 *   THE DISABLED GUARD IS A COMPOUND — `disabled === true || isBusy`. Each half is
 *   given the input the OTHER half excludes: disabled alone, and busy alone. Testing
 *   only the pair passes against a component that reads one of them.
 *
 *   THE TYPE DEFAULTS TO `button`, NOT `submit`. A shell full of accidental form
 *   submits is the bug the explicit default prevents, so the default is asserted
 *   against a real `<form>` rather than by reading the attribute back.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ICON_PATHS } from '../../lib/icons'
import { Button, IconButton, type ButtonSize, type ButtonVariant } from './Button'

const VARIANTS: Readonly<Record<ButtonVariant, null>> = {
  primary: null,
  secondary: null,
  ghost: null,
  danger: null,
}

const SIZES: Readonly<Record<ButtonSize, null>> = { sm: null, md: null }

const EVERY_VARIANT = Object.keys(VARIANTS) as readonly ButtonVariant[]
const EVERY_SIZE = Object.keys(SIZES) as readonly ButtonSize[]

describe('variant and size', () => {
  it.each(EVERY_VARIANT)('carries the %s modifier beside the base class', (variant) => {
    render(<Button variant={variant}>Post</Button>)

    expect(screen.getByRole('button', { name: 'Post' })).toHaveClass('button', `button--${variant}`)
  })

  it.each(EVERY_SIZE)('carries the %s modifier', (size) => {
    render(<Button size={size}>Post</Button>)

    expect(screen.getByRole('button', { name: 'Post' })).toHaveClass(`button--${size}`)
  })

  it('is a medium secondary button when nothing is asked for', () => {
    render(<Button>Post</Button>)

    expect(screen.getByRole('button', { name: 'Post' })).toHaveClass(
      'button--secondary',
      'button--md',
    )
  })

  it('scales the icon down with the button', () => {
    const { rerender } = render(
      <Button size="md" icon="plus">
        Add a line
      </Button>,
    )
    expect(screen.getByRole('button', { name: 'Add a line' }).querySelector('svg')).toHaveAttribute(
      'width',
      '16',
    )

    rerender(
      <Button size="sm" icon="plus">
        Add a line
      </Button>,
    )
    expect(screen.getByRole('button', { name: 'Add a line' }).querySelector('svg')).toHaveAttribute(
      'width',
      '14',
    )
  })

  it('takes a full-width modifier only when asked', () => {
    const { rerender } = render(<Button>Post</Button>)
    expect(screen.getByRole('button', { name: 'Post' })).not.toHaveClass('button--full')

    rerender(<Button isFullWidth>Post</Button>)
    expect(screen.getByRole('button', { name: 'Post' })).toHaveClass('button--full')
  })

  it('sets an identifier in its own face only when asked', () => {
    const { rerender } = render(<Button>INV/2026-27/0001</Button>)
    expect(screen.getByRole('button')).not.toHaveClass('button--identifier')

    rerender(<Button isIdentifier>INV/2026-27/0001</Button>)
    expect(screen.getByRole('button', { name: 'INV/2026-27/0001' })).toHaveClass(
      'button--identifier',
    )
  })

  it('appends an extra class without dropping its own', () => {
    render(<Button className="editor__save">Post</Button>)

    expect(screen.getByRole('button', { name: 'Post' })).toHaveClass('button', 'editor__save')
  })
})

describe('the icon slots', () => {
  /*
   * BY POSITION, not by presence. A leading icon found "somewhere in the button" is
   * found just as happily when the two slots have been swapped, and the two icons are
   * deliberately different so the swap is visible.
   */
  it('puts the leading icon before the label and the trailing one after it', () => {
    render(
      <Button icon="plus" iconEnd="chevron-down">
        Add a line
      </Button>,
    )

    const button = screen.getByRole('button', { name: 'Add a line' })
    const children = [...button.children]
    expect(children).toHaveLength(3)
    expect(children[0]?.querySelector('path')).toHaveAttribute('d', ICON_PATHS.plus)
    expect(children[1]).toHaveTextContent('Add a line')
    expect(children[2]?.querySelector('path')).toHaveAttribute('d', ICON_PATHS['chevron-down'])
  })

  it('draws only the label when neither slot is filled', () => {
    render(<Button>Post</Button>)

    const button = screen.getByRole('button', { name: 'Post' })
    expect(button.querySelectorAll('svg')).toHaveLength(0)
    expect(button.querySelector('.button__label')).toHaveTextContent('Post')
  })

  it('is marked icon-only when it has no label, and not when it has one', () => {
    const { rerender } = render(<Button icon="close" aria-label="Close" />)
    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass('button--icon-only')

    rerender(<Button icon="close">Close</Button>)
    expect(screen.getByRole('button', { name: 'Close' })).not.toHaveClass('button--icon-only')
  })
})

describe('disabled and busy', () => {
  it('does not fire onClick when it is disabled and not busy', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <Button disabled onClick={onClick}>
        Post
      </Button>,
    )

    const button = screen.getByRole('button', { name: 'Post' })
    expect(button).toBeDisabled()
    await user.click(button)

    expect(onClick).not.toHaveBeenCalled()
  })

  /* The other half of the compound: not disabled, only busy. */
  it('does not fire onClick when it is busy and not disabled', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <Button isBusy onClick={onClick}>
        Post
      </Button>,
    )

    const button = screen.getByRole('button', { name: 'Post' })
    expect(button).toBeDisabled()
    await user.click(button)

    expect(onClick).not.toHaveBeenCalled()
  })

  it('fires onClick when it is neither', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Post</Button>)

    await user.click(screen.getByRole('button', { name: 'Post' }))

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('announces progress while busy, and keeps the label so the width holds', () => {
    render(<Button isBusy>Posting</Button>)

    const button = screen.getByRole('button', { name: 'Posting' })
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveTextContent('Posting')
  })

  it('claims no busy state when it is merely disabled', () => {
    render(<Button disabled>Post</Button>)

    expect(screen.getByRole('button', { name: 'Post' })).not.toHaveAttribute('aria-busy')
  })

  /* The design system's rule: work that can fail keeps its label and swaps its icon for a
   * spinner. The spinner is decorative — `aria-busy` is what is announced — so it must not
   * change the accessible name. */
  it('swaps the leading icon for a spinner while busy, leaving the name alone', () => {
    const { container } = render(
      <Button icon="archive" isBusy>
        Back up now
      </Button>,
    )

    const button = screen.getByRole('button', { name: 'Back up now' })
    expect(container.querySelector('svg')).toBeNull()
    expect(button.querySelector('.button__spinner')).toHaveAttribute('aria-hidden', 'true')
  })

  it('leads the label with a spinner while busy when it has no icon', () => {
    render(<Button isBusy>Create company</Button>)

    const button = screen.getByRole('button', { name: 'Create company' })
    expect(button.firstElementChild).toHaveClass('button__spinner')
  })

  it('keeps a trailing icon while busy, since it is not the one the spinner replaces', () => {
    const { container } = render(
      <Button iconEnd="arrow-right" isBusy>
        Open
      </Button>,
    )

    expect(container.querySelectorAll('svg')).toHaveLength(1)
    expect(container.querySelector('.button__spinner')).not.toBeNull()
  })

  it('draws no spinner when it is not busy', () => {
    const { container } = render(<Button icon="archive">Back up now</Button>)

    expect(container.querySelector('.button__spinner')).toBeNull()
  })
})

describe('the form type', () => {
  it('does not submit the form it happens to be inside', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <Button>Add a line</Button>
      </form>,
    )

    await user.click(screen.getByRole('button', { name: 'Add a line' }))

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits when it is asked to be a submit button', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit">Save</Button>
      </form>,
    )

    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})

describe('IconButton', () => {
  /* An icon alone has no accessible name, so the label is not optional — this is the
   * assertion that would fail if it ever became so. */
  it('takes its accessible name from the label it demands', () => {
    render(<IconButton icon="close" label="Dismiss notification" />)

    const button = screen.getByRole('button', { name: 'Dismiss notification' })
    expect(button.querySelector('path')).toHaveAttribute('d', ICON_PATHS.close)
    expect(button).toHaveClass('button--icon-only')
  })

  it('passes its variant and size through to the button beneath', () => {
    render(<IconButton icon="close" label="Close" variant="ghost" size="sm" />)

    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass('button--ghost', 'button--sm')
  })

  it('does not fire when it is disabled', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<IconButton icon="close" label="Close" disabled onClick={onClick} />)

    await user.click(screen.getByRole('button', { name: 'Close' }))

    expect(onClick).not.toHaveBeenCalled()
  })
})
