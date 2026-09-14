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
 *
 * DRAWN AGAINST THE WINDOW, NOT ITS PARENT. The bubble is `position: fixed` at the
 * trigger's measured edge. Positioned inside its parent, it was clipped by any
 * scrolling ancestor — the collapsed rail is one, and it hid every label it
 * existed to show — and, even hidden, it widened that ancestor into a sideways
 * scrollbar. Scrolling while it is up would leave it behind, so a scroll hides it.
 */

import { Children, cloneElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, JSX, ReactElement } from 'react'

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right'

interface TooltipProps {
  label: string
  placement?: TooltipPlacement
  /** Milliseconds of hover before it appears. Focus shows it immediately. */
  delayMs?: number
  children: ReactElement<{ 'aria-describedby'?: string }>
}

/** Where the bubble's anchor point goes, 8px off the trigger's edge. Its CSS shifts it from there. */
export function bubblePosition(
  placement: TooltipPlacement,
  trigger: Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left'>,
): { top: number; left: number } {
  const gap = 8
  const middleX = (trigger.left + trigger.right) / 2
  const middleY = (trigger.top + trigger.bottom) / 2
  switch (placement) {
    case 'top':
      return { top: trigger.top - gap, left: middleX }
    case 'bottom':
      return { top: trigger.bottom + gap, left: middleX }
    case 'left':
      return { top: middleY, left: trigger.left - gap }
    case 'right':
      return { top: middleY, left: trigger.right + gap }
  }
}

export function Tooltip({
  label,
  placement = 'bottom',
  delayMs = 400,
  children,
}: TooltipProps): JSX.Element {
  const [isVisible, setVisible] = useState(false)
  const [position, setPosition] = useState<CSSProperties | undefined>(undefined)
  const anchor = useRef<HTMLSpanElement>(null)
  const id = useId()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function clearTimer(): void {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  useEffect(() => clearTimer, [])

  /* Measured before paint, so the bubble never flashes at the window's corner. */
  useLayoutEffect(() => {
    if (!isVisible || anchor.current === null) return
    setPosition(bubblePosition(placement, anchor.current.getBoundingClientRect()))
  }, [isVisible, placement])

  useEffect(() => {
    if (!isVisible) return undefined
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setVisible(false)
    }
    function onScroll(): void {
      setVisible(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [isVisible])

  const trigger = cloneElement(Children.only(children), {
    'aria-describedby': isVisible ? id : undefined,
  })

  return (
    <span
      ref={anchor}
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
        style={isVisible ? position : undefined}
      >
        {label}
      </span>
    </span>
  )
}
