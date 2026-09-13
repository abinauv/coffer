import { useId } from 'react'
import type { InputHTMLAttributes, JSX, Ref } from 'react'
import { useFieldMessage } from './FieldMessage'
import { Icon, type IconName } from './Icon'

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label: string
  /** Hides the label visually but keeps it for assistive technology. */
  isLabelHidden?: boolean
  /** Guidance shown under the field. Replaced by `error` when there is one. */
  hint?: string
  /** What is wrong and what to do about it. See docs/CONVENTIONS.md §5. */
  error?: string
  icon?: IconName
  className?: string
  ref?: Ref<HTMLInputElement>
}

export function Input({
  label,
  isLabelHidden = false,
  hint,
  error,
  icon,
  className,
  id,
  ...rest
}: InputProps): JSX.Element {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const { describedBy, invalid, message } = useFieldMessage({ id: inputId, hint, error })

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
        <input
          id={inputId}
          className="field__input"
          aria-invalid={invalid}
          aria-describedby={describedBy}
          {...rest}
        />
      </div>
      {message}
    </div>
  )
}
