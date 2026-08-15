/*
 * A box that says something the user has to read: a warning about what cannot be undone,
 * a failure and what to do about it, a note about a file that is not where it should be.
 *
 * Tone is never the only signal. Every notice carries an icon and a title in words, so it
 * still reads correctly in monochrome or to somebody who cannot separate the hues — the
 * same rule the tokens file sets out for figures.
 */

import type { JSX, ReactNode } from 'react'
import { Icon, type IconName } from '@renderer/components/atoms'

export type NoticeTone = 'info' | 'warning' | 'danger' | 'positive'

const ICONS: Record<NoticeTone, IconName> = {
  info: 'info',
  warning: 'alert-triangle',
  danger: 'alert-circle',
  positive: 'check-circle',
}

interface NoticeProps {
  tone?: NoticeTone
  title?: string
  /** Overrides the tone's icon. */
  icon?: IconName
  /** Buttons under the body: the way out of whatever this is about. */
  actions?: ReactNode
  /** Smaller, quieter text under the body — a path, usually. */
  detail?: string | null
  children?: ReactNode
}

export function Notice({
  tone = 'info',
  title,
  icon,
  actions,
  detail,
  children,
}: NoticeProps): JSX.Element {
  return (
    <div
      className={`notice notice--${tone}`}
      /* A failure interrupts whatever is being read; a standing warning does not. */
      role={tone === 'danger' ? 'alert' : undefined}
    >
      <Icon name={icon ?? ICONS[tone]} size={17} className="notice__icon" />
      <div className="notice__content">
        {title !== undefined && <p className="notice__title">{title}</p>}
        {children !== undefined && <div className="notice__body">{children}</div>}
        {detail !== undefined && detail !== null && (
          <p className="notice__detail selectable">{detail}</p>
        )}
        {actions !== undefined && <div className="notice__actions">{actions}</div>}
      </div>
    </div>
  )
}
