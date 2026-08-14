/*
 * Toast state.
 *
 * The reducer is in lib/toasts.ts and is unit tested there. This file owns the
 * timers, and one behaviour worth calling out: the countdown genuinely pauses
 * while the pointer is over the stack or focus is inside it, and resumes with the
 * time that was left. A toast that vanished while the user was reaching for its
 * action button is a toast that lied about having an action.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import type { JSX, ReactNode } from 'react'
import {
  createToast,
  EMPTY_TOAST_STATE,
  toastsReducer,
  type Toast,
  type ToastInput,
} from '../lib/toasts'

interface ToastContextValue {
  toasts: readonly Toast[]
  /** Shows a toast and returns its id, so a caller can dismiss it early. */
  show: (input: ToastInput) => string
  dismiss: (id: string) => void
  clear: () => void
  /** True while the stack is hovered or focused; timers are held. */
  isPaused: boolean
  setPaused: (isPaused: boolean) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

let sequence = 0
function nextToastId(): string {
  sequence += 1
  return `toast-${sequence}`
}

/* Timers are tracked against id AND creation time, so a toast replaced in place
 * by its dedupe key restarts its countdown instead of inheriting the remainder. */
function runtimeKey(toast: Toast): string {
  return `${toast.id}:${toast.createdAt}`
}

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(toastsReducer, EMPTY_TOAST_STATE)
  const [isPaused, setPaused] = useState(false)
  /** How much of each toast's life is left, carried across pauses. */
  const remaining = useRef(new Map<string, number>())

  const dismiss = useCallback((id: string) => {
    dispatch({ type: 'dismiss', id })
  }, [])

  const show = useCallback((input: ToastInput) => {
    const toast = createToast(input, nextToastId(), Date.now())
    dispatch({ type: 'show', toast })
    return toast.id
  }, [])

  const clear = useCallback(() => dispatch({ type: 'clear' }), [])

  useEffect(() => {
    /* Forget anything that has left the stack, or the map grows for the life of
     * the session. */
    const live = new Set(state.toasts.map(runtimeKey))
    for (const key of [...remaining.current.keys()]) {
      if (!live.has(key)) remaining.current.delete(key)
    }

    if (isPaused) return undefined

    const startedAt = Date.now()
    const scheduled = new Map<string, ReturnType<typeof setTimeout>>()

    for (const toast of state.toasts) {
      if (toast.durationMs === null) continue
      const key = runtimeKey(toast)
      const left = remaining.current.get(key) ?? toast.durationMs
      scheduled.set(
        key,
        setTimeout(() => dispatch({ type: 'dismiss', id: toast.id }), Math.max(0, left)),
      )
    }

    return () => {
      const elapsed = Date.now() - startedAt
      for (const [key, handle] of scheduled) {
        clearTimeout(handle)
        const before = remaining.current.get(key)
        const source = before ?? state.toasts.find((toast) => runtimeKey(toast) === key)?.durationMs
        remaining.current.set(key, Math.max(0, (source ?? 0) - elapsed))
      }
    }
  }, [state.toasts, isPaused])

  const value = useMemo<ToastContextValue>(
    () => ({ toasts: state.toasts, show, dismiss, clear, isPaused, setPaused }),
    [state.toasts, show, dismiss, clear, isPaused],
  )

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
}

export function useToasts(): ToastContextValue {
  const value = useContext(ToastContext)
  if (!value) throw new Error('useToasts must be used inside a ToastProvider')
  return value
}
