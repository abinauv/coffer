import type { JSX } from 'react'
import { BRAND } from '../../../../branding'
import { BrandMark } from './BrandMark'

interface WordmarkProps {
  /** Pixel size of the mark. The name is sized by the stylesheet, beside it. */
  markSize?: number
  className?: string
}

/**
 * The horizontal lockup: the mark, then the name in Plex Serif SemiBold (brand sheet §02).
 *
 * The mark is decorative here, because the name beside it is already the words; a mark
 * that announced itself would make a screen reader say the product twice.
 */
export function Wordmark({ markSize = 17, className }: WordmarkProps): JSX.Element {
  return (
    <span className={['wordmark', className ?? ''].filter(Boolean).join(' ')}>
      <BrandMark size={markSize} />
      <span className="wordmark__name">{BRAND.name}</span>
    </span>
  )
}
