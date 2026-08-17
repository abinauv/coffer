/*
 * Document numbers.
 *
 * A number is assembled from a series and a sequence, and nothing else. No clock, no
 * database, no counter — this file formats, and the repository that allocates does the
 * incrementing inside the same transaction that writes the document (rule 3 in types.ts).
 *
 * ---------------------------------------------------------------------------
 * WHY THE SHAPE IS DATA
 *
 * The first thing anyone moving off Tally asks is whether their invoices can keep looking
 * the way they look. `INV/2026-27/0001`, `SI-0042`, `2026/0001/A` are all somebody's
 * existing series, and a hardcoded format means the answer is no. So prefix, suffix,
 * separator, width and whether the year appears are all fields, and this file is the one
 * place that knows how they compose.
 */

import type { NumberingSeries } from './types'

/** What varies between one number and the next in the same series. */
export interface NumberingScope {
  /**
   * The fiscal year label, e.g. '2026-27'. Required when the series includes the year.
   *
   * Null for a series that neither shows nor resets on the year — a quotation series that
   * simply runs on forever.
   */
  fiscalYearLabel: string | null
  /** 1-based. The sequence the counter handed out. */
  sequence: number
}

/**
 * The sequence as it appears in the number.
 *
 * Padded to the series' width, and NEVER truncated when it outgrows it: a series set to
 * three digits that reaches 1000 prints '1000', not '000'. Truncating would produce a
 * number a previous document already carries, which is the one failure a numbering
 * scheme exists to prevent.
 */
export function paddedSequence(sequence: number, width: number): string {
  return String(sequence).padStart(Math.max(0, width), '0')
}

/**
 * The number a series produces for a given scope.
 *
 * Empty parts are dropped rather than leaving a doubled separator, so a series with no
 * prefix gives '2026-27/0001' and not '/2026-27/0001'.
 */
export function formatDocumentNumber(series: NumberingSeries, scope: NumberingScope): string {
  const parts: string[] = []

  if (series.prefix !== '') {
    parts.push(series.prefix)
  }

  if (series.includeFiscalYear) {
    if (scope.fiscalYearLabel === null) {
      /*
       * A programmer error, not a user-actionable one: the caller asked for a number
       * whose shape includes the year and did not say which year. Silently dropping the
       * segment would give a number that collides with last year's, which is precisely
       * what including the year prevents.
       */
      throw new Error(
        `Series '${series.label}' includes the fiscal year, but none was supplied for the number.`,
      )
    }
    parts.push(scope.fiscalYearLabel)
  }

  parts.push(paddedSequence(scope.sequence, series.width))

  if (series.suffix !== '') {
    parts.push(series.suffix)
  }

  return parts.join(series.separator)
}

/**
 * What the next number will look like, for a settings screen to show while the user is
 * still editing the series.
 *
 * The same code path as a real allocation rather than a lookalike, so a preview that
 * matches is evidence the series is configured the way the user meant.
 */
export function previewOf(series: NumberingSeries, fiscalYearLabel: string | null): string {
  return formatDocumentNumber(series, { fiscalYearLabel, sequence: 1 })
}

/**
 * The counter a number should be drawn from.
 *
 * A series that resets each year keeps one counter per year; a series that never resets
 * keeps exactly one. Returning null for the second case rather than a sentinel string
 * means the storage layer can make the column nullable and let a unique index over
 * (series, scope) do the work.
 *
 * Note that this reads `resetOn` and NOT `includeFiscalYear`. They are independent on
 * purpose: a business may want the year printed while the sequence runs on across years,
 * or may reset silently each year without showing it. Tying them together would take a
 * legitimate configuration away for no reason other than that both mention the year.
 */
export function counterScopeOf(series: NumberingSeries, fiscalYearLabel: string): string | null {
  return series.resetOn === 'fiscal-year' ? fiscalYearLabel : null
}
