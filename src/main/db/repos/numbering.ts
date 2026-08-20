/*
 * The numbering repository — which series a document takes, and the one place a number
 * is spent.
 *
 * Read migration 0007 first, and rule 2 at the top of domain/documents/types.ts before
 * that: the number is allocated at issue and never released. Everything in this file is
 * that sentence turned into functions. There is no `releaseNumber`, no `resetCounter`
 * and no `undoAllocation`, and adding one would not be a feature — it would be a gap in
 * a series that somebody has to explain to an officer, on a date nobody can identify.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE DOES NOT KNOW WHAT A NUMBER LOOKS LIKE
 *
 * `paddedSequence`, `formatDocumentNumber`, `previewOf` and `counterScopeOf` in
 * domain/documents/numbering.ts are the only code that composes a number, and this file
 * calls them rather than repeating any part of them. A second implementation of the
 * padding here would be a second answer to "what does this series produce", and the two
 * would agree right up until the day a preview stopped matching what was issued.
 *
 * What this file decides is narrower and is the part that needs a database: WHICH
 * counter a number comes from, and how the counter moves.
 *
 * ---------------------------------------------------------------------------
 * ALLOCATION IS ONE STATEMENT
 *
 * `allocateNumber` reads and advances the counter in a single `UPDATE ... RETURNING`.
 * Reading the counter, adding one in JavaScript and writing it back would be a race with
 * a window between the two halves, and the prize for losing it is two invoices carrying
 * one number — which is not a crash, not a log line and not something any report shows.
 * The row is brought into existence first by an upsert that hands nothing out, so the
 * statement that does the spending is always an UPDATE of a row that already exists.
 *
 * Measured rather than asserted (see the tests): a hundred allocations in a row produce
 * a hundred distinct sequences with no gaps, and an allocation whose counter was moved
 * by another writer in between continues from where that writer left it rather than from
 * anything this process had read earlier.
 *
 * ---------------------------------------------------------------------------
 * IT COMPOSES WITH THE TRANSACTION THAT ISSUES THE DOCUMENT
 *
 * Issuing is one transaction (rule 3): the journal entry, the status and the number are
 * written together or not at all. So every function here runs its work through
 * `inTransaction`, which starts a transaction when it is handed a plain connection and
 * joins the caller's when it is handed one already open.
 *
 * That test is not decoration. Kysely refuses `trx.transaction()` outright rather than
 * opening a savepoint, so a repository function that always opens its own transaction is
 * one that cannot be called from inside `postEntry` — the measurement and the rest of the
 * argument are in ./transaction.ts, which `postEntry` now goes through for the same
 * reason. The consequence that matters is at the other end: a document that fails to post
 * rolls the allocation back with it, and the number is not spent on a document that does
 * not exist.
 *
 * ---------------------------------------------------------------------------
 * THE FISCAL YEAR IS REFUSED HERE AS WELL AS IN THE DOMAIN, AND NOT TWICE OVER
 *
 * `formatDocumentNumber` throws when a series that shows the year is given none. That is
 * a programmer error caught at the last moment, and it stays where it is. This file
 * refuses the same call earlier and for a different reason: by the time the formatting
 * runs, the counter has already moved, and a throw at that point has spent a number on a
 * document that will never exist. So the check here is not a copy of the domain's — it
 * is the same question asked before anything is written rather than after, and it is
 * answered with `FISCAL_YEAR_REQUIRED`, which a user can act on.
 *
 * It is also a wider question than the domain's. A series that RESETS on the fiscal year
 * needs the label to know which counter to draw from, whether or not the number shows it
 * — `counterScopeOf` reads `resetOn` and not `includeFiscalYear`, on purpose.
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'

import {
  counterScopeOf,
  definitionOf,
  formatDocumentNumber,
  postsToLedger,
  type DocumentKind,
  type NumberingSeries,
} from '@main/domain/documents'
import type {
  CreateNumberingSeriesInput,
  ListNumberingSeriesInput,
  NumberPreview,
  NumberingReset,
  NumberingSeriesRecord,
  UpdateNumberingSeriesInput,
} from '@shared/dto'

import type { CofferDb } from '../kysely'
import type { NumberingSeriesTable } from '../schema'
import { RepoError } from './errors'
import { inTransaction } from './transaction'

type SeriesColumns = {
  [K in keyof NumberingSeriesTable]: NumberingSeriesTable[K]
}

type SeriesRow = SeriesColumns & { has_issued: number }

/** What the default series takes when the caller does not say. Four digits: `0001`. */
const DEFAULT_WIDTH = 4

