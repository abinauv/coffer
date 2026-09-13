/*
 * A passphrase field, with a way to see what you typed.
 *
 * The Input atom has no slot for a control inside the field, and components/ is not this
 * batch's to change — so this reuses the atom's own class names (styles/atoms.css) and
 * adds one button. Same field, same focus ring, same error treatment.
 *
 * Two rules the markup enforces:
 *
 *   - The value is never written anywhere but this input. Not to a title attribute, not
 *     to a data attribute, not to a route, not to a log.
 *   - Reveal defaults to off and resets nothing else. Someone reading a passphrase back
 *     to check a typo is not the same as someone leaving it on screen.
 */

import { useId, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { useFieldMessage } from '@renderer/components/atoms'

interface PassphraseFieldProps {
  label: string
  value: string
  onChange: (value: string) => void
  /** Guidance under the field. Replaced by `error` when there is one. */
  hint?: ReactNode
  error?: string
  placeholder?: string
  autoFocus?: boolean
  isDisabled?: boolean
  /** Enter is the natural submit on these screens. */
  onSubmit?: () => void
  /** Rendered under the field, after the hint — the strength meter goes here. */
  children?: ReactNode
}

export function PassphraseField({
  label,
  value,
  onChange,
  hint,
  error,
  placeholder,
  autoFocus = false,
  isDisabled = false,
  onSubmit,
  children,
}: PassphraseFieldProps): JSX.Element {
  const inputId = useId()
  const [isRevealed, setRevealed] = useState(false)
  const { describedBy, invalid, message } = useFieldMessage({ id: inputId, hint, error })

  return (
    <div className="field passphrase-field">
      <label className="field__label" htmlFor={inputId}>
        {label}
      </label>
      <div className="field__control">
        <input
          id={inputId}
          className="field__input passphrase-field__input"
          type={isRevealed ? 'text' : 'password'}
          value={value}
          placeholder={placeholder}
          disabled={isDisabled}
          autoFocus={autoFocus}
          /* No password manager, no history, no spell-checker sending it anywhere. */
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && onSubmit) {
              event.preventDefault()
              onSubmit()
            }
          }}
        />
        <button
          type="button"
          className="passphrase-field__reveal focus-inset"
          onClick={() => setRevealed((current) => !current)}
          /* The state, not the action: assistive technology should hear what the field
             is doing, and the label changes as it changes. */
          aria-pressed={isRevealed}
          disabled={isDisabled}
        >
          {isRevealed ? 'Hide' : 'Show'}
        </button>
      </div>
      {message}
      {children}
    </div>
  )
}
