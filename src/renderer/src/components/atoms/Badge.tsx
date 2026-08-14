import type { JSX, ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export type BadgeTone = 'neutral' | 'accent' | 'positive' | 'negative' | 'warning'

interface BadgeProps {
  tone?: BadgeTone
  icon?: IconName
  children: ReactNode
  className?: string
}

/**
 * A status pill.
 *
 * Tone is never the only signal — the label always says the state in words, so
 * "Overdue" reads as overdue whether or not its red arrives. See the colour-vision
 * note in styles/tokens.css.
 */
export function Badge({ tone = 'neutral', icon, children, className }: BadgeProps): JSX.Element {
  return (
    <span className={['badge', `badge--${tone}`, className ?? ''].filter(Boolean).join(' ')}>
      {icon !== undefined && <Icon name={icon} size={12} />}
      {children}
    </span>
  )
}
