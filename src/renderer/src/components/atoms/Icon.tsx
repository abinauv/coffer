import type { JSX } from 'react'
import { ICON_PATHS, type IconName } from '../../lib/icons'

export type { IconName }

interface IconProps {
  name: IconName
  /** Pixels. The stroke is scaled with it so small icons stay legible. */
  size?: number
  strokeWidth?: number
  className?: string
  /**
   * Provide only when the icon is the sole content of its control and no
   * accessible name comes from elsewhere. An icon beside a label is decorative
   * and must stay hidden, or a screen reader announces the label twice.
   */
  title?: string
}

export function Icon({ name, size = 16, strokeWidth, className, title }: IconProps): JSX.Element {
  /* Below 16px a 1.75 stroke starts to fill the counters; above it, thicken
   * slightly so a 24px icon does not look spindly beside 14px text. */
  const stroke = strokeWidth ?? (size <= 14 ? 1.6 : size >= 22 ? 1.9 : 1.75)

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title === undefined ? true : undefined}
      role={title === undefined ? undefined : 'img'}
      focusable="false"
    >
      {title !== undefined && <title>{title}</title>}
      <path d={ICON_PATHS[name]} />
    </svg>
  )
}
