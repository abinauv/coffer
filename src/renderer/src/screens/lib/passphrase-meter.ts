/*
 * Turning `PassphraseStrength` into something to look at.
 *
 * The meter is advisory and says so. It never disables a button, never rejects a
 * passphrase and never withholds a warning: SECURITY.md counts accepting a weak
 * passphrase *silently* as a vulnerability, and ARCHITECTURE §6.3.1 rules out the
 * obvious "fix" of refusing one, because there is nobody to appeal to afterwards.
 *
 * So the strongest thing this file does is choose a colour and write a sentence.
 */

import type { PassphraseStrength } from '@shared/dto'

/** Segments in the bar. Five, so score 0 still lights one and reads as "very weak". */
export const METER_SEGMENTS = 5

/** Every tone the meter writes to `data-tone`. screens.css has a selector for each but empty. */
export const METER_TONES = ['empty', 'negative', 'warning', 'positive'] as const

export type MeterTone = (typeof METER_TONES)[number]

export interface MeterView {
  segments: number
  /** How many are lit. Zero only when nothing has been typed. */
  filled: number
  /** 'Weak', 'Strong', … or null before anything is typed. */
  label: string | null
  tone: MeterTone
  /** The single most useful improvement, from main. Null when there is nothing to add. */
  advice: string | null
  /** True when the warning belongs on screen. */
  isWeak: boolean
  /** What a screen reader announces for the bar. */
  valueText: string
}

/**
 * The bar for a strength result.
 *
 * `strength` is null before the first answer comes back from main, which is a real state
 * — the meter is one IPC round trip behind the keystroke and must not flash a verdict it
 * does not have.
 */
export function meterView(strength: PassphraseStrength | null, passphrase: string): MeterView {
  if (passphrase === '') {
    return {
      segments: METER_SEGMENTS,
      filled: 0,
      label: null,
      tone: 'empty',
      advice: null,
      isWeak: false,
      valueText: 'No passphrase typed yet',
    }
  }

  if (strength === null) {
    return {
      segments: METER_SEGMENTS,
      filled: 0,
      label: null,
      tone: 'empty',
      advice: null,
      isWeak: false,
      valueText: 'Checking this passphrase',
    }
  }

  return {
    segments: METER_SEGMENTS,
    filled: strength.score + 1,
    label: strength.label,
    tone: toneFor(strength.score),
    advice: strength.suggestion,
    isWeak: strength.isWeak,
    valueText: `${strength.label} passphrase`,
  }
}

function toneFor(score: PassphraseStrength['score']): MeterTone {
  if (score <= 1) return 'negative'
  if (score === 2) return 'warning'
  return 'positive'
}

/**
 * The sentence that has to be on the create screen whatever the meter says.
 *
 * It is not a threat and not a disclaimer — it is the single fact that changes what a
 * careful person does next, and there is no way to soften it and keep it true.
 */
export const NO_RESET_WARNING =
  'Nobody can reset this passphrase. Not Coffer, not the people who wrote it. If you ' +
  'lose it and your recovery codes, these books cannot be opened again by anyone.'

/** The heading on the interruption shown when someone creates with a weak passphrase. */
export const WEAK_CONFIRM_TITLE = 'That passphrase is easy to guess'

/** The body of that interruption. Says the cost, then gets out of the way. */
export function weakConfirmBody(strength: PassphraseStrength | null): string {
  const verdict =
    strength === null
      ? 'This passphrase'
      : `Coffer rates this passphrase "${strength.label.toLowerCase()}"`
  return (
    `${verdict}, and a passphrase that is quick to guess is the whole of the protection ` +
    'on these books. You can use it anyway — it is your decision and Coffer will not ' +
    'overrule it — but nobody can reset it for you afterwards.'
  )
}
