import type { JSX, ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export type BadgeTone = 'neutral' | 'accent' | 'positive' | 'negative' | 'warning'

interface BadgeProps {
  tone?: BadgeTone
  icon?: IconName
  /**
   * Struck through, on a plain ground: a thing that existed and was voided — a cancelled
   * document or voucher. Not a tone, because it is not a colour: the strike is the signal,
   * and it overrides the tone's fill.
   */
  isStruck?: boolean
  children: ReactNode
  className?: string
}

/**
 * A status tag.
 *
 * Tone is never the only signal — the label always says the state in words, so
 * "Overdue" reads as overdue whether or not its red arrives. See the colour-vision
 * note in styles/tokens.css.
 */
export function Badge({
  tone = 'neutral',
  icon,
  isStruck = false,
  children,
  className,
}: BadgeProps): JSX.Element {
  return (
    <span
      className={['badge', `badge--${tone}`, isStruck ? 'badge--struck' : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      {icon !== undefined && <Icon name={icon} size={12} />}
      {children}
    </span>
  )
}
