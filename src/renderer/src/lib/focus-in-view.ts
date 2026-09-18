/*
 * Keeping the control the keyboard is on inside the box it lives in.
 *
 * WHY THIS EXISTS. A browser scrolls a focused element into view only when it is ENTIRELY
 * outside the scroller it sits in. A control that is half in and half out is left where it
 * is — and in a table that scrolls sideways, the last column is exactly that: tabbing along
 * an invoice line put the focus ring on a Remove button with ten pixels of it showing under
 * the window edge, and nothing moved (B38 in the design plan). A ring nobody can see is the
 * same as no ring.
 *
 * WHAT IT DOES. On every focus, if the control is not wholly inside the nearest box that
 * scrolls sideways, it asks for the smallest scroll that brings it in — the same call the
 * browser would have made had the control been fully out of view. Where nothing scrolls, or
 * the control already fits, it does nothing.
 *
 * It reads the DOM and scrolls; it decides nothing about what has focus.
 */

/** The nearest ancestor that both can scroll sideways and has somewhere to scroll to. */
export function sidewaysScroller(element: Element): Element | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const overflowX = getComputedStyle(node).overflowX
    if (
      (overflowX === 'auto' || overflowX === 'scroll') &&
      node.scrollWidth > node.clientWidth + 1
    ) {
      return node
    }
  }
  return null
}

/** Whether every part of `box` is inside `within`, give or take a rounding pixel. */
export function isFullyInView(box: DOMRect, within: DOMRect): boolean {
  return box.left >= within.left - 1 && box.right <= within.right + 1
}

/**
 * Scrolls the element into its scroller if part of it is outside. Answers whether it asked
 * for a scroll, which is what a test can see: jsdom and happy-dom lay nothing out, so the
 * decision is testable and the scroll itself is the browser's.
 */
export function keepInView(element: Element): boolean {
  const scroller = sidewaysScroller(element)
  if (scroller === null) return false
  if (isFullyInView(element.getBoundingClientRect(), scroller.getBoundingClientRect())) {
    return false
  }
  element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  return true
}
