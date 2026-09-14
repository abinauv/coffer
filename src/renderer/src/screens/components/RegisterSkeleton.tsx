/*
 * A register that is still loading (design system §05, "Loading — skeleton holds the grid").
 *
 * NO SPINNER ON A REGISTER. A spinner in a table is a jump waiting to happen: the rows
 * arrive, the table takes its real height, and whatever the user was about to click moves.
 * The skeleton draws the columns at the widths the real table will use, so rows fill in
 * where the bars were.
 *
 * WHAT A SCREEN READER HEARS is one sentence, not six rows of nothing. The bars are hidden;
 * a status line names what is loading, and the region is marked busy.
 */

import type { JSX } from 'react'

export interface SkeletonColumn {
  /** Any CSS width the real table's column uses: '1fr', '8rem', '96px'. */
  width: string
  /** Figures are right-aligned, so their bars are too. */
  align?: 'start' | 'end'
}

interface RegisterSkeletonProps {
  /** What is loading, for the status line: "sales invoices". */
  label: string
  columns: readonly SkeletonColumn[]
  /** How many placeholder rows. Six unless given — enough to hold a screen, not a page. */
  rows?: number
}

/*
 * Fixed bar lengths, cycled by row, rather than random ones: a skeleton that changed
 * shape on every render would flicker, and a test could not pin it.
 */
const BAR_LENGTHS = ['62%', '78%', '45%', '70%', '55%', '66%'] as const

export function RegisterSkeleton({ label, columns, rows = 6 }: RegisterSkeletonProps): JSX.Element {
  const template = columns.map((column) => column.width).join(' ')

  return (
    <div className="skeleton" aria-busy="true">
      <p className="visually-hidden" role="status">
        Loading {label}
      </p>
      <div className="skeleton__rows" aria-hidden="true">
        {Array.from({ length: rows }, (_unused, row) => (
          <div key={row} className="skeleton__row" style={{ gridTemplateColumns: template }}>
            {columns.map((column, index) => (
              <span key={index} className="skeleton__cell" data-align={column.align ?? 'start'}>
                <span
                  className="skeleton__bar"
                  style={{
                    /* The first column varies, as a party name does; the rest are figures
                     * and dates of one width. */
                    width: index === 0 ? BAR_LENGTHS[row % BAR_LENGTHS.length] : '80%',
                  }}
                />
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
