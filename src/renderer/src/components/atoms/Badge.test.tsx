/*
 * The status pill.
 *
 * `BadgeTone` is a closed union, so the tones are iterated from a TOTAL RECORD rather
 * than listed in the test body (CONVENTIONS §1.9). Adding a sixth tone to the union
 * fails to compile here until it is answered for, which is the whole point — a tone
 * listed by hand is a tone that gets forgotten, and a badge whose modifier class does
 * not exist is invisible rather than wrong.
 *
 * The claim being tested is the one in the component's own doc comment: TONE IS NEVER
 * THE ONLY SIGNAL. So every tone is checked for its label as well as its class.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ICON_PATHS } from '../../lib/icons'
import { Badge, type BadgeTone } from './Badge'

/* Total over the union. The values are unused; the KEYS are the fixture. */
const TONES: Readonly<Record<BadgeTone, null>> = {
  neutral: null,
  accent: null,
  positive: null,
  negative: null,
  warning: null,
}

const EVERY_TONE = Object.keys(TONES) as readonly BadgeTone[]

describe('tone', () => {
  it.each(EVERY_TONE)('carries the %s modifier beside the base class', (tone) => {
    render(<Badge tone={tone}>Overdue</Badge>)

    const badge = screen.getByText('Overdue')
    expect(badge).toHaveClass('badge', `badge--${tone}`)
  })

  it.each(EVERY_TONE)('says the state in words as well as in colour (%s)', (tone) => {
    render(<Badge tone={tone}>Overdue</Badge>)

    /* Colour-blind, monochrome print, a screen reader: the word has to be there. */
    expect(screen.getByText('Overdue')).toBeVisible()
  })

  it('is neutral when no tone is given', () => {
    render(<Badge>Draft</Badge>)

    expect(screen.getByText('Draft')).toHaveClass('badge--neutral')
  })

  it('covers every member of the union', () => {
    /* If this number and the union ever disagree, the record above stops compiling
     * first — this is here so a reader can see how many tones there are. */
    expect(EVERY_TONE).toHaveLength(5)
  })
})

describe('the icon slot', () => {
  it('draws the icon it was named, and hides it from assistive technology', () => {
    render(
      <Badge tone="negative" icon="alert-circle">
        Overdue
      </Badge>,
    )

    const badge = screen.getByText('Overdue')
    const svg = badge.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.querySelector('path')).toHaveAttribute('d', ICON_PATHS['alert-circle'])
    /* Decorative beside a label that already says it — announcing both says it twice. */
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    /* The pill reads as one word, not as an icon and then the same word again. */
    expect(badge.textContent).toBe('Overdue')
  })

  it('draws nothing when no icon is named', () => {
    render(<Badge tone="positive">Paid</Badge>)

    expect(screen.getByText('Paid').querySelector('svg')).toBeNull()
  })
})

describe('the class list', () => {
  it('appends an extra class without dropping its own', () => {
    render(
      <Badge tone="warning" className="ledger__flag">
        Part paid
      </Badge>,
    )

    expect(screen.getByText('Part paid')).toHaveClass('badge', 'badge--warning', 'ledger__flag')
  })

  it('leaves no empty class behind when none is given', () => {
    render(<Badge tone="accent">Issued</Badge>)

    expect(screen.getByText('Issued').className).toBe('badge badge--accent')
  })
})

describe('struck through', () => {
  /* A cancelled document is voided, not in trouble. The strike carries that without a
   * colour, so it must be its own class beside the tone rather than a tone of its own. */
  it('strikes a voided status through, beside its tone', () => {
    render(
      <Badge tone="neutral" isStruck>
        Cancelled
      </Badge>,
    )

    expect(screen.getByText('Cancelled')).toHaveClass('badge', 'badge--neutral', 'badge--struck')
  })

  it('is not struck unless asked', () => {
    render(<Badge tone="neutral">Draft</Badge>)

    expect(screen.getByText('Draft')).not.toHaveClass('badge--struck')
  })
})
