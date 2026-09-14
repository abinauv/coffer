/*
 * The Coffer mark, as numbers.
 *
 * A square recessed into a square: a coffered ceiling panel, which is also a strongbox lid,
 * which is also a ruled ledger cell. Everything that draws the mark reads it from here —
 * the title bar's SVG (components/shell/BrandMark.tsx), the packaging icon
 * (scripts/generate-icon.mjs) and the README banner and social preview
 * (scripts/render-brand-assets.mjs) — so the three cannot drift apart.
 *
 * THE CONSTRUCTION. Drawn on an 8×8 grid:
 *
 *   outer frame   inset 1 unit,    stroke 0.5, corner radius 0.3
 *   inner frame   inset 2.5 units, stroke 0.5, corner radius 0.1
 *
 * So the inner square is half the outer square's width, and its opening is a third. The
 * inner square is fractionally sharper than the outer one, which is what makes it read as
 * recessed rather than as a target. Here the grid is scaled by 3 to a 24-unit box, the
 * same box every icon in lib/icons.ts is drawn in.
 *
 * WHY HALF, AND NOT THE SHEET'S WRITTEN THIRD. The brand sheet's construction note says
 * inset 3 and stroke 0.6, which makes the inner square a third of the outer one. Every
 * rendered specimen on the same sheet — the app icon at four platform sizes, the title
 * bar, the README banner, the social preview — draws it at close to half, with a stroke
 * nearer 0.5. At a third the opening shrinks to a pinhole and the mark reads as a target
 * or a stop button, the two things the sheet says it must not be; at half it reads as a
 * panel set into a panel. The specimens are what the design looks like, so they win.
 *
 * A stroke sits INSIDE its frame's edge, the way a CSS border does: the outer frame's
 * outside edge is at the inset, and the stroke eats inwards from there. That is how the
 * brand sheet's construction diagram is built, and it is why a frame here is two rounded
 * rectangles filled even-odd rather than one stroked rectangle — a centred stroke would
 * put half of it outside the inset and round the corners differently.
 *
 * SMALL SIZES. Two rules, both from the sheet's minimum-size specimens:
 *
 *   - Below 20px the inner frame becomes a solid square the size of its own opening. At
 *     16px a 2px hole closes up in rasterisation and the mark turns into a smudge, and a
 *     solid square as big as the whole inner frame would touch the outer one.
 *   - Below 20px the outer stroke is held at two device pixels, which is what the 16px
 *     specimen draws, so the frame does not thin to a grey hairline.
 *
 * And one hard floor: never below 16px. Callers asking for less get 16.
 *
 * What the sheet forbids, and nothing here offers a way to do: rotate it, fill the inner
 * square at a size where it can be a frame, gradient it, set it in the positive teal, or
 * add a keyhole, a coin, a rupee sign or a padlock.
 */

/** The box every mark is drawn in. */
export const MARK_GRID = 24

/** Never drawn smaller than this, in pixels. */
export const MARK_MIN_SIZE = 16

/** Below this many pixels the inner frame is drawn solid. */
export const MARK_SOLID_BELOW = 20

export interface MarkFrame {
  /** Distance from the edge of the 24-unit box to the frame's outside edge. */
  readonly inset: number
  /** Width of the frame, measured inwards from its outside edge. */
  readonly stroke: number
  /** Corner radius of the outside edge. */
  readonly radius: number
}

export const MARK_OUTER: MarkFrame = { inset: 3, stroke: 1.5, radius: 0.9 }
export const MARK_INNER: MarkFrame = { inset: 7.5, stroke: 1.5, radius: 0.3 }

/** One rounded rectangle, in grid units. */
export interface MarkRect {
  readonly x: number
  readonly y: number
  readonly size: number
  readonly radius: number
}

/**
 * The mark at one pixel size, as the shapes to fill.
 *
 * Each entry is either a single rectangle (solid) or an outside and a hole (a frame), to be
 * filled with the even-odd rule. Coordinates are grid units; scale by `size / MARK_GRID`.
 */