/** Matches the CHECK in 0007. Both exist; see `requireWidth`. */
const MIN_WIDTH = 0
const MAX_WIDTH = 12

/** The first sequence any counter hands out. The floor is also a CHECK in 0007. */
const FIRST_SEQUENCE = 1

/**
 * Whether a series has ever handed a number out, asked of the counters.
 *
 * Derived and never stored (CONVENTIONS §1.3). A counter row exists because an
 * allocation created it, so "there is a counter" and "a number is on a document" are the
 * same fact — which is why `ON DELETE RESTRICT` on the counters' foreign key enforces
 * exactly this rule without knowing it exists.
 */
const HAS_ISSUED = sql<number>`EXISTS (
  SELECT 1 FROM numbering_counters WHERE series_id = numbering_series.id
)`

function selectSeries(db: CofferDb) {
  return db.selectFrom('numbering_series').selectAll().select(HAS_ISSUED.as('has_issued'))
}

// ---- Reading ---------------------------------------------------------------

/**
 * The series, ordered the way a settings screen lists them.
 *
 * Kind first, then the default for that kind, then by label. The default sits at the top
 * of its group because it is the answer to the only question this screen is really
 * asked: which one does a new invoice take.
 *
 * Archived series are excluded by default. One offered in a picker is one somebody
 * numbers a document with after the business stopped using it, and the number lands in
 * the middle of a sequence that was finished.
 */
export async function listSeries(
  db: CofferDb,
  input: ListNumberingSeriesInput = {},
): Promise<NumberingSeriesRecord[]> {
  let query = selectSeries(db)

  if (input.includeArchived !== true) {
    query = query.where('is_archived', '=', 0)
  }
  if (input.kind !== undefined) {
    query = query.where('kind', '=', requireKind(input.kind))
  }

  const rows = await query
    .orderBy('kind')
    .orderBy('is_default', 'desc')
    .orderBy(sql`label COLLATE NOCASE`)
    .execute()
  return rows.map(toRecord)
}

export async function getSeries(db: CofferDb, id: string): Promise<NumberingSeriesRecord | null> {
  const row = await selectSeries(db).where('id', '=', id).executeTakeFirst()
  return row === undefined ? null : toRecord(row)
}

/**
 * The series a new document of that kind takes, or null when the kind has none.
 *
 * Null rather than a throw, and no fallback to "the only series there is". A fallback
 * would be a second rule about which series a document takes, and it would change its
 * answer silently on the day somebody added a second series — which is the day the
 * business is least able to notice that its invoices moved to another sequence. The
 * caller that is issuing a document turns null into `SERIES_NOT_CONFIGURED`, where it
 * can say which document it was.
 *
 * Archived series are not candidates, which is why the partial unique index in 0007
 * leaves them out of the one-default-per-kind rule as well. The two must agree or a
 * kind can end up with a default nothing may use.
 */
export async function defaultSeriesFor(
  db: CofferDb,
  kind: DocumentKind,
): Promise<NumberingSeriesRecord | null> {
  const row = await selectSeries(db)
    .where('kind', '=', kind)
    .where('is_default', '=', 1)
    .where('is_archived', '=', 0)
    .executeTakeFirst()
  return row === undefined ? null : toRecord(row)
}

// ---- Writing ---------------------------------------------------------------

export async function createSeries(
  db: CofferDb,
  input: CreateNumberingSeriesInput,
): Promise<NumberingSeriesRecord> {
  const kind = requireKind(input.kind)
  const label = requireLabel(input.label)
  const width = requireWidth(input.width ?? DEFAULT_WIDTH)

  return inTransaction(db, async (trx) => {
    await assertLabelFree(trx, kind, label, null)

    /*
     * The first series a kind gets is its default unless the caller says otherwise. A
     * kind with a series and no default numbers nothing — every issue fails with "no
     * series configured" while exactly one sits there, configured — and the tick box
     * that fixes it is the one thing nobody thinks to look at. An explicit `false` is
     * still honoured: that is somebody setting up two series before choosing.
     */
    const isDefault = input.isDefault ?? !(await hasLiveDefault(trx, kind, null))

    const now = new Date().toISOString()
    if (isDefault) {
      await clearDefault(trx, kind, null, now)
    }

    const id = randomUUID()
    await trx
      .insertInto('numbering_series')
      .values({
        id,
        kind,
        label,
        prefix: input.prefix ?? '',
        suffix: input.suffix ?? '',
        separator: input.separator ?? '',
        include_fiscal_year: input.includeFiscalYear === true ? 1 : 0,
        width,
        reset_on: input.resetOn ?? defaultResetFor(kind),
        is_default: isDefault ? 1 : 0,
        is_archived: 0,
        created_at: now,
        updated_at: now,
      })
      .execute()

    return requireSeries(trx, id)
  })
}

