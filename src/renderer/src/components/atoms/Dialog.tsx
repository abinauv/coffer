/*
 * A modal dialog, built on the native <dialog> element.
 *
 * `showModal()` gives us the focus trap, the Escape handler, the inert background
 * and the top-layer stacking for free, correctly, from the platform. Every one of
 * those is something a hand-rolled modal gets subtly wrong, and none of them is
 * worth a dependency.
 *
 * The one thing to know: `open` is a React prop, not the element's own state.
 * Escape is intercepted and turned into `onClose` so React stays the single
 * source of truth for whether the dialog is showing.
 */

import { useEffect, useId, useRef } from 'react'
import type { JSX, ReactNode } from 'react'
import { IconButton } from './Button'

export type DialogSize = 'sm' | 'md' | 'lg' | 'palette'

interface DialogProps {
  isOpen: boolean
  onClose: () => void
  /** Omit only when the dialog supplies its own label, as the palette does. */
  title?: string
  description?: string
  size?: DialogSize
  /** When false, Escape and backdrop clicks do not close it. */
  isDismissible?: boolean
  /** Hides the header entirely. The palette is its own header. */
  isChrome?: boolean
  footer?: ReactNode
  children: ReactNode
  className?: string
}

export function Dialog({
  isOpen,
  onClose,
  title,
  description,
  size = 'md',
  isDismissible = true,
  isChrome = true,
  footer,
  children,
  className,
}: DialogProps): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (isOpen && !dialog.open) dialog.showModal()
    else if (!isOpen && dialog.open) dialog.close()
  }, [isOpen])

  return (
    <dialog
      ref={ref}
      className={['dialog', `dialog--${size}`, className ?? ''].filter(Boolean).join(' ')}
      aria-labelledby={title === undefined ? undefined : titleId}
      aria-describedby={description === undefined ? undefined : descriptionId}
      onCancel={(event) => {
        /* Always prevented: the element must not close itself behind React's
         * back, or `isOpen` and `dialog.open` drift apart and the next open()
         * is a no-op. */
        event.preventDefault()
        if (isDismissible) onClose()
      }}
      onClick={(event) => {
        /* A modal <dialog> fills the viewport; anything outside the inner panel
         * is a click on the backdrop. */
        if (isDismissible && event.target === ref.current) onClose()
      }}
    >
      <div className="dialog__panel">
        {isChrome && (
          <header className="dialog__header">
            <div className="dialog__heading">
              {title !== undefined && (
                <h2 id={titleId} className="dialog__title">
                  {title}
                </h2>
              )}
              {description !== undefined && (
                <p id={descriptionId} className="dialog__description">
                  {description}
                </p>
              )}
            </div>
            {isDismissible && (
              <IconButton icon="close" label="Close" variant="ghost" size="sm" onClick={onClose} />
            )}
          </header>
        )}
        <div className="dialog__body">{children}</div>
        {footer !== undefined && <footer className="dialog__footer">{footer}</footer>}
      </div>
    </dialog>
  )
}