export interface MarkShapes {
  /** The size actually drawn, after the floor. */
  readonly size: number
  readonly outer: { readonly outside: MarkRect; readonly hole: MarkRect }
  readonly inner:
    | { readonly solid: false; readonly outside: MarkRect; readonly hole: MarkRect }
    | { readonly solid: true; readonly outside: MarkRect }
}

/** The pixel size a request is actually drawn at. */
export function markSize(requested: number): number {
  if (!Number.isFinite(requested)) return MARK_MIN_SIZE
  return Math.max(MARK_MIN_SIZE, requested)
}

function outsideOf(frame: MarkFrame): MarkRect {
  return {
    x: frame.inset,
    y: frame.inset,
    size: MARK_GRID - frame.inset * 2,
    radius: frame.radius,
  }
}

function holeOf(frame: MarkFrame, stroke: number): MarkRect {
  return {
    x: frame.inset + stroke,
    y: frame.inset + stroke,
    size: MARK_GRID - (frame.inset + stroke) * 2,
    /* The inside corner of a border is the outside radius less the border, never negative —
     * the same rule a browser applies to `border-radius`. */
    radius: Math.max(frame.radius - stroke, 0),
  }
}

export function markShapes(requested: number): MarkShapes {
  const size = markSize(requested)
  const isSmall = size < MARK_SOLID_BELOW

  /* Two device pixels, expressed in grid units at this size. */
  const outerStroke = isSmall
    ? Math.max(MARK_OUTER.stroke, (2 * MARK_GRID) / size)
    : MARK_OUTER.stroke

  return {
    size,
    outer: { outside: outsideOf(MARK_OUTER), hole: holeOf(MARK_OUTER, outerStroke) },
    inner: isSmall
      ? { solid: true, outside: holeOf(MARK_INNER, MARK_INNER.stroke) }
      : {
          solid: false,
          outside: outsideOf(MARK_INNER),
          hole: holeOf(MARK_INNER, MARK_INNER.stroke),
        },
  }
}

const round = (value: number): string => String(Math.round(value * 1000) / 1000)

/** One rounded rectangle as an SVG subpath, clockwise, in grid units. */
export function rectPath({ x, y, size, radius }: MarkRect): string {
  const right = x + size
  const bottom = y + size
  if (radius <= 0) {
    return `M${round(x)} ${round(y)}H${round(right)}V${round(bottom)}H${round(x)}Z`
  }
  const r = round(radius)
  const arc = `A${r} ${r} 0 0 1`
  return (
    `M${round(x + radius)} ${round(y)}` +
    `H${round(right - radius)}${arc} ${round(right)} ${round(y + radius)}` +
    `V${round(bottom - radius)}${arc} ${round(right - radius)} ${round(bottom)}` +
    `H${round(x + radius)}${arc} ${round(x)} ${round(bottom - radius)}` +
    `V${round(y + radius)}${arc} ${round(x + radius)} ${round(y)}Z`
  )
}

/** SVG path data for both parts at one size. Fill each with `fill-rule="evenodd"`. */
export function markPaths(requested: number): { outer: string; inner: string } {
  const shapes = markShapes(requested)
  const outer = rectPath(shapes.outer.outside) + rectPath(shapes.outer.hole)
  const inner = shapes.inner.solid
    ? rectPath(shapes.inner.outside)
    : rectPath(shapes.inner.outside) + rectPath(shapes.inner.hole)
  return { outer, inner }
}

/**
 * A complete standalone SVG of the mark in one colour, for the scripts that render the
 * launch assets. The app itself uses BrandMark, which takes its colour from a token.
 */
export function markSvg(requested: number, colour: string): string {
  const { size } = markShapes(requested)
  const { outer, inner } = markPaths(size)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_GRID} ${MARK_GRID}" ` +
    `width="${size}" height="${size}" aria-hidden="true">` +
    `<path fill="${colour}" fill-rule="evenodd" d="${outer}"/>` +
    `<path fill="${colour}" fill-rule="evenodd" d="${inner}"/>` +
    `</svg>`
  )
}
