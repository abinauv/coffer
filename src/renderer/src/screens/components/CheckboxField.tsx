/*
 * A checkbox with a label people can actually hit.
 *
 * The native control, restyled through `accent-color` only: a hand-built checkbox loses
 * the keyboard behaviour, the indeterminate state and the platform's own high-contrast
 * treatment, and gains nothing here.
 */

import { useId } from 'react'
import type { JSX, ReactNode } from 'react'

interface CheckboxFieldProps {
  isChecked: boolean
  onChange: (isChecked: boolean) => void
  isDisabled?: boolean
  children: ReactNode
}

export function CheckboxField({
  isChecked,
  onChange,
  isDisabled = false,
  children,
}: CheckboxFieldProps): JSX.Element {
  const id = useId()

  return (
    <div className="checkbox">
      <input
        id={id}
        type="checkbox"
        className="checkbox__input"
        checked={isChecked}
        disabled={isDisabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <label className="checkbox__label" htmlFor={id}>
        {children}
      </label>
    </div>
  )
}
