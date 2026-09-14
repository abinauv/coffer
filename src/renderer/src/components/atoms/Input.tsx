import { useId } from 'react'
import type { InputHTMLAttributes, JSX, Ref } from 'react'
import { useFieldMessage } from './FieldMessage'
import { Icon, type IconName } from './Icon'

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'prefix'> {
  label: string
  /** Hides the label visually but keeps it for assistive technology. */
  isLabelHidden?: boolean
  /** Guidance shown under the field. Replaced by `error` when there is one. */
  hint?: string
  /** What is wrong and what to do about it. See docs/CONVENTIONS.md §5. */
  error?: string
  icon?: IconName
  /**
   * An identifier — a GSTIN, an account code, a document number, a recovery code. Set in
   * the mono face with a slashed zero, because it is read aloud and retyped.
   */
  isIdentifier?: boolean
  /** A figure: right-aligned with tabular digits, so it lines up with the column it joins. */
  isFigure?: boolean
  /**
   * A short unit drawn in a well at the start of the box, such as a currency symbol. It is
   * decoration beside the label, not part of the name or the value.
   */
  prefix?: string
  /**
   * Disables the field AND says why, in place of the hint. The design system's rule: a
   * control that cannot be used says what would make it usable. An error still wins.
   */
  disabledReason?: string
  className?: string
  ref?: Ref<HTMLInputElement>
}

export function Input({
  label,
  isLabelHidden = false,
  hint,
  error,
  icon,
  isIdentifier = false,
  isFigure = false,
  prefix,
  disabledReason,
  className,
  id,
  disabled,
  ...rest
}: InputProps): JSX.Element {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const { describedBy, invalid, message } = useFieldMessage({
    id: inputId,
    hint: disabledReason ?? hint,
    error,
  })

  return (
    <div className={['field', className ?? ''].filter(Boolean).join(' ')}>
      <label className={isLabelHidden ? 'visually-hidden' : 'field__label'} htmlFor={inputId}>
        {label}
      </label>
      <div
        className={['field__control', icon === undefined ? '' : 'field__control--with-icon']
          .filter(Boolean)
          .join(' ')}
      >
        {icon !== undefined && <Icon name={icon} size={15} className="field__icon" />}
        {prefix !== undefined && (
          <span className="field__prefix" aria-hidden="true">
            {prefix}
          </span>
        )}
        <input
          id={inputId}
          className={[
            'field__input',
            isIdentifier ? 'field__input--identifier' : '',
            isFigure ? 'field__input--figure' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          disabled={disabled === true || disabledReason !== undefined}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          {...rest}
        />
      </div>
      {message}
    </div>
  )
}
