/*
 * A tooltip.
 *
 * Rules it follows, because a tooltip that breaks them is worse than no tooltip:
 *
 *   - It appears on focus, not only on hover. Keyboard users get the same help.
 *   - It never carries information that is not available elsewhere. It labels; it
 *     does not explain something the interface failed to say.
 *   - Escape dismisses it, so it can never sit over the thing you are reading.
 *   - It is a description, not a name: the trigger keeps its own accessible name
 *     and gains `aria-describedby`.
 *
 * Placement is fixed rather than collision-aware. The shell only tooltips small
 * controls in known corners; a screen that needs anchored positioning should say
 * so rather than have this quietly grow a layout engine.
 */

import { Children, cloneElement, useEffect, useId, useRef, useState } from 'react'
import type { JSX, ReactElement } from 'react'

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right'

interface TooltipProps {
  label: string
  placement?: TooltipPlacement
  /** Milliseconds of hover before it appears. Focus shows it immediately. */
  delayMs?: number
  children: ReactElement<{ 'aria-describedby'?: string }>
}

export function Tooltip({
  label,
  placement = 'bottom',
  delayMs = 400,
  children,
}: TooltipProps): JSX.Element {
  const [isVisible, setVisible] = useState(false)
  const id = useId()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function clearTimer(): void {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  useEffect(() => clearTimer, [])

  useEffect(() => {
    if (!isVisible) return undefined
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setVisible(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isVisible])

  const trigger = cloneElement(Children.only(children), {
    'aria-describedby': isVisible ? id : undefined,
  })

  return (
    <span
      className="tooltip"
      onPointerEnter={() => {
        clearTimer()
        timer.current = setTimeout(() => setVisible(true), delayMs)
      }}
      onPointerLeave={() => {
        clearTimer()
        setVisible(false)
      }}
      onFocusCapture={() => setVisible(true)}
      onBlurCapture={() => {
        clearTimer()
        setVisible(false)
      }}
    >
      {trigger}
      <span
        id={id}
        role="tooltip"
        className={`tooltip__bubble tooltip__bubble--${placement}`}
        data-visible={isVisible ? 'true' : 'false'}
      >
        {label}
      </span>
    </span>
  )
}
