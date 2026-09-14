/*
 * The decisions the numbering screen makes before it draws anything.
 *
 * THREE OF THESE CARRY THE FILE.
 *
 * `previewYearFor` decides what goes in `PreviewNumberInput.fiscalYearLabel`, which is
 * nullable AND required: null is the real answer for a series in no fiscal year, and an
 * absent field is a screen that forgot. Two independent reasons make a year necessary and
 * neither implies the other, so both are given a fixture that ONLY that reason catches.
 *
 * `kindsWithoutSeries` decides whether the repair prompt appears. It counts archived
 * series as present, because `seedDefaultSeries` skips a kind that has one — a prompt
 * that counted them missing would offer a repair which creates nothing.
 *
 * `groupSeriesByKind` decides which series is shown as the default. Every fixture here
 * puts the default somewhere other than first, because a function that returned "the
 * first row" would otherwise pass.
 */

import { describe, expect, it } from 'vitest'
import type { NumberingSeriesRecord } from '@shared/dto'
import { DOCUMENT_KINDS } from '@shared/documents'
import { RECEIPT_KINDS } from '@shared/receipts'
import {
  NUMBERED_KINDS,
  describeRepair,
  groupSeriesByKind,
  groupWarning,
  kindsWithoutSeries,
  needsFiscalYear,
  numberedKindLabel,
  previewYearFor,
  type NumberedKindOption,
} from './numbering-view'

function seriesOf(over: Partial<NumberingSeriesRecord> & Pick<NumberingSeriesRecord, 'id'>) {
  return {
    kind: 'sales-invoice',
    label: over.id,
    prefix: 'INV',
    suffix: '',
    separator: '/',
    includeFiscalYear: true,
    width: 4,
    resetOn: 'fiscal-year',
    isDefault: false,
    isArchived: false,
    hasIssued: false,
    ...over,
  } satisfies NumberingSeriesRecord
}

/*
 * A kind table the shipped one cannot be, handed to the functions that take one.
 *
 * Two kinds, in an order the fixtures below disagree with, plus a plural that differs
 * from the singular — so "the heading is the plural" cannot pass by reading the singular.
 * (CONVENTIONS §6: a guard given the table it guards against.)
 */
const TWO_KINDS: readonly NumberedKindOption[] = [
  { kind: 'letter', label: 'Letter', pluralLabel: 'Letters' },
  { kind: 'memo', label: 'Memo', pluralLabel: 'Memoranda' },
]

describe('the kinds a series can number', () => {
  /*
   * NINE, PINNED BY VALUE. The count is the fact the repair rests on — a company file
   * short of it cannot issue something — and a test that derived it from the same tables
   * the code derives it from could not tell nine from seven.
   */
  it('is nine: the five trade documents and the four vouchers', () => {
    expect(NUMBERED_KINDS).toHaveLength(9)
  })

  it('is the two kind tables, documents first', () => {
    expect(NUMBERED_KINDS.map((kind) => kind.kind)).toEqual([
      ...DOCUMENT_KINDS.map((definition) => definition.kind),
      ...RECEIPT_KINDS.map((definition) => definition.kind),
    ])
  })

  /*
   * The labels are the tables', which is the whole reason this list is derived. Pinned by
   * value here on purpose: 'Refund paid' is the word that would reach a user's paperwork,
   * and 'Refund' — which is what the kind is called — is the wrong one.
   */
  it('takes its words from the kind tables', () => {
    expect(numberedKindLabel('sales-invoice')).toBe('Sales invoice')
    expect(numberedKindLabel('quotation')).toBe('Quotation')
    expect(numberedKindLabel('refund')).toBe('Refund paid')
    expect(numberedKindLabel('refund-received')).toBe('Refund received')
  })

  /* A company file written by a newer build. Throwing here would take the whole settings
   * screen down over one row it could still show the user. */
  it('shows a kind it has never heard of as the file spells it', () => {
    expect(numberedKindLabel('delivery-note')).toBe('delivery-note')
  })
})

describe('which kinds have no series at all', () => {
  /* The pre-0015 company file: seven kinds seeded, and the two refund kinds that did not
   * exist when it was made. This is the case the repair was built for. */
  it('names the kinds a file made before they existed is missing', () => {
    const all = NUMBERED_KINDS.filter(
      (kind) => kind.kind !== 'refund' && kind.kind !== 'refund-received',
    ).map((kind) => seriesOf({ id: kind.kind, kind: kind.kind }))

    expect(kindsWithoutSeries(all).map((kind) => kind.label)).toEqual([
      'Refund paid',
      'Refund received',
    ])
  })

  it('finds nothing missing on books that have every kind', () => {
    const all = NUMBERED_KINDS.map((kind) => seriesOf({ id: kind.kind, kind: kind.kind }))
    expect(kindsWithoutSeries(all)).toEqual([])
  })

  /*
   * THE ONE THAT MATTERS. `seedDefaultSeries` skips a kind that already has a series and
   * never looks at whether it is archived, so a kind whose only series has been archived
   * is not missing — the repair would create nothing for it and report nought. Counting
   * it here would make the prompt promise a fix it cannot deliver.
   */
  it('does not call a kind missing when its only series is archived', () => {
    const missing = kindsWithoutSeries(
      [seriesOf({ id: 'old', kind: 'memo', isArchived: true })],
      TWO_KINDS,
    )
    expect(missing.map((kind) => kind.kind)).toEqual(['letter'])
  })
})

