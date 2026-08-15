import { describe, expect, it } from 'vitest'
import type { PassphraseStrength } from '@shared/dto'
import { METER_SEGMENTS, meterView, NO_RESET_WARNING, weakConfirmBody } from './passphrase-meter'

function strength(
  score: PassphraseStrength['score'],
  label: string,
  isWeak: boolean,
  suggestion: string | null = null,
): PassphraseStrength {
  return { score, label, suggestion, isWeak }
}

describe('meterView', () => {
  it('shows nothing before anything is typed', () => {
    const view = meterView(null, '')
    expect(view.filled).toBe(0)
    expect(view.label).toBeNull()
    expect(view.tone).toBe('empty')
  })

  it('shows nothing while the answer is still in flight', () => {
    const view = meterView(null, 'half a passphrase')
    expect(view.filled).toBe(0)
    expect(view.valueText).toContain('Checking')
  })

  it('lights one segment even at the bottom of the scale', () => {
    expect(meterView(strength(0, 'Very weak', true), 'a').filled).toBe(1)
  })

  it('fills the bar at the top of the scale', () => {
    expect(meterView(strength(4, 'Very strong', false), 'x').filled).toBe(METER_SEGMENTS)
  })

  it('maps the score onto three tones', () => {
    expect(meterView(strength(0, 'Very weak', true), 'x').tone).toBe('negative')
    expect(meterView(strength(1, 'Weak', true), 'x').tone).toBe('negative')
    expect(meterView(strength(2, 'Fair', true), 'x').tone).toBe('warning')
    expect(meterView(strength(3, 'Strong', false), 'x').tone).toBe('positive')
    expect(meterView(strength(4, 'Very strong', false), 'x').tone).toBe('positive')
  })

  it("passes main's one suggestion through unchanged", () => {
    const view = meterView(strength(1, 'Weak', true, 'Make it longer.'), 'x')
    expect(view.advice).toBe('Make it longer.')
  })

  it('carries the weak flag without acting on it', () => {
    expect(meterView(strength(2, 'Fair', true), 'x').isWeak).toBe(true)
    expect(meterView(strength(3, 'Strong', false), 'x').isWeak).toBe(false)
  })

  it('announces the verdict in words, not only in colour', () => {
    expect(meterView(strength(1, 'Weak', true), 'x').valueText).toBe('Weak passphrase')
  })
})

describe('the warning copy', () => {
  it('says plainly that nobody can reset the passphrase, including us', () => {
    expect(NO_RESET_WARNING).toContain('Nobody can reset this passphrase')
    expect(NO_RESET_WARNING).toContain('not the people who wrote it')
    expect(NO_RESET_WARNING).toContain('recovery codes')
  })

  it('offers a way through rather than a refusal', () => {
    const body = weakConfirmBody(strength(1, 'Weak', true))
    expect(body).toContain('You can use it anyway')
    expect(body).toContain('nobody can reset it')
  })

  it('still reads sensibly when the meter has not answered', () => {
    expect(weakConfirmBody(null)).toContain('This passphrase')
  })
})
