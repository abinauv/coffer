/*
 * The passphrase strength meter, rendered.
 *
 * `meterView` is covered as a pure function in ../lib/passphrase-meter.test.ts. What is
 * covered only here is the drawing: that the verdict reaches the accessibility tree in
 * WORDS as well as in colour, that the lit segments are the ones at the LEFT of the bar
 * and not merely the right number of them, and that the meter does exactly what it says
 * it does and nothing more.
 *
 * IT REPORTS. IT NEVER REFUSES. SECURITY.md counts accepting a weak passphrase silently
 * as a vulnerability and ARCHITECTURE §6.3.1 rules out the obvious "fix" of refusing
 * one, because there is nobody to appeal to afterwards. So the strongest thing this
 * component may do is choose a colour and write a sentence, and the test that matters
 * most is the one saying it offers no control at all.
 */

import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { PassphraseStrength } from '@shared/dto'
import { METER_SEGMENTS } from '../lib/passphrase-meter'
import { StrengthMeter } from './StrengthMeter'

function strength(
  score: PassphraseStrength['score'],
  label: string,
  isWeak: boolean,
  suggestion: string | null = null,
): PassphraseStrength {
  return { score, label, suggestion, isWeak }
}

/** The bar's segments, in order, as 'true'/'false' — which ones are lit and where. */
function segmentsIn(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('.strength__segment')].map((segment) =>
    segment.getAttribute('data-filled'),
  )
}

function meter(): HTMLElement {
  return screen.getByRole('meter', { name: 'Passphrase strength' })
}