describe('grouping the series under the kind they number', () => {
  /* The fixture is in the OPPOSITE order to the table, so a function that grouped by
   * first appearance would come out backwards. */
  const listed = [seriesOf({ id: 'm1', kind: 'memo' }), seriesOf({ id: 'l1', kind: 'letter' })]

  it('gives every kind a group, in the table order and not the list order', () => {
    const groups = groupSeriesByKind(listed, { includeArchived: false }, TWO_KINDS)
    expect(groups.map((group) => group.pluralLabel)).toEqual(['Letters', 'Memoranda'])
    expect(groups.map((group) => group.series.map((record) => record.id))).toEqual([['l1'], ['m1']])
  })

  /* A kind with nothing at all still gets its heading. That state is what this screen was
   * built to make visible, and an absent group is a kind nobody can see is broken. */
  it('keeps a kind with no series', () => {
    const groups = groupSeriesByKind(
      [seriesOf({ id: 'l1', kind: 'letter' })],
      { includeArchived: false },
      TWO_KINDS,
    )
    expect(groups.map((group) => [group.kind, group.series.length])).toEqual([
      ['letter', 1],
      ['memo', 0],
    ])
  })

  it('hides archived series unless they are asked for', () => {
    const all = [
      seriesOf({ id: 'live', kind: 'letter' }),
      seriesOf({ id: 'old', kind: 'letter', isArchived: true }),
    ]

    const hidden = groupSeriesByKind(all, { includeArchived: false }, TWO_KINDS)
    expect(hidden[0]?.series.map((record) => record.id)).toEqual(['live'])

    const shown = groupSeriesByKind(all, { includeArchived: true }, TWO_KINDS)
    expect(shown[0]?.series.map((record) => record.id)).toEqual(['live', 'old'])
  })

  /* Main orders a kind's series with its default first; re-sorting here would be a second
   * answer to a question it has already answered. The fixture disagrees with that order
   * so that preserving it is visible. */
  it('keeps the order main sent within a group', () => {
    const groups = groupSeriesByKind(
      [
        seriesOf({ id: 'second', kind: 'letter' }),
        seriesOf({ id: 'first', kind: 'letter', isDefault: true }),
      ],
      { includeArchived: false },
      TWO_KINDS,
    )
    expect(groups[0]?.series.map((record) => record.id)).toEqual(['second', 'first'])
  })

  /*
   * `hasDefault` IS A COMPOUND CONDITION AND EACH HALF GETS THE INPUT ONLY IT EXCLUDES.
   * A live series that is not the default is excluded by `isDefault` alone; an archived
   * series that still carries the flag is excluded by `!isArchived` alone. Drop either
   * clause and one of these two starts reporting a kind as numberable when nothing of it
   * can be issued.
   */
  it('sees no default when the only series is not one', () => {
    const groups = groupSeriesByKind(
      [seriesOf({ id: 'l1', kind: 'letter', isDefault: false })],
      { includeArchived: false },
      TWO_KINDS,
    )
    expect(groups[0]?.hasDefault).toBe(false)
  })

  it('sees no default when the series holding the flag is archived', () => {
    const groups = groupSeriesByKind(
      [seriesOf({ id: 'l1', kind: 'letter', isDefault: true, isArchived: true })],
      { includeArchived: true },
      TWO_KINDS,
    )
    expect(groups[0]?.series).toHaveLength(1)
    expect(groups[0]?.hasDefault).toBe(false)
  })

  it('sees the default when a live series holds it', () => {
    const groups = groupSeriesByKind(
      [
        seriesOf({ id: 'l1', kind: 'letter' }),
        seriesOf({ id: 'l2', kind: 'letter', isDefault: true }),
      ],
      { includeArchived: false },
      TWO_KINDS,
    )
    expect(groups[0]?.hasDefault).toBe(true)
  })

  /* Hiding the archived rows must not change whether a kind has a default — a live
   * default is never one of the rows being hidden. */
  it('reads the default off every series, not off the visible ones', () => {
    const all = [
      seriesOf({ id: 'live', kind: 'letter', isDefault: true }),
      seriesOf({ id: 'old', kind: 'letter', isArchived: true }),
    ]
    expect(groupSeriesByKind(all, { includeArchived: false }, TWO_KINDS)[0]?.hasDefault).toBe(true)
    expect(groupSeriesByKind(all, { includeArchived: true }, TWO_KINDS)[0]?.hasDefault).toBe(true)
  })

  /* A file a newer Coffer wrote. Its series are still the user's and are still shown. */
  it('puts a kind it does not know in a group of its own, at the end', () => {
    const groups = groupSeriesByKind(
      [seriesOf({ id: 'x1', kind: 'delivery-note' }), seriesOf({ id: 'l1', kind: 'letter' })],
      { includeArchived: false },
      TWO_KINDS,
    )
    expect(groups.map((group) => group.kind)).toEqual(['letter', 'memo', 'delivery-note'])
    expect(groups.at(-1)).toMatchObject({ isKnown: false, pluralLabel: 'delivery-note' })
    expect(groups[0]?.isKnown).toBe(true)
  })
})

