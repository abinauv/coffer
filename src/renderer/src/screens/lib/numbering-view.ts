/*
 * What the numbering screen has to work out before it can draw anything.
 *
 * Pure, and holding no knowledge of what a number LOOKS like. `formatDocumentNumber` in
 * main/domain/documents is the only code that composes one, and `numbering.preview` is
 * how this screen asks it — see the header of db/repos/numbering.ts, which spends a
 * paragraph on why a second implementation of the padding would be a preview that can be
 * right while the thing it previews is wrong. Nothing here builds a number, and nothing
 * here may start to.
 *
 * ---------------------------------------------------------------------------
 * THE NINE KINDS ARE DERIVED, NOT LISTED
 *
 * `NUMBERED_KINDS` below is `DOCUMENT_KINDS` followed by `RECEIPT_KINDS`, which is
 * exactly how `NUMBERED_KINDS` in main/domain/documents composes them and exactly how
 * ipc/handlers/numbering.ts derives what it will accept. Three derivations of one fact
 * rather than three copies of it: a tenth kind added to either table is offered by this
 * screen on the day it is added, and the "what is missing from this company file"
 * question below cannot answer against a list that has gone stale.
 *
 * That question is the whole reason this screen was owed. A file made before migration
 * 0012 has no series at all and can issue NOTHING; a file made before 0015 has no
 * `refund` and no `refund-received` series. Both are repaired by `numbering.seedDefaults`,
 * and what makes the repair safe is that the seed table is total over the kinds and skips
 * whatever already exists — so this file's job is only to say what is missing, in the
 * kinds' own words.
 */

import type { AccountingPeriod, DateString, NumberingSeriesRecord } from '@shared/dto'
import { DOCUMENT_KINDS } from '@shared/documents'
import { RECEIPT_KINDS } from '@shared/receipts'

/** Enough of a numbered kind to head a group and name it in a sentence. */
export interface NumberedKindOption {
  kind: string
  /** What the user sees, singular. Off the kind table — never written out here. */
  label: string
  /** What the user sees for many of them. Heads the group of a kind's series. */
  pluralLabel: string
}

/**
 * Everything a series may be created for: the five trade documents, then the four
 * vouchers.
 *
 * The order is the domain's, not a preference — see the header.
 */
export const NUMBERED_KINDS: readonly NumberedKindOption[] = [
  ...DOCUMENT_KINDS.map(({ kind, label, pluralLabel }) => ({ kind, label, pluralLabel })),
  ...RECEIPT_KINDS.map(({ kind, label, pluralLabel }) => ({ kind, label, pluralLabel })),
]

/**
 * The definition for a kind, or undefined for one this build has never heard of.
 *
 * A lookup by an identity key rather than a rule, which is why a `find` is honest here:
 * `kind` is the primary key of both tables, so "the first match" and "the only match" are
 * the same row by construction. Contrast `postingKindIn`, where the thing being searched
 * for is a PROPERTY and a `find` would quietly mean "whichever is listed first".
 */
function definitionIn(
  kinds: readonly NumberedKindOption[],
  kind: string,
): NumberedKindOption | undefined {
  return kinds.find((definition) => definition.kind === kind)
}

/**
 * What to call a kind.
 *
 * Falls back to the kind as the company file spells it, rather than throwing the way
 * `numberedKindDefinition` does. The domain throws because every caller there holds a
 * `NumberedKind` that the type system already narrowed; this one is handed whatever is in
 * the `numbering_series` table, and a file written by a newer Coffer would take the whole
 * settings screen down with it. Showing the raw kind is not writing a name by hand — it
 * is the file's own word for it, which is the only honest thing left to say.
 */
export function numberedKindLabel(
  kind: string,
  kinds: readonly NumberedKindOption[] = NUMBERED_KINDS,
): string {
  return definitionIn(kinds, kind)?.label ?? kind
}

/**
 * The kinds this company file has no series for at all.
 *
 * COUNTED OVER EVERY SERIES, ARCHIVED ONES INCLUDED, and that is the one decision in this
 * function. `seedDefaultSeries` skips a kind that already has a series without looking at
 * whether it is archived, so a kind whose only series has been archived is NOT missing —
 * the repair would create nothing for it. Computing this from the rows the screen happens
 * to be showing would offer a repair that does nothing and report `0` as if something had
 * gone wrong. A kind in that state cannot number anything either, and it is `groupWarning`
 * that says so, because archiving is a choice somebody made and not a broken file.
 */
