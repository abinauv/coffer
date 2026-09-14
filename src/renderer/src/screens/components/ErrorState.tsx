/*
 * What a screen shows when the thing it exists to show could not be had (design system §05,
 * "Error — cause, then fix").
 *
 * The order is the rule: what happened, then what can be done about it, then the buttons
 * that do it. It never asks the user to try again without saying what would be different,
 * and it never leads with an error code — a code belongs in `detail`, small, for a report.
 *
 * NOT A NOTICE. A notice sits beside content that is still there; an error state is where
 * the content would have been. It is an alert, because it replaces what the user came for.
 */

import type { JSX, ReactNode } from 'react'

interface ErrorStateProps {
  /** What happened, as a sentence a person can act on: "The books could not be read". */
  title: string
  /** Why, in the user's terms. */
  cause: ReactNode
  /** What to do about it, when there is something. */
  fix?: ReactNode
  /** The buttons that do the fix. */
  actions?: ReactNode
  /** The machine-readable part — an error code, a path. Quiet, and selectable. */
  detail?: string | null
}

export function ErrorState({ title, cause, fix, actions, detail }: ErrorStateProps): JSX.Element {
  const hasDetail = detail !== undefined && detail !== null && detail !== ''

  return (
    <div className="error-state" role="alert">
      <span className="error-state__mark" aria-hidden="true">
        !
      </span>
      <p className="error-state__title">{title}</p>
      <div className="error-state__cause">{cause}</div>
      {fix !== undefined && <div className="error-state__fix">{fix}</div>}
      {hasDetail && <p className="error-state__detail selectable">{detail}</p>}
      {actions !== undefined && <div className="error-state__actions">{actions}</div>}
    </div>
  )
}
