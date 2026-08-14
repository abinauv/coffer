import type { JSX } from 'react'

interface BrandMarkProps {
  size?: number
  className?: string
}

/**
 * The Coffer mark: a strongbox seen face on, with the two ruled lines of a ledger
 * across it. Drawn rather than imported so it inherits the accent token and needs
 * no asset, no raster, and no second copy for dark mode.
 */
export function BrandMark({ size = 20, className }: BrandMarkProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={['brand-mark', className ?? ''].filter(Boolean).join(' ')}
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2.5" y="4" width="19" height="16" rx="3" className="brand-mark__body" />
      <path d="M7 10.5h10M7 14h6" className="brand-mark__rules" />
      <circle cx="18" cy="14" r="1.6" className="brand-mark__dial" />
    </svg>
  )
}
