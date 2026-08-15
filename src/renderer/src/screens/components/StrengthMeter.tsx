/*
 * The passphrase strength meter.
 *
 * Advisory, and visibly so: it reports, it never refuses. The scoring is main's
 * (src/main/companies/passphrase.ts), the presentation is ../lib/passphrase-meter.ts, and
 * this file only draws it.
 *
 * The verdict is announced in words as well as in colour — `aria-valuetext` on the bar
 * and the label beside it — because a five-segment bar shading from red to teal is not a
 * message everyone receives.
 */

import type { JSX } from 'react'
import type { PassphraseStrength } from '@shared/dto'
import { meterView } from '../lib/passphrase-meter'

interface StrengthMeterProps {
  strength: PassphraseStrength | null
  passphrase: string
}

export function StrengthMeter({ strength, passphrase }: StrengthMeterProps): JSX.Element | null {
  const view = meterView(strength, passphrase)
  if (passphrase === '') return null

  return (
    <div className="strength">
      <div
        className="strength__bar"
        data-tone={view.tone}
        role="meter"
        aria-label="Passphrase strength"
        aria-valuemin={0}
        aria-valuemax={view.segments}
        aria-valuenow={view.filled}
        aria-valuetext={view.valueText}
      >
        {Array.from({ length: view.segments }, (_unused, index) => (
          <span
            key={index}
            className="strength__segment"
            data-filled={index < view.filled ? 'true' : 'false'}
          />
        ))}
      </div>
      <div className="strength__text">
        {view.label !== null && (
          <span className="strength__label" data-tone={view.tone}>
            {view.label}
          </span>
        )}
        {view.advice !== null && <span className="strength__advice">{view.advice}</span>}
      </div>
    </div>
  )
}
