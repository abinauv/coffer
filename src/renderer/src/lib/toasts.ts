/*
 * Toast state, as a pure reducer.
 *
 * Toasts are for the outcome of something the user just did. They are not an error
 * channel: anything the user must act on belongs in the screen, and anything they
 * must not miss belongs in a dialog. Which is why a `danger` toast never expires on
 * its own — a failure that scrolled away unread is a failure that was never
 * reported (docs/CONVENTIONS.md §5).
 *
 * The timers live in the provider; this module only decides what the list contains.
 */

export type ToastTone = 'info' | 'success' | 'warning' | 'danger'

export interface ToastAction {
  label: string
  run: () => void
}

export interface Toast {
  id: string
  tone: ToastTone
  /** One line, what happened. 'Backup written.' */
  title: string
  /** Optional second line: where, how many, what to do next. */
  body?: string
  action?: ToastAction
  /** Milliseconds until it dismisses itself, or null to stay until dismissed. */
  durationMs: number | null
  /**
   * Collapses repeats. A second toast with the same key replaces the first in
   * place rather than stacking — saving twice should not queue two identical
   * confirmations.
   */
  dedupeKey?: string
  createdAt: number
}

export type ToastInput = Omit<Toast, 'id' | 'createdAt' | 'tone' | 'durationMs'> & {
  tone?: ToastTone
  durationMs?: number | null
}

export interface ToastState {
  toasts: readonly Toast[]
}

export type ToastEvent =
  { type: 'show'; toast: Toast } | { type: 'dismiss'; id: string } | { type: 'clear' }

/** Beyond this the stack stops being glanceable and starts being a log. */
export const MAX_VISIBLE_TOASTS = 4

export const EMPTY_TOAST_STATE: ToastState = { toasts: [] }

export function defaultDurationMs(tone: ToastTone): number | null {
  switch (tone) {
    case 'success':
      return 4000
    case 'info':
      return 5000
    case 'warning':
      return 8000
    case 'danger':
      /* Never auto-dismissed. See the note at the top of this file. */
      return null
  }
}

export function createToast(input: ToastInput, id: string, now: number): Toast {
  const tone = input.tone ?? 'info'
  return {
    id,
    tone,
    title: input.title,
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.action === undefined ? {} : { action: input.action }),
    durationMs: input.durationMs === undefined ? defaultDurationMs(tone) : input.durationMs,
    ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
    createdAt: now,
  }
}

export function toastsReducer(state: ToastState, event: ToastEvent): ToastState {
  switch (event.type) {
    case 'show': {
      const incoming = event.toast
      if (incoming.dedupeKey !== undefined) {
        const at = state.toasts.findIndex((toast) => toast.dedupeKey === incoming.dedupeKey)
        if (at >= 0) {
          /* Replace in place: the toast keeps its position so the stack does not
           * jump under the pointer, but gets fresh content and a fresh timer. */
          const toasts = [...state.toasts]
          toasts[at] = { ...incoming, id: state.toasts[at]?.id ?? incoming.id }
          return { toasts }
        }
      }
      return { toasts: trimToCapacity([...state.toasts, incoming]) }
    }
    case 'dismiss': {
      const toasts = state.toasts.filter((toast) => toast.id !== event.id)
      /* Identity is preserved when nothing changed, so a stale timer firing after
       * its toast was dismissed by hand does not re-render the viewport. */
      return toasts.length === state.toasts.length ? state : { toasts }
    }
    case 'clear':
      return state.toasts.length === 0 ? state : EMPTY_TOAST_STATE
  }
}

/**
 * Drops the oldest toasts once the stack is over capacity, preferring to drop
 * ones that would have expired anyway. A sticky toast is only evicted when every
 * toast is sticky — it is carrying something that was never acknowledged.
 */
function trimToCapacity(toasts: readonly Toast[]): readonly Toast[] {
  if (toasts.length <= MAX_VISIBLE_TOASTS) return toasts
  const kept = [...toasts]
  while (kept.length > MAX_VISIBLE_TOASTS) {
    const expiring = kept.findIndex((toast) => toast.durationMs !== null)
    kept.splice(expiring >= 0 ? expiring : 0, 1)
  }
  return kept
}

/** Danger interrupts; everything else waits its turn in the live region. */
export function ariaLiveFor(tone: ToastTone): 'assertive' | 'polite' {
  return tone === 'danger' ? 'assertive' : 'polite'
}
