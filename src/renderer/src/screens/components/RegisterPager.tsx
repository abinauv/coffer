/*
 * The foot of a register: where on the list this page is, and the way to the next one.
 *
 * NO TOTAL. The only figure here is a count of rows. A sum of the amounts above would be the
 * total of a page — a number that changes when Next is pressed and means nothing in either
 * position (design.md §6).
 */

import type { JSX } from 'react'
import { Button } from '@renderer/components/atoms'
import { showingLabel } from '../lib/register-view'

interface RegisterPagerProps {
  offset: number
  rowsOnPage: number
  /** How many rows the filters match. Null when the count could not be read. */
  total: number | null
  hasPrevious: boolean
  hasNext: boolean
  onPrevious: () => void
  onNext: () => void
}

export function RegisterPager({
  offset,
  rowsOnPage,
  total,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
}: RegisterPagerProps): JSX.Element {
  return (
    <nav className="register__pager" aria-label="Pages">
      <span className="register__showing" role="status">
        {showingLabel(offset, rowsOnPage, total)}
      </span>
      {(hasPrevious || hasNext) && (
        <span className="register__pages">
          <Button variant="secondary" size="sm" disabled={!hasPrevious} onClick={onPrevious}>
            Previous
          </Button>
          <Button variant="secondary" size="sm" disabled={!hasNext} onClick={onNext}>
            Next
          </Button>
        </span>
      )}
    </nav>
  )
}