export function kindsWithoutSeries(
  all: readonly NumberingSeriesRecord[],
  kinds: readonly NumberedKindOption[] = NUMBERED_KINDS,
): readonly NumberedKindOption[] {
  const present = new Set(all.map((series) => series.kind))
  return kinds.filter((definition) => !present.has(definition.kind))
}

/** A kind, its series, and whether anything of that kind can actually be numbered. */
export interface SeriesGroup extends NumberedKindOption {
  /** False for a kind only a newer Coffer knows. Its label is then the raw kind. */
  isKnown: boolean
  /** The series to show, in the order main sent them. Archived ones per the option. */
  series: readonly NumberingSeriesRecord[]
  /**
   * Whether a LIVE series of this kind holds the default.
   *
   * Read off every series of the kind rather than off the visible ones, so that hiding
   * the archived rows cannot change the answer. It could not anyway — a live default is
   * never one of the rows being hidden — and saying it in one place is cheaper than
   * having to prove that again each time this is read.
   */
  hasDefault: boolean
}

/**
 * The series, grouped under the kind each one numbers.
 *
 * TOTAL OVER THE KIND TABLE (CONVENTIONS §1.9): every kind gets a group, including the
 * ones with nothing in them, because a kind with no series is the state this screen was
 * built to make visible. A kind the tables do not know gets a group of its own at the
 * end, so a file written by a newer build still shows the user their own series.
 *
 * WITHIN A GROUP THE ORDER IS MAIN'S. `listSeries` orders by kind, then the default
 * first, then the label — and re-sorting here would be a second answer to a question main
 * has already answered. Which is also why the fixtures put a default somewhere other than
 * first: a screen that marked row one would otherwise pass.
 *
 * The kind table is an argument so a test can hand it one the shipped tables cannot be —
 * a kind with no series, an unknown kind, a table in another order — rather than the
 * assertions all having to agree with the real nine (CONVENTIONS §6).
 */
export function groupSeriesByKind(
  all: readonly NumberingSeriesRecord[],
  options: { includeArchived: boolean },
  kinds: readonly NumberedKindOption[] = NUMBERED_KINDS,
): readonly SeriesGroup[] {
  const byKind = new Map<string, NumberingSeriesRecord[]>()
  for (const series of all) {
    const bucket = byKind.get(series.kind)
    if (bucket === undefined) byKind.set(series.kind, [series])
    else bucket.push(series)
  }

  const known = kinds.map((definition) =>
    buildGroup(definition, true, byKind.get(definition.kind) ?? [], options),
  )

  const unknown = [...byKind.entries()]
    .filter(([kind]) => definitionIn(kinds, kind) === undefined)
    .map(([kind, series]) =>
      buildGroup({ kind, label: kind, pluralLabel: kind }, false, series, options),
    )

  return [...known, ...unknown]
}

function buildGroup(
  definition: NumberedKindOption,
  isKnown: boolean,
  ofKind: readonly NumberingSeriesRecord[],
  options: { includeArchived: boolean },
): SeriesGroup {
  return {
    ...definition,
    isKnown,
    hasDefault: ofKind.some((series) => series.isDefault && !series.isArchived),
    series: options.includeArchived ? ofKind : ofKind.filter((series) => !series.isArchived),
  }
}

/**
 * What stops this kind being numbered, or null when nothing does.
 *
 * TWO STATES, AND EACH IS REACHED BY AN INPUT THE OTHER EXCLUDES. No series at all is a
 * company file older than the kind. A series with no LIVE default is the state
 * `defaultSeriesFor` answers null for — every issue of that kind fails with "no series
 * configured" while one sits there, configured — and it is reached by archiving the
 * default, or by unticking the box on the only series there is. The second is the one
 * nobody thinks to look at, which is why it gets a sentence rather than an empty cell.
 *
 * Order matters: an empty group has no default either, so the emptier state is answered
 * first and the "choose one" advice is never given about a kind that has none to choose.
 */
export function groupWarning(group: Pick<SeriesGroup, 'series' | 'hasDefault'>): string | null {
  if (group.series.length === 0) {
    return 'No series in use — nothing of this kind can be numbered.'
  }
  if (!group.hasDefault) {
    return 'No default — nothing of this kind can be numbered until one series is made the default.'
  }
  return null
}

