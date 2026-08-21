/*
 * A labelled `<select>`, built on the same skeleton as `Input`.
 *
 * WHY THIS EXISTS RATHER THAN A `<label className="field">` PER SCREEN. The wrapping form
 * — label around control — is fine until the field has a hint, and then it is a bug: the
 * hint's text becomes part of the field's accessible name, so a screen reader announces
 * three sentences where the label is three words, and `getByLabelText` stops finding the
 * field at all. That was written by hand twice in one batch and got it wrong twice, which
 * is the signal to stop writing it by hand.
 *
 * Same structure as `Input`: `div.field`, then the label, the control and the message as
 * SIBLINGS, tied together with `htmlFor` and `aria-describedby`.
 */

import { useId } from 'react'
import type { JSX, ReactNode, Ref, SelectHTMLAttributes } from 'react'

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'> {
  label: string
  /** Hides the label visually but keeps it for assistive technology. */
  isLabelHidden?: boolean
  /** Guidance shown under the field. Replaced by `error` when there is one. */
  hint?: string
  /** What is wrong and what to do about it. See docs/CONVENTIONS.md §5. */
  error?: string
  className?: string
  children: ReactNode
  ref?: Ref<HTMLSelectElement>
}

export function Select({
  label,
  isLabelHidden = false,
  hint,
  error,
  className,
  id,
  children,
  ...rest
}: SelectProps): JSX.Element {
  const generatedId = useId()
  const selectId = id ?? generatedId
  const messageId = `${selectId}-message`
  const message = error ?? hint

  return (
    <div className={['field', className ?? ''].filter(Boolean).join(' ')}>
      <label className={isLabelHidden ? 'visually-hidden' : 'field__label'} htmlFor={selectId}>
        {label}
      </label>
      <select
        id={selectId}
        className="field__control"
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={message === undefined ? undefined : messageId}
        {...rest}
      >
        {children}
      </select>
      {message !== undefined && (
        <p
          id={messageId}
          className={error === undefined ? 'field__hint' : 'field__error'}
          /* Only a validation failure interrupts; a static hint does not. */
          role={error === undefined ? undefined : 'alert'}
        >
          {message}
        </p>
      )}
    </div>
  )
}