describe('what stops a kind being numbered', () => {
  it('says so when there is no series at all', () => {
    expect(groupWarning({ series: [], hasDefault: false })).toMatch(/No series in use/)
  })

  /*
   * The state nobody thinks to look at: a series sits there, configured, and every issue
   * fails with "no series configured" because none of them is the default. It is reached
   * by archiving the default or by unticking the box on the only one there is.
   */
  it('says so when there is a series but none is the default', () => {
    expect(groupWarning({ series: [seriesOf({ id: 'l1' })], hasDefault: false })).toMatch(
      /No default/,
    )
  })

  it('says nothing when a live series holds the default', () => {
    expect(groupWarning({ series: [seriesOf({ id: 'l1' })], hasDefault: true })).toBeNull()
  })
})

describe('the fiscal year a preview is drawn in', () => {
  /*
   * TWO INDEPENDENT REASONS, EACH WITH THE FIXTURE ONLY IT CATCHES. A series that prints
   * the year but never restarts is caught by `includeFiscalYear` alone; one that restarts
   * without printing it is caught by `resetOn` alone. Drop either clause of
   * `needsFiscalYear` and exactly one of these two starts sending null — which main
   * refuses on the first and answers with last year's counter on the second.
   */
  it('needs the year for a series that prints it, even though it never restarts', () => {
    const series = { includeFiscalYear: true, resetOn: 'never' } as const
    expect(needsFiscalYear(series)).toBe(true)
    expect(previewYearFor(series, '2026-27')).toBe('2026-27')
  })

  it('needs the year for a series that restarts on it, even though it never prints it', () => {
    const series = { includeFiscalYear: false, resetOn: 'fiscal-year' } as const
    expect(needsFiscalYear(series)).toBe(true)
    expect(previewYearFor(series, '2026-27')).toBe('2026-27')
  })

  it('needs the year for a series that does both', () => {
    expect(needsFiscalYear({ includeFiscalYear: true, resetOn: 'fiscal-year' })).toBe(true)
  })

  /*
   * NULL IS THE ANSWER, NOT AN OMISSION. A quotation series that neither prints the year
   * nor restarts on it is in no fiscal year, and that is what main is told — even when a
   * year is sitting right there in the picker.
   */
  it('sends null for a series in no fiscal year, however many years the books keep', () => {
    const series = { includeFiscalYear: false, resetOn: 'never' } as const
    expect(needsFiscalYear(series)).toBe(false)
    expect(previewYearFor(series, '2026-27')).toBeNull()
  })

  /* Nothing true to preview. Main answers `FISCAL_YEAR_REQUIRED` — a sentence naming the
   * series — which is better than a blank the user has to interpret. */
  it('sends null when the year is needed and the books could not supply one', () => {
    expect(previewYearFor({ includeFiscalYear: true, resetOn: 'never' }, null)).toBeNull()
  })
})

describe('what the repair did', () => {
  /*
   * NOUGHT IS A SUCCESS AND READS LIKE ONE. `seedDefaults` answers how many series it
   * created, and on books already set up that number is nought — nothing was missing.
   */
  it('says nothing was missing rather than claiming to have done something', () => {
    expect(describeRepair(0)).toBe(
      'Nothing was missing. Every kind already had a series, so nothing was added and nothing changed.',
    )
  })

  it('says how many were added', () => {
    expect(describeRepair(1)).toBe('Added 1 series. Every kind now has one.')
    expect(describeRepair(2)).toBe('Added 2 series. Every kind now has one.')
    expect(describeRepair(9)).toBe('Added 9 series. Every kind now has one.')
  })
})
