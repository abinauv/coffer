/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PassphraseStrength } from '@shared/dto'
import {
  METER_SEGMENTS,
  METER_TONES,
  meterView,
  NO_RESET_WARNING,
  weakConfirmBody,
} from './passphrase-meter'

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

/*
 * THE TONES AND THE STYLESHEET, HELD TOGETHER (B9). The meter wrote negative, warning and
 * positive while screens.css styled weak, fair and strong, so no bar ever filled and the
 * label said "Very strong" over five grey dashes. Read from disk: vitest hands a stylesheet
 * import back empty, and this is a claim about the file.
 */
describe('the stylesheet', () => {
  /* From the repository root, where vitest runs: under happy-dom `import.meta.url` is not a
   * file URL. */
  const css = readFileSync(resolve('src/renderer/src/screens/screens.css'), 'utf8')

  it('fills the bar for every tone the meter can write', () => {
    for (const tone of METER_TONES.filter((name) => name !== 'empty')) {
      expect(css, tone).toContain(
        `.strength__bar[data-tone='${tone}'] .strength__segment[data-filled='true']`,
      )
    }
  })

  it('styles no tone the meter never writes', () => {
    const styled = [...css.matchAll(/\.strength__bar\[data-tone='([a-z]+)'\]/g)].map((m) => m[1])
    for (const tone of styled) {
      expect(METER_TONES as readonly string[], String(tone)).toContain(tone)
    }
  })

  it('writes the tones the stylesheet expects from real strengths', () => {
    const tones = ([0, 2, 4] as const).map(
      (score) =>
        meterView({ score, label: 'x', suggestion: null, isWeak: score < 2 }, 'typed').tone,
    )
    expect(tones).toEqual(['negative', 'warning', 'positive'])
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