/**
 * Change a series.
 *
 * Only the fields that were sent are written, with two exceptions: `is_default` and
 * `is_archived` are computed as the row's next state and always written, because the two
 * are coupled — archiving takes a series out of the running for the default, and coming
 * back does not automatically put it in again.
 *
 * `kind` is not a field. Moving a series to another kind would renumber the documents
 * already issued under it, which is why `UpdateNumberingSeriesInput` has no such field
 * and why 0007's trigger names the column anyway.
 */
export async function updateSeries(
  db: CofferDb,
  input: UpdateNumberingSeriesInput,
): Promise<NumberingSeriesRecord> {
  const width = input.width === undefined ? undefined : requireWidth(input.width)

  return inTransaction(db, async (trx) => {
    const existing = await requireSeries(trx, input.id)
    const kind = requireKind(existing.kind)

    /*
     * A series that has numbered something does not change shape. Changing the prefix or
     * the width after `INV/2026-27/0001` exists produces a second series that looks like
     * a continuation of the first and is not; changing `reset_on` is worse than that,
     * because it moves the series to a different counter scope, and a scope with no
     * counter starts at 1 and reissues every number the series has already given out.
     * Also a trigger in 0007 — this check is here so the answer is a sentence.
     */
    const changed = shapeChangesIn(existing, input, width)
    if (changed.length > 0 && existing.hasIssued) {
      throw new RepoError(
        'SERIES_IN_USE',
        `${existing.label} has already numbered a document, so its shape is fixed. ` +
          'Create a new series instead.',
        { id: existing.id, changed },
      )
    }

    const now = new Date().toISOString()
    const update: Partial<SeriesColumns> = { updated_at: now }

    if (input.label !== undefined) {
      const label = requireLabel(input.label)
      await assertLabelFree(trx, kind, label, existing.id)
      update.label = label
    }
    /* Not trimmed, and that is not an oversight: a space is a legitimate separator, and
     * a prefix that ends in one is somebody's existing format. */
    if (input.prefix !== undefined) update.prefix = input.prefix
    if (input.suffix !== undefined) update.suffix = input.suffix
    if (input.separator !== undefined) update.separator = input.separator
    if (input.includeFiscalYear !== undefined) {
      update.include_fiscal_year = input.includeFiscalYear ? 1 : 0
    }
    if (width !== undefined) update.width = width
    if (input.resetOn !== undefined) update.reset_on = input.resetOn

    const isArchived = input.isArchived ?? existing.isArchived
    let isDefault = input.isDefault ?? existing.isDefault

    if (isDefault && !isArchived) {
      if (input.isDefault === true) {
        /* An explicit choice takes the slot off whoever holds it. Without this, moving
         * the default is a UNIQUE constraint error naming an index. */
        await clearDefault(trx, kind, existing.id, now)
      } else if (await hasLiveDefault(trx, kind, existing.id)) {
        /* Coming back from the archive still carrying the flag it went in with. The
         * default moved on while it was away, and a series returning must not silently
         * take the numbering back off the one the business has been using since. */
        isDefault = false
      }
    }

    update.is_default = isDefault ? 1 : 0
    update.is_archived = isArchived ? 1 : 0

    await trx.updateTable('numbering_series').set(update).where('id', '=', existing.id).execute()

    return requireSeries(trx, existing.id)
  })
}

/**
 * Stop offering a series, or offer it again.
 *
 * `updateSeries` does the work rather than a second implementation beside it: archiving
 * and the default flag are one rule, and two functions holding half of it each is how
 * they come to disagree.
 */
export async function archiveSeries(
  db: CofferDb,
  id: string,
  archived: boolean,
): Promise<NumberingSeriesRecord> {
  return updateSeries(db, { id, isArchived: archived })
}

