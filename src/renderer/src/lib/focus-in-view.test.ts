/*
 * The rule that keeps a focus ring where it can be seen (B38).
 *
 * happy-dom lays nothing out, so every box here is stated rather than measured: what is
 * under test is the decision — which ancestor counts as a sideways scroller, and when a
 * control is far enough out of it to be worth scrolling — not the scrolling, which is the
 * browser's. The case that found it is in the built app: tabbing along an invoice line put
 * the ring on a Remove button with ten pixels showing under the window edge, and a browser
 * scrolls a focused element into view only when NONE of it is showing.
 */

import { describe, expect, it, vi } from 'vitest'
import { isFullyInView, keepInView, sidewaysScroller } from './focus-in-view'

/** A box as `getBoundingClientRect` answers one. Only the sides are read. */
function box(left: number, right: number): DOMRect {
  return { left, right, top: 0, bottom: 0, width: right - left, height: 0, x: left, y: 0, toJSON: () => ({}) } as DOMRect
}

/** An element with a rect and a scroll size, inside an optional parent. */
function element(
  rect: DOMRect,
  options: { overflowX?: string; scrollWidth?: number; clientWidth?: number; parent?: HTMLElement } = {},
): HTMLElement {
  const node = document.createElement('div')
  node.getBoundingClientRect = () => rect
  if (options.overflowX !== undefined) node.style.overflowX = options.overflowX
  Object.defineProperty(node, 'scrollWidth', { value: options.scrollWidth ?? 0, configurable: true })
  Object.defineProperty(node, 'clientWidth', { value: options.clientWidth ?? 0, configurable: true })
  ;(options.parent ?? document.body).append(node)
  return node
}

describe('the box a control is kept inside', () => {
  it('is the nearest ancestor that scrolls sideways and has room to scroll', () => {
    const scroller = element(box(200, 1400), { overflowX: 'auto', scrollWidth: 1228, clientWidth: 1172 })
    const control = element(box(1391, 1457), { parent: scroller })

    expect(sidewaysScroller(control)).toBe(scroller)
  })

  /* A table that fits needs no scrolling, and asking for some would jump the page. */
  it('is nothing when the scroller has nowhere to scroll', () => {
    const scroller = element(box(200, 1400), { overflowX: 'auto', scrollWidth: 1172, clientWidth: 1172 })
    const control = element(box(300, 380), { parent: scroller })

    expect(sidewaysScroller(control)).toBeNull()
  })

  it('is nothing when nothing above it scrolls sideways', () => {
    const still = element(box(200, 1400), { overflowX: 'visible', scrollWidth: 1228, clientWidth: 1172 })
    const control = element(box(1391, 1457), { parent: still })

    expect(sidewaysScroller(control)).toBeNull()
  })
})

describe('whether a control is wholly inside its box', () => {
  it('says no when its far edge is past the scroller', () => {
    expect(isFullyInView(box(1391, 1457), box(233, 1405))).toBe(false)
  })

  it('says no when it starts before the scroller', () => {
    expect(isFullyInView(box(180, 320), box(233, 1405))).toBe(false)
  })

  it('says yes when it sits inside, and a rounding pixel does not change that', () => {
    expect(isFullyInView(box(300, 380), box(233, 1405))).toBe(true)
    expect(isFullyInView(box(232.6, 1405.4), box(233, 1405))).toBe(true)
  })
})

describe('what happens on focus', () => {
  it('scrolls a control that is half outside its scroller', () => {
    const scroller = element(box(233, 1405), { overflowX: 'auto', scrollWidth: 1228, clientWidth: 1172 })
    const control = element(box(1391, 1457), { parent: scroller })
    control.scrollIntoView = vi.fn()

    expect(keepInView(control)).toBe(true)
    expect(control.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
  })

  it('leaves a control that already fits alone', () => {
    const scroller = element(box(233, 1405), { overflowX: 'auto', scrollWidth: 1228, clientWidth: 1172 })
    const control = element(box(300, 380), { parent: scroller })
    control.scrollIntoView = vi.fn()

    expect(keepInView(control)).toBe(false)
    expect(control.scrollIntoView).not.toHaveBeenCalled()
  })

  /* Most of the app is not in a scroller at all: the listener runs on every focus, so the
   * ordinary case has to cost nothing and touch nothing. */
  it('leaves a control with no sideways scroller above it alone', () => {
    const control = element(box(300, 380))
    control.scrollIntoView = vi.fn()

    expect(keepInView(control)).toBe(false)
    expect(control.scrollIntoView).not.toHaveBeenCalled()
  })
})
