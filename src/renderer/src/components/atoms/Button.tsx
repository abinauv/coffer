import type { ButtonHTMLAttributes, JSX, Ref } from 'react'
import { Icon, type IconName } from './Icon'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: IconName
  iconEnd?: IconName
  isFullWidth?: boolean
  /**
   * Disables the button and shows progress. The label stays, so the width holds and the
   * button still names what it is doing; a spinner takes the leading icon's place, or
   * leads the label when there is no icon. It never becomes the word "Loading".
   */
  isBusy?: boolean
  className?: string
  ref?: Ref<HTMLButtonElement>
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconEnd,
  isFullWidth = false,
  isBusy = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): JSX.Element {
  const classes = [
    'button',
    `button--${variant}`,
    `button--${size}`,
    isFullWidth ? 'button--full' : '',
    children === undefined ? 'button--icon-only' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      /* Buttons inside a <form> default to submit; a shell full of accidental
       * submits is a hard bug to see, so the default is stated explicitly. */
      type={type}
      className={classes}
      disabled={disabled === true || isBusy}
      aria-busy={isBusy || undefined}
      {...rest}
    >
      {isBusy ? (
        <span className="button__spinner" aria-hidden="true" />
      ) : (
        icon !== undefined && <Icon name={icon} size={size === 'sm' ? 14 : 16} />
      )}
      {children !== undefined && <span className="button__label">{children}</span>}
      {iconEnd !== undefined && <Icon name={iconEnd} size={size === 'sm' ? 14 : 16} />}
    </button>
  )
}

interface IconButtonProps extends Omit<ButtonProps, 'children' | 'icon' | 'iconEnd'> {
  icon: IconName
  /** Required: an icon alone has no accessible name. */
  label: string
}

/** A square button whose only content is an icon. */
export function IconButton({ icon, label, size = 'md', ...rest }: IconButtonProps): JSX.Element {
  return <Button {...rest} icon={icon} size={size} aria-label={label} />
}
