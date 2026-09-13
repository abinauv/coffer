/*
 * A checkbox with a label people can actually hit.
 *
 * The native control, restyled through `accent-color` only: a hand-built checkbox loses
 * the keyboard behaviour, the indeterminate state and the platform's own high-contrast
 * treatment, and gains nothing here.
 */

import { useId } from 'react'
import type { JSX, ReactNode } from 'react'
import { useFieldMessage } from '@renderer/components/atoms'

interface CheckboxFieldProps {
  isChecked: boolean
  onChange: (isChecked: boolean) => void
  isDisabled?: boolean
  /**
   * Guidance under the box — NOT part of what the control is called.
   *
   * `children` go inside the `<label>`, so anything nested there joins the accessible
   * name: a `<p>` of explanation under "Show archived" makes the name "Show archived
   * Archived accounts are hidden by default.", and a screen-reader user hears the whole
   * paragraph every time focus lands on the box. Guidance goes here instead and reaches
   * the input through `aria-describedby`, which is announced after the name and only
   * once — the same routing `PassphraseField` and `PathField` use for their hints.
   */
  hint?: ReactNode
  children: ReactNode
}

export function CheckboxField({
  isChecked,
  onChange,
  isDisabled = false,
  hint,
  children,
}: CheckboxFieldProps): JSX.Element {
  const id = useId()
  /* The id and the paragraph it names come out of one call, so the attribute cannot
   * dangle — the atom's whole reason for existing. This field never reports an error,
   * so it reads neither `invalid` nor the error half of the message. */
  const { describedBy, message } = useFieldMessage({ id, hint, className: 'checkbox__hint' })

  return (
    <div className="checkbox">
      <input
        id={id}
        type="checkbox"
        className="checkbox__input"
        checked={isChecked}
        disabled={isDisabled}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.checked)}
      />
      <label className="checkbox__label" htmlFor={id}>
        {children}
      </label>
      {/* OUTSIDE the `<label>`, and that is the point: `children` are inside it, so a
       * hint nested there would join the accessible name — measured as "Show archived
       * Archived accounts are hidden by default." The hint reaches the box by
       * `aria-describedby` instead, which is announced after the name and only once. */}
      {message}
    </div>
  )
}