/**
 * Remove a series entirely.
 *
 * Only one that has never handed out a number — `ON DELETE RESTRICT` on the counters
 * would refuse the rest anyway, and this check exists so the caller gets a sentence
 * rather than a constraint name. A series with numbers behind it is archived, never
 * deleted: deleting it throws away how far it had got, and the next series created in
 * its place starts at 1 and reissues numbers that are on documents.
 */
export async function deleteSeries(db: CofferDb, id: string): Promise<void> {
  return inTransaction(db, async (trx) => {
    const existing = await requireSeries(trx, id)
    if (existing.hasIssued) {
      throw new RepoError(
        'SERIES_IN_USE',
        `${existing.label} has numbered documents. Archive it instead.`,
        { id },
      )
    }
    await trx.deleteFrom('numbering_series').where('id', '=', id).execute()
  })
}

// ---- Numbers ---------------------------------------------------------------

/**
 * What the series would produce next. Spends nothing.
 *
 * The same code path as a real allocation, minus the write — `formatDocumentNumber` over
 * the sequence the counter is sitting on. A preview built any other way is a preview
 * that can be right while the thing it previews is wrong.
 *
 * `fiscalYearLabel` on the result is the COUNTER'S scope and not the label printed in
 * the number, which are different things for a series that shows the year and runs on
 * across years. It is null for such a series exactly as `NumberingCounter` is, so that
 * the pair (`fiscalYearLabel`, `nextSequence`) identifies one counter row.
 */
export async function previewNumber(
  db: CofferDb,
  seriesId: string,
  fiscalYearLabel: string | null,
): Promise<NumberPreview> {
  const series = toDomain(await requireSeries(db, seriesId))
  assertFiscalYear(series, fiscalYearLabel)

  const scope = fiscalYearLabel === null ? null : counterScopeOf(series, fiscalYearLabel)
  const nextSequence = await counterAt(db, seriesId, scope ?? '')

  return {
    seriesId,
    fiscalYearLabel: scope,
    nextSequence,
    preview: formatDocumentNumber(series, { fiscalYearLabel, sequence: nextSequence }),
  }
}

/**
 * Hand out the next number and move the counter past it.
 *
 * THE NUMBER THIS RETURNS IS SPENT. There is no operation that gives one back, and there
 * must not be: a released number is a gap in a series that rule 46(b) requires to be
 * consecutive, and the cost of it is a conversation with an officer about an invoice
 * nobody can produce. A document that is abandoned after this call keeps its number by
 * being cancelled rather than deleted, and a document that fails to post takes the
 * allocation down with it because both are in the caller's transaction.
 *
 * The advance is one statement. See the header for why, and the tests for the
 * demonstration rather than the assertion.
 */
export async function allocateNumber(
  db: CofferDb,
  seriesId: string,
  fiscalYearLabel: string | null,
): Promise<string> {
  return inTransaction(db, async (trx) => {
    const series = toDomain(await requireSeries(trx, seriesId))
    assertFiscalYear(series, fiscalYearLabel)

    const scope = fiscalYearLabel === null ? null : counterScopeOf(series, fiscalYearLabel)
    const scopeKey = scope ?? ''
    const now = new Date().toISOString()

    /* Bring the counter into existence without handing anything out, so that the
     * statement below is always an UPDATE of a row that is already there. Idempotent:
     * a second call in the same scope changes nothing. */
    await sql`
      INSERT INTO numbering_counters (series_id, fiscal_year_label, next_sequence, updated_at)
      VALUES (${seriesId}, ${scopeKey}, ${FIRST_SEQUENCE}, ${now})
      ON CONFLICT (series_id, fiscal_year_label) DO NOTHING
    `.execute(trx)

    /* Read and advance in one statement. `RETURNING` reports the row as it is after the
     * update, so the sequence handed out is one less than what the counter now holds. */
    const advanced = await sql<{ sequence: number }>`
      UPDATE numbering_counters
      SET next_sequence = next_sequence + 1, updated_at = ${now}
      WHERE series_id = ${seriesId} AND fiscal_year_label = ${scopeKey}
      RETURNING next_sequence - 1 AS sequence
    `.execute(trx)

    const sequence = advanced.rows[0]?.sequence
    if (sequence === undefined) {
      /* Unreachable: the upsert above put the row there in this same transaction. A
       * throw rather than a retry, because a missing counter means something is writing
       * to these tables that this file does not know about (CONVENTIONS §5). */
      throw new Error(
        `The counter for series ${seriesId} in scope '${scopeKey}' was gone by the time it ` +
          'was advanced. Nothing may write to numbering_counters except this repository.',
      )
    }

    return formatDocumentNumber(series, { fiscalYearLabel, sequence })
  })
}

