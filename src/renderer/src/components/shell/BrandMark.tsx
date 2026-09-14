import type { JSX } from 'react'
import { MARK_GRID, markPaths, markShapes } from '@shared/brand-mark'

interface BrandMarkProps {
  size?: number
  className?: string
}

/**
 * The Coffer mark: a square recessed into a square. The geometry, and the rules for small
 * sizes, are in src/shared/brand-mark.ts, which the packaging icon and the README banner
 * are drawn from too.
 *
 * Drawn rather than imported so it takes its colour from the accent token (through
 * `currentColor`) and needs no asset, no raster and no second copy for dark mode.
 */
export function BrandMark({ size = 20, className }: BrandMarkProps): JSX.Element {
  const shapes = markShapes(size)
  const paths = markPaths(shapes.size)

  return (
    <svg
      viewBox={`0 0 ${MARK_GRID} ${MARK_GRID}`}
      width={shapes.size}
      height={shapes.size}
      className={['brand-mark', className ?? ''].filter(Boolean).join(' ')}
      data-inner={shapes.inner.solid ? 'solid' : 'frame'}
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths.outer} fillRule="evenodd" className="brand-mark__outer" />
      <path d={paths.inner} fillRule="evenodd" className="brand-mark__inner" />
    </svg>
  )
}