/**
 * Whether a preview or an allocation for this series needs the fiscal year.
 *
 * TWO INDEPENDENT REASONS, EITHER OF WHICH IS ENOUGH, and neither implies the other —
 * this is `assertFiscalYear` in db/repos/numbering.ts asked from the other side.
 *
 *   - It PRINTS the year, and dropping the segment gives a number that collides with last
 *     year's. `resetOn` is 'never' in that case and says nothing about it.
 *   - It RESETS on the year, and the label is which counter to draw from. It may not print
 *     the year at all, so `includeFiscalYear` is false and says nothing about it either.
 *
 * `counterScopeOf` reads `resetOn` and not `includeFiscalYear` on purpose; this is the
 * same separation, stated as a question.
 */
export function needsFiscalYear(
  series: Pick<NumberingSeriesRecord, 'includeFiscalYear' | 'resetOn'>,
): boolean {
  return series.includeFiscalYear || series.resetOn === 'fiscal-year'
}

/**
 * The `fiscalYearLabel` to send with a preview of this series.
 *
 * NULL IS AN ANSWER HERE, NOT AN OMISSION. `PreviewNumberInput.fiscalYearLabel` is
 * nullable and required for exactly this reason: null means "this number is in no fiscal
 * year", which is the truth for a series that neither prints the year nor resets on it,
 * and an absent field means a screen forgot to ask — which main refuses rather than
 * guessing. So the screen decides, once, here, and always sends the field.
 *
 * When the series does need a year and the books could not supply one, this returns null
 * as well, and main answers `FISCAL_YEAR_REQUIRED` — a sentence naming the series. That
 * is better than a silent blank: the screen has nothing true to preview and says why.
 */
export function previewYearFor(
  series: Pick<NumberingSeriesRecord, 'includeFiscalYear' | 'resetOn'>,
  fiscalYearLabel: string | null,
): string | null {
  return needsFiscalYear(series) ? fiscalYearLabel : null
}

/** One financial year these books keep, and the days it covers. */
export interface FiscalYear {
  /** As the regime spells it — '2026-27' in India. Main's word, never composed here. */
  label: string
  from: DateString
  to: DateString
}

/**
 * The financial years these books keep, earliest first.
 *
 * Derived from the periods rather than computed from a date, because the label is the
 * regime's and the renderer does not know how a year is named — '2026-27' in India,
 * '2026' where the year is the calendar one. Working one out here would be a second
 * spelling that agrees with main until somebody's books start in July.
 *
 * Dates are `YYYY-MM-DD`, so a string comparison is a date comparison (CONVENTIONS §3).
 */
export function fiscalYearsFrom(periods: readonly AccountingPeriod[]): readonly FiscalYear[] {
  const byLabel = new Map<string, FiscalYear>()

  for (const period of periods) {
    const existing = byLabel.get(period.fiscalYearLabel)
    if (existing === undefined) {
      byLabel.set(period.fiscalYearLabel, {
        label: period.fiscalYearLabel,
        from: period.startDate,
        to: period.endDate,
      })
      continue
    }
    if (period.startDate < existing.from) existing.from = period.startDate
    if (period.endDate > existing.to) existing.to = period.endDate
  }

  return [...byLabel.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
}

/**
 * The year a preview should be drawn in when nobody has chosen one.
 *
 * The year today falls in, because that is the year the next document will be raised in.
 * Failing that the latest the books keep — a file whose periods all lie in the past still
 * has a most recent year, and previewing that is more use than previewing nothing.
 *
 * Both ends inclusive: a period's `endDate` is documented as inclusive, and the last day
 * of a financial year is a day on which invoices are raised.
 */
export function currentFiscalYear(years: readonly FiscalYear[], today: DateString): string | null {
  const containing = years.find((year) => year.from <= today && today <= year.to)
  return containing?.label ?? years.at(-1)?.label ?? null
}

/**
 * What the repair did, in words.
 *
 * ZERO IS A SUCCESS AND HAS TO READ LIKE ONE. `seedDefaults` answers how many series it
 * created, and on books somebody has already configured that number is nought — nothing
 * was missing. A screen that said "done" over both would be claiming success over a
 * no-op, and one that treated nought as a failure would send somebody looking for a
 * problem that is not there.
 */
export function describeRepair(created: number): string {
  if (created === 0) {
    return 'Nothing was missing. Every kind already had a series, so nothing was added and nothing changed.'
  }
  /* 'series' is its own plural, so there is no branch here and no `1 series`/`2 seriess`
   * to get wrong. The count is said in figures because the user is being told what
   * changed in their books. */
  return `Added ${String(created)} series. Every kind now has one.`
}