// ---- Guards ----------------------------------------------------------------

async function requireSeries(db: CofferDb, id: string): Promise<NumberingSeriesRecord> {
  const series = await getSeries(db, id)
  if (series === null) {
    throw new RepoError('SERIES_NOT_FOUND', 'That numbering series is not in these books.', { id })
  }
  return series
}

/**
 * The kind, checked against the five the domain knows.
 *
 * `definitionOf` throws rather than returning a null, which is the right shape here: a
 * kind reaches this file from a picker over `DOCUMENT_KINDS`, so anything else is a
 * programmer error and not something a user can act on (CONVENTIONS §5). The cast is the
 * question; the call is the answer. Also a CHECK in 0007, which is the floor under
 * anything that reaches the table another way.
 */
function requireKind(kind: string): DocumentKind {
  return definitionOf(kind as DocumentKind).kind
}

function requireLabel(value: string): string {
  const label = value.trim()
  if (label === '') {
    throw new RepoError('SERIES_LABEL_REQUIRED', 'A numbering series needs a label.', {})
  }
  return label
}

/**
 * The padding width, within the range 0007 also CHECKs.
 *
 * Zero is padding off, which is a real series. The ceiling is about a number a person
 * can read rather than about storage, and nothing reaches it by counting: a sequence
 * that outgrows its width grows longer instead of being cut down into a number an
 * earlier document already carries (`paddedSequence`).
 */
function requireWidth(value: number): number {
  if (!Number.isInteger(value) || value < MIN_WIDTH || value > MAX_WIDTH) {
    throw new RepoError(
      'SERIES_WIDTH_INVALID',
      `A sequence is padded to between ${MIN_WIDTH} and ${MAX_WIDTH} digits. ` +
        `${JSON.stringify(value)} is not a width.`,
      { width: value },
    )
  }
  return value
}

/**
 * Refuse a label another series of the same kind holds, ignoring case.
 *
 * `COLLATE NOCASE` to match the unique index exactly, for the reason `assertNameFree`
 * gives in parties.ts: a case-sensitive check here would leave the index as the only
 * thing catching `Export` against `EXPORT`, and an index reports a constraint name
 * rather than the label that clashed.
 */
async function assertLabelFree(
  db: CofferDb,
  kind: DocumentKind,
  label: string,
  exceptId: string | null,
): Promise<void> {
  let query = db
    .selectFrom('numbering_series')
    .select(['id', 'label'])
    .where('kind', '=', kind)
    .where((eb) => eb(sql<string>`label COLLATE NOCASE`, '=', label))
  if (exceptId !== null) {
    query = query.where('id', '!=', exceptId)
  }

  const clash = await query.executeTakeFirst()
  if (clash !== undefined) {
    throw new RepoError(
      'SERIES_LABEL_TAKEN',
      `${definitionOf(kind).label} already has a series called ${clash.label}.`,
      { kind, label, existingLabel: clash.label },
    )
  }
}

/**
 * Refuse an allocation or a preview that cannot say which year it is in.
 *
 * Two independent reasons a series needs the label, and either is enough. It may PRINT
 * the year, in which case dropping the segment gives a number that collides with last
 * year's — precisely what including the year prevents. Or it may RESET on the year, in
 * which case the label is which counter to draw from, and guessing would draw from the
 * wrong one. `counterScopeOf` reads `resetOn` and not `includeFiscalYear` because the
 * two are separate choices; this guard is the same separation stated as a refusal.
 */
function assertFiscalYear(series: NumberingSeries, fiscalYearLabel: string | null): void {
  if (fiscalYearLabel !== null) {
    return
  }
  if (!series.includeFiscalYear && series.resetOn !== 'fiscal-year') {
    return
  }
  throw new RepoError(
    'FISCAL_YEAR_REQUIRED',
    `${series.label} is numbered by financial year. Say which year the document falls in.`,
    {
      seriesId: series.id,
      includeFiscalYear: series.includeFiscalYear,
      resetOn: series.resetOn,
    },
  )
}

