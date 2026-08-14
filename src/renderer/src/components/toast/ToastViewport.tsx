/*
 * The toast layer.
 *
 * One live region for the whole stack, `polite` so it waits for the screen reader
 * to finish rather than cutting across it. A `danger` toast additionally carries
 * `role="alert"`, which is the one case where interrupting is the right call.
 *
 * Hovering or focusing the stack pauses every countdown (store/toasts), so the
 * action button on a toast can always be reached.
 */

import type { JSX } from 'react'
import { ariaLiveFor, type Toast } from '../../lib/toasts'
import { useToasts } from '../../store/toasts'
import { Icon, IconButton, type IconName } from '../atoms'

const TONE_ICONS: Readonly<Record<Toast['tone'], IconName>> = {
  info: 'info',
  success: 'check-circle',
  warning: 'alert-triangle',
  danger: 'alert-circle',
}

export function ToastViewport(): JSX.Element {
  const { toasts, dismiss, setPaused } = useToasts()

  return (
    <div
      className="toasts"
      /* `region` with a label so it is reachable by landmark navigation, not
       * only announced when something changes. */
      role="region"
      aria-label="Notifications"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="toast"
          data-tone={toast.tone}
          role={toast.tone === 'danger' ? 'alert' : 'status'}
          aria-live={ariaLiveFor(toast.tone)}
        >
          <Icon name={TONE_ICONS[toast.tone]} size={16} className="toast__icon" />
          <div className="toast__content">
            <p className="toast__title">{toast.title}</p>
            {toast.body !== undefined && <p className="toast__body">{toast.body}</p>}
            {toast.action !== undefined && (
              <button
                type="button"
                className="toast__action"
                onClick={() => {
                  toast.action?.run()
                  dismiss(toast.id)
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
          <IconButton
            icon="close"
            label="Dismiss notification"
            variant="ghost"
            size="sm"
            className="toast__dismiss"
            onClick={() => dismiss(toast.id)}
          />
        </div>
      ))}
    </div>
  )
}
