/*
 * What a screen shows when there is nothing in it yet (design system §05, "Empty").
 *
 * Three things and no more: what goes here, the one action that fills it, and — where the
 * action has a key — the key. The dashed square is a place for something, not an icon of
 * any particular thing, so an empty register and an empty company list look like the same
 * kind of state.
 *
 * THE TITLE'S ELEMENT IS THE CALLER'S. On the company picker the empty state is the page's
 * second-level heading; inside the Overview it sits under a section that already has one,
 * and promoting its sentence to a heading would add a level a screen reader user navigates
 * by for no reason. So the element is a prop, and it has no default that could be wrong in
 * both places.
 */

import type { JSX, ReactNode } from 'react'

interface EmptyStateProps {
  /** Says what goes here, in the user's words: "No sales invoices yet". */
  title: string
  titleAs: 'h2' | 'h3' | 'p'
  /** One or two sentences: what fills this, and anything worth knowing before they do. */
  children?: ReactNode
  /** The one action that fills it. Usually a single primary button. */
  action?: ReactNode
  /** The key for that action, e.g. a <Kbd>, shown under it. */
  shortcut?: ReactNode
}

export function EmptyState({
  title,
  titleAs: Title,
  children,
  action,
  shortcut,
}: EmptyStateProps): JSX.Element {
  return (
    <div className="empty">
      <span className="empty__mark" aria-hidden="true" />
      <Title className="empty__title">{title}</Title>
      {children !== undefined && <div className="empty__body">{children}</div>}
      {action !== undefined && <div className="empty__actions">{action}</div>}
      {shortcut !== undefined && <div className="empty__shortcut">{shortcut}</div>}
    </div>
  )
}
