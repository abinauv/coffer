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

/*
 * Which tones interrupt, as a total record (CONVENTIONS §1.9).
 *
 * A failure interrupts whatever is being read; a standing warning does not — the
 * no-reset warning sits on the create screen for as long as the form is open, and
 * announcing it over every field would make the form unusable.
 *
 * This was a ternary, and a ternary over a closed union answers for a member nobody
 * has added yet: a fifth tone would have compiled and silently inherited "no role",
 * which is the quiet direction of the mistake and so the one that survives review.
 * `undefined` is spelled out per tone rather than left to a default, because the
 * decision each new tone has to make is exactly "does this one interrupt".
 */
const ROLES: Record<NoticeTone, 'alert' | undefined> = {
  info: undefined,
  warning: undefined,
  danger: 'alert',
  positive: undefined,
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
  /*
   * Three ways to have no detail, and each clause excludes one the others let through:
   * a caller that omits the prop sends `undefined`, `failureDetail` returns `null`, and
   * a caller that trims a path down to nothing sends `''`. Drop any one and an empty
   * paragraph appears under every notice that arrives by that route — a gap under the
   * body that reads as a missing sentence rather than as no sentence.
   */
  const hasDetail = detail !== undefined && detail !== null && detail !== ''

  return (
    <div className={`notice notice--${tone}`} role={ROLES[tone]}>
      <Icon name={icon ?? ICONS[tone]} size={17} className="notice__icon" />
      <div className="notice__content">
        {title !== undefined && <p className="notice__title">{title}</p>}
        {children !== undefined && <div className="notice__body">{children}</div>}
        {hasDetail && <p className="notice__detail selectable">{detail}</p>}
        {actions !== undefined && <div className="notice__actions">{actions}</div>}
      </div>
    </div>
  )
}