/** Whether a live series of this kind already holds the default. */
async function hasLiveDefault(
  db: CofferDb,
  kind: DocumentKind,
  exceptId: string | null,
): Promise<boolean> {
  let query = db
    .selectFrom('numbering_series')
    .select('id')
    .where('kind', '=', kind)
    .where('is_default', '=', 1)
    .where('is_archived', '=', 0)
  if (exceptId !== null) {
    query = query.where('id', '!=', exceptId)
  }
  return (await query.executeTakeFirst()) !== undefined
}

/**
 * Take the default off every live series of a kind but one.
 *
 * Archived rows are left alone: they are outside the partial unique index in 0007 and
 * keep the flag they went in with, which is a record of what they once were.
 */
async function clearDefault(
  db: CofferDb,
  kind: DocumentKind,
  exceptId: string | null,
  now: string,
): Promise<void> {
  let query = db
    .updateTable('numbering_series')
    .set({ is_default: 0, updated_at: now })
    .where('kind', '=', kind)
    .where('is_default', '=', 1)
    .where('is_archived', '=', 0)
  if (exceptId !== null) {
    query = query.where('id', '!=', exceptId)
  }
  await query.execute()
}

/** Where the counter for one scope has got to, or the first sequence when it has none. */
async function counterAt(db: CofferDb, seriesId: string, scopeKey: string): Promise<number> {
  const row = await db
    .selectFrom('numbering_counters')
    .select('next_sequence')
    .where('series_id', '=', seriesId)
    .where('fiscal_year_label', '=', scopeKey)
    .executeTakeFirst()
  return row?.next_sequence ?? FIRST_SEQUENCE
}

/**
 * Which of the shape fields an update would actually change.
 *
 * Compared by value rather than by presence, because a settings screen posts the whole
 * record back: re-sending the prefix a series already has is not a change to it, and
 * refusing that would make the default flag uneditable on any series that has issued.
 * 0007's trigger compares OLD against NEW for the same reason.
 */
function shapeChangesIn(
  existing: NumberingSeriesRecord,
  input: UpdateNumberingSeriesInput,
  width: number | undefined,
): string[] {
  const changed: string[] = []
  if (input.prefix !== undefined && input.prefix !== existing.prefix) changed.push('prefix')
  if (input.suffix !== undefined && input.suffix !== existing.suffix) changed.push('suffix')
  if (input.separator !== undefined && input.separator !== existing.separator) {
    changed.push('separator')
  }
  if (
    input.includeFiscalYear !== undefined &&
    input.includeFiscalYear !== existing.includeFiscalYear
  ) {
    changed.push('includeFiscalYear')
  }
  if (width !== undefined && width !== existing.width) changed.push('width')
  if (input.resetOn !== undefined && input.resetOn !== existing.resetOn) changed.push('resetOn')
  return changed
}

/**
 * What a kind's counter does when the year turns, when nobody has said.
 *
 * A kind that reaches the ledger is a supply, and rule 46(b) wants its series
 * consecutive within a financial year. A quotation reaches no ledger and nothing has
 * been supplied, so a running series is the sensible default and the one every business
 * that quotes already uses. Read off `postsToLedger` rather than off a list of kinds, so
 * that a kind added later gets the right answer by declaring itself.
 */
function defaultResetFor(kind: DocumentKind): NumberingReset {
  return postsToLedger(kind) ? 'fiscal-year' : 'never'
}

// ---- Conversion ------------------------------------------------------------

function toRecord(row: SeriesRow): NumberingSeriesRecord {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    prefix: row.prefix,
    suffix: row.suffix,
    separator: row.separator,
    includeFiscalYear: row.include_fiscal_year === 1,
    width: row.width,
    resetOn: row.reset_on,
    isDefault: row.is_default === 1,
    isArchived: row.is_archived === 1,
    hasIssued: row.has_issued === 1,
  }
}

/**
 * The record as the domain's `NumberingSeries`.
 *
 * The DTO carries `kind` as a string because IPC does; the domain carries the union.
 * `requireKind` is what makes the crossing sound, and 0007's CHECK is what makes it
 * sound for a row this repository did not write.
 */
function toDomain(record: NumberingSeriesRecord): NumberingSeries {
  return {
    id: record.id,
    kind: requireKind(record.kind),
    label: record.label,
    prefix: record.prefix,
    suffix: record.suffix,
    separator: record.separator,
    includeFiscalYear: record.includeFiscalYear,
    width: record.width,
    resetOn: record.resetOn,
  }
}