describe('StrengthMeter', () => {
  it('draws nothing before anything is typed', () => {
    /* Not an empty bar: an empty bar beside an empty field reads as a verdict of
     * "worst possible", which is a judgement on nothing. */
    const { container } = render(<StrengthMeter strength={null} passphrase="" />)

    expect(container).toBeEmptyDOMElement()
  })

  it('waits rather than flashing a verdict it does not have', () => {
    /* The real state between a keystroke and main's answer: something typed, nothing
     * scored yet. The meter is one IPC round trip behind and must say so. */
    const { container } = render(<StrengthMeter strength={null} passphrase="pass" />)

    expect(meter()).toHaveAttribute('aria-valuenow', '0')
    expect(meter()).toHaveAttribute('aria-valuetext', 'Checking this passphrase')
    expect(segmentsIn(container).every((state) => state === 'false')).toBe(true)
    /* No label and no advice — there is no verdict to give one. */
    expect(container.querySelector('.strength__label')).toBeNull()
    expect(container.querySelector('.strength__advice')).toBeNull()
  })

  it('draws a bar even for a passphrase that is only a space', () => {
    /* `passphrase === ''` is the only thing that hides the meter, and a space is not
     * it. A field holding one space is a field somebody has typed in. */
    render(<StrengthMeter strength={strength(0, 'Very weak', true)} passphrase=" " />)

    expect(meter()).toBeInTheDocument()
  })

  it('lights the segments from the left, not merely the right number of them', () => {
    /* Positional. `filled` alone is satisfied by a bar that lights the LAST n, which
     * reads as a full bar with a gap in it. */
    const weak = render(<StrengthMeter strength={strength(0, 'Very weak', true)} passphrase="a" />)
    expect(segmentsIn(weak.container)).toEqual(['true', 'false', 'false', 'false', 'false'])
    weak.unmount()

    const strong = render(<StrengthMeter strength={strength(3, 'Strong', false)} passphrase="a" />)
    expect(segmentsIn(strong.container)).toEqual(['true', 'true', 'true', 'true', 'false'])
    strong.unmount()

    const best = render(
      <StrengthMeter strength={strength(4, 'Very strong', false)} passphrase="a" />,
    )
    expect(segmentsIn(best.container)).toEqual(['true', 'true', 'true', 'true', 'true'])
    expect(segmentsIn(best.container)).toHaveLength(METER_SEGMENTS)
  })

  it('states the range and the reading it drew', () => {
    render(<StrengthMeter strength={strength(2, 'Fair', true)} passphrase="a" />)

    /* Score 2 of 0..4 lights three of five. The numbers are asserted together because
     * a reading without its range says nothing — 3 out of what? */
    expect(meter()).toHaveAttribute('aria-valuemin', '0')
    expect(meter()).toHaveAttribute('aria-valuemax', String(METER_SEGMENTS))
    expect(meter()).toHaveAttribute('aria-valuenow', '3')
  })

  it('announces the verdict in words as well as in colour', () => {
    /* Three tones, and each one's LABEL is a different word from the tone name — so a
     * component that announced its own tone instead of main's verdict is visible.
     * A five-segment bar shading red to teal is not a message everyone receives. */
    const cases: ReadonlyArray<readonly [PassphraseStrength, string]> = [
      [strength(1, 'Weak', true), 'negative'],
      [strength(2, 'Fair', true), 'warning'],
      [strength(4, 'Very strong', false), 'positive'],
    ]

    for (const [value, tone] of cases) {
      const { container, unmount } = render(<StrengthMeter strength={value} passphrase="a" />)

      expect(meter(), value.label).toHaveAttribute('aria-valuetext', `${value.label} passphrase`)
      expect(within(container).getByText(value.label)).toBeInTheDocument()
      /* The colour, alongside the words rather than instead of them. */
      expect(meter().getAttribute('data-tone'), value.label).toBe(tone)
      unmount()
    }
  })

  it("passes main's one suggestion through unchanged", () => {
    const advice = 'Add two more words. Length beats symbols, and it beats them badly.'
    render(<StrengthMeter strength={strength(1, 'Weak', true, advice)} passphrase="a" />)

    /* Word for word. The renderer does not score passphrases and does not write advice
     * about them either — that is main's, out of src/main/companies/passphrase.ts. */
    expect(screen.getByText(advice)).toBeInTheDocument()
  })

  it('says nothing where there is nothing to add', () => {
    const { container } = render(
      <StrengthMeter strength={strength(4, 'Very strong', false, null)} passphrase="a" />,
    )

    /* The verdict is still there; only the advice is absent. Asserted together, so
     * "nothing rendered at all" cannot pass this. */
    expect(screen.getByText('Very strong')).toBeInTheDocument()
    expect(container.querySelector('.strength__advice')).toBeNull()
  })

  it('draws the score it was given, not the flag beside it', () => {
    /* A bad state handed over directly: a top score flagged weak. The two disagree only
     * because main is the one that decides, and this component draws the reading — a
     * meter that switched to the flag would show a full bar in a warning colour, or an
     * empty bar under the words "Very strong". */
    const { container } = render(
      <StrengthMeter strength={strength(4, 'Very strong', true)} passphrase="a" />,
    )

    expect(segmentsIn(container)).toEqual(['true', 'true', 'true', 'true', 'true'])
    expect(meter()).toHaveAttribute('data-tone', 'positive')
    expect(screen.getByText('Very strong')).toBeInTheDocument()
  })

  it('offers no way to refuse a passphrase', () => {
    /* THE LOCKED DECISION. The meter reports; it never disables a button, never rejects
     * a passphrase and never withholds a warning. Anything focusable added here would
     * be a control on the strength of a secret, which is the thing that must not exist
     * — a user refused their own passphrase has nobody to appeal to. */
    const { container } = render(
      <StrengthMeter
        strength={strength(0, 'Very weak', true, 'Add two more words.')}
        passphrase="password1"
      />,
    )

    expect(
      container.querySelectorAll('button, input, a, [disabled], [aria-disabled]'),
    ).toHaveLength(0)
    /* And it did warn — the other half of the same decision. */
    expect(screen.getByText('Very weak')).toBeInTheDocument()
    expect(screen.getByText('Add two more words.')).toBeInTheDocument()
  })

  it('never renders the passphrase it is describing', () => {
    const secret = 'correct-horse-battery-staple'
    const { container } = render(
      <StrengthMeter strength={strength(3, 'Strong', false)} passphrase={secret} />,
    )

    /* The meter is handed the passphrase and uses it for one thing: deciding whether
     * anything has been typed. It must not appear in the markup — not as text, not in
     * an aria-label, not in a data attribute. */
    expect(container.innerHTML).not.toContain(secret)
  })
})
