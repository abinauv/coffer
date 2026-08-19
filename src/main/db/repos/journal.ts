/*
 * The journal — posting, reversing, and reading back.
 *
 * The only way an entry gets into the books. Migration 0004's triggers are written on
 * the assumption that nothing else writes to `journal_entries` or `journal_lines`, and
 * they are the reason that assumption is safe rather than hopeful: an entry written any
 * other way is refused rather than accepted quietly.
 *
 * THE INSERT ORDER IS BACKWARDS AND MUST STAY THAT WAY. Lines first, entry last. The
 * full reasoning is at the top of 0004 and in domain/ledger/types.ts; the short version
 * is that it is the only arrangement in which a trigger can see a complete entry, and
 * three triggers rather than the deferred foreign key are what hold it in place.
 *
 * WHAT IS CHECKED HERE AS WELL AS THERE. Balance, line count and line shape are checked
 * by `checkDraft` before anything is written, so a user gets every problem with their
 * journal at once instead of one per attempt. The database checks them again because
 * this function is not the only thing that will ever hold a connection.
 *
 * WHAT IS CHECKED ONLY HERE. Archived accounts. A posting to one still produces correct
 * reports, so by the rule this codebase applies it does not earn a trigger — and a
 * trigger would make an entry unreversible the moment one of its accounts was archived.
 */

import { randomUUID } from 'node:crypto'

import { sql } from 'kysely'

import { D, ZERO, parseMoney, toMoneyString, type Decimal } from '@main/domain/money'
import {
  MANUAL_SOURCE,
  checkDraft,
  totalsOf,
  type EntryDraft,
  type EntryLineDraft,
  type SourceDocument,
} from '@main/domain/ledger'
import { reverseLines } from '@main/domain/ledger'
import type {
  CreateJournalEntryInput,
  DateString,
  JournalEntry,
  JournalLine,
  PostingResult,
  ReverseEntryInput,
} from '@shared/dto'

import type { CofferDb } from '../kysely'
import { RepoError, repoErrorFrom, type RepoErrorCode } from './errors'
import { assertPartiesActive } from './parties'
import { requirePostablePeriod } from './periods'

/** How wide an entry number's sequence is padded. It grows past this rather than wrapping. */
const SEQUENCE_WIDTH = 4

/** The one journal series. Documents carry their own numbers in `source_number`. */
const ENTRY_PREFIX = 'JV'

// ---- Posting ---------------------------------------------------------------

export interface PostEntryOptions {
  /**
   * Allow lines against archived accounts. Only a reversal sets this: the original
   * entry is already in the books, and an account archived since then must not make it
   * impossible to correct.
   */
  allowArchived?: boolean
  /** The entry this one reverses. Set by `reverseEntry` and by nothing else. */
  reversesEntryId?: string
}

/**
 * Write an entry. The single path into the ledger.
 *
 * Everything happens in one transaction, including the reads: the period status, the
 * account list and the next entry number are all things that another write could change
 * underneath a check made outside one.
 */
export async function postEntry(
  db: CofferDb,
  draft: EntryDraft,
  options: PostEntryOptions = {},
): Promise<PostingResult> {
  const problems = checkDraft(draft)
  if (problems.length > 0) {
    const first = problems[0]!
    throw new RepoError(first.code as RepoErrorCode, describeProblems(problems), {
      problems: problems.map((problem) => ({ code: problem.code, lineIndex: problem.lineIndex })),
    })
  }

  try {
    return await db.transaction().execute(async (trx) => {
      const period = await requirePostablePeriod(trx, draft.date)
      await assertAccountsPostable(trx, draft.lines, options.allowArchived === true)

      /*
       * An archived party is refused here rather than by a trigger, for the reason
       * `allowArchived` exists at all: a reversal re-inserts the original lines carrying
       * the party they already named, and a trigger would make every entry involving a
       * party unreversible the moment that party was archived. See 0005.
       */
      if (!(options.allowArchived === true)) {
        await assertPartiesActive(
          trx,
          draft.lines
            .map((line) => line.partyId)
            .filter((partyId): partyId is string => typeof partyId === 'string'),
        )
      }

      const entryId = randomUUID()
      const entryNumber = await nextEntryNumber(trx, period.fiscalYearLabel)
      const postedAt = new Date().toISOString()

      /* Lines first. See the note at the top of this file, and do not tidy this. */
      await trx
        .insertInto('journal_lines')
        .values(
          draft.lines.map((line, index) => ({
            id: randomUUID(),
            entry_id: entryId,
            line_number: index + 1,
            account_id: line.accountId,
            debit: toMoneyString(line.debit),
            credit: toMoneyString(line.credit),
            narration: line.narration?.trim() ?? null,
            party_id: line.partyId ?? null,
          })),
        )
        .execute()

      await trx
        .insertInto('journal_entries')
        .values({
          id: entryId,
          entry_number: entryNumber,
          entry_date: draft.date,
          narration: draft.narration.trim(),
          source_type: draft.source.type,
          source_id: draft.source.id,
          source_number: draft.source.number,
          period_id: period.id,
          reverses_entry_id: options.reversesEntryId ?? null,
          posted_at: postedAt,
        })
        .execute()

      const totals = totalsOf(draft.lines)
      return {
        entryId,
        entryNumber,
        date: draft.date,
        total: toMoneyString(totals.debit),
        lineCount: draft.lines.length,
        postedAt,
      }
    })
  } catch (error) {
    throw repoErrorFrom(error, 'UNBALANCED_ENTRY')
  }
}

/** Post a journal somebody typed. Amounts arrive as decimal strings and are parsed once. */
export async function postManualEntry(
  db: CofferDb,
  input: CreateJournalEntryInput,
): Promise<PostingResult> {
  const lines: EntryLineDraft[] = input.lines.map((line, index) => ({
    accountId: line.accountId,
    debit: amountOf(line.debit, index, 'debit'),
    credit: amountOf(line.credit, index, 'credit'),
    narration: line.narration ?? undefined,
    partyId: line.partyId ?? null,
  }))

  return postEntry(db, {
    date: input.date,
    narration: input.narration,
    source: MANUAL_SOURCE,
    lines,
  })
}

/**
 * Reverse an entry: a new entry carrying the mirror of the original.
 *
 * Never an edit and never a delete — invariant 3. The reversal gets its own date, its
 * own narration and its own number, and it keeps the original's source so that a
 * document's drill-through still finds both halves of the story.
 *
 * "Already reversed" is a UNIQUE constraint on `reverses_entry_id` as well as the check
 * below, so it holds even against a caller that skipped this function.
 */
export async function reverseEntry(db: CofferDb, input: ReverseEntryInput): Promise<PostingResult> {
  const original = await getEntry(db, input.entryId)
  if (original === null) {
    throw new RepoError('ENTRY_NOT_FOUND', 'That entry is not in these books.', {
      entryId: input.entryId,
    })
  }
  if (original.reversedByEntryId !== null) {
    throw new RepoError(
      'ALREADY_REVERSED',
      `${original.entryNumber} was already reversed by ${original.reversedByEntryId}.`,
      { entryId: input.entryId, reversedByEntryId: original.reversedByEntryId },
    )
  }

  /* The party comes across with the line. A reversal that dropped it would post to the
   * control account naming nobody, which the trigger refuses — loudly, but only after a
   * user has been told their correction failed for no reason they can act on. */
  const lines: EntryLineDraft[] = original.lines.map((line) => ({
    accountId: line.accountId,
    debit: parseMoney(line.debit),
    credit: parseMoney(line.credit),
    narration: line.narration ?? undefined,
    partyId: line.partyId,
  }))

  const source: SourceDocument = {
    type: original.sourceType as SourceDocument['type'],
    id: original.sourceId,
    number: original.sourceNumber,
  }

  return postEntry(
    db,
    {
      date: input.date,
      narration: input.narration.trim(),
      source,
      lines: reverseLines(lines),
    },
    { allowArchived: true, reversesEntryId: original.id },
  )
}

// ---- Reading ---------------------------------------------------------------

export async function getEntry(db: CofferDb, id: string): Promise<JournalEntry | null> {
  const row = await db
    .selectFrom('journal_entries')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  if (row === undefined) {
    return null
  }
  const [lines, reversedBy] = await Promise.all([linesOf(db, [id]), reversedByOf(db, [id])])
  return toEntryDto(row, lines.get(id) ?? [], reversedBy.get(id) ?? null)
}

/** An entry found by the document it came from, for a drill-through from that document. */
export async function getEntryForSource(
  db: CofferDb,
  sourceType: string,
  sourceId: string,
): Promise<JournalEntry | null> {
  const row = await db
    .selectFrom('journal_entries')
    .select('id')
    .where('source_type', '=', sourceType)
    .where('source_id', '=', sourceId)
    .where('reverses_entry_id', 'is', null)
    .executeTakeFirst()
  return row === undefined ? null : getEntry(db, row.id)
}

export interface ListEntriesOptions {
  /** Inclusive. */
  fromDate?: DateString
  /** Inclusive. */
  toDate?: DateString
  periodId?: string
  sourceType?: string
  /** Only entries touching this account. */
  accountId?: string
  limit?: number
  offset?: number
}

/**
 * Entries in the order they would be read in a day book: by date, then by number.
 *
 * Not by `posted_at`. Two entries posted in one sitting for different dates belong in
 * date order, because that is the order the books are read and reported in.
 */
export async function listEntries(
  db: CofferDb,
  options: ListEntriesOptions = {},
): Promise<JournalEntry[]> {
  let query = db.selectFrom('journal_entries').selectAll()

  if (options.fromDate !== undefined) {
    query = query.where('entry_date', '>=', options.fromDate)
  }
  if (options.toDate !== undefined) {
    query = query.where('entry_date', '<=', options.toDate)
  }
  if (options.periodId !== undefined) {
    query = query.where('period_id', '=', options.periodId)
  }
  if (options.sourceType !== undefined) {
    query = query.where('source_type', '=', options.sourceType)
  }
  if (options.accountId !== undefined) {
    const accountId = options.accountId
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('journal_lines')
          .select('journal_lines.id')
          .whereRef('journal_lines.entry_id', '=', 'journal_entries.id')
          .where('journal_lines.account_id', '=', accountId),
      ),
    )
  }

  query = query.orderBy('entry_date').orderBy('entry_number')
  if (options.limit !== undefined) {
    query = query.limit(options.limit)
  }
  if (options.offset !== undefined) {
    query = query.offset(options.offset)
  }

  const rows = await query.execute()
  if (rows.length === 0) {
    return []
  }

  const ids = rows.map((row) => row.id)
  const [lines, reversedBy] = await Promise.all([linesOf(db, ids), reversedByOf(db, ids)])
  return rows.map((row) => toEntryDto(row, lines.get(row.id) ?? [], reversedBy.get(row.id) ?? null))
}

/**
 * Lines for a set of entries, with the account's code and name alongside.
 *
 * One query for all of them rather than one per entry — a day book of a hundred entries
 * would otherwise be a hundred round trips, and the denormalised code and name on the
 * DTO exist precisely so that rendering one does not need a join per line.
 */
async function linesOf(db: CofferDb, entryIds: string[]): Promise<Map<string, JournalLine[]>> {
  const rows = await db
    .selectFrom('journal_lines')
    .innerJoin('accounts', 'accounts.id', 'journal_lines.account_id')
    /* Left, not inner: most lines have no party, and an inner join here would silently
     * drop every line that does not — a trial balance short by its own bank side. */
    .leftJoin('parties', 'parties.id', 'journal_lines.party_id')
    .select([
      'journal_lines.id as id',
      'journal_lines.entry_id as entry_id',
      'journal_lines.line_number as line_number',
      'journal_lines.account_id as account_id',
      'journal_lines.debit as debit',
      'journal_lines.credit as credit',
      'journal_lines.narration as narration',
      'journal_lines.party_id as party_id',
      'accounts.code as account_code',
      'accounts.name as account_name',
      'parties.name as party_name',
    ])
    .where('journal_lines.entry_id', 'in', entryIds)
    .orderBy('journal_lines.line_number')
    .execute()

  const byEntry = new Map<string, JournalLine[]>()
  for (const row of rows) {
    const line: JournalLine = {
      id: row.id,
      lineNumber: row.line_number,
      accountId: row.account_id,
      accountCode: row.account_code,
      accountName: row.account_name,
      debit: row.debit,
      credit: row.credit,
      narration: row.narration,
      partyId: row.party_id,
      partyName: row.party_name,
    }
    const existing = byEntry.get(row.entry_id)
    if (existing === undefined) {
      byEntry.set(row.entry_id, [line])
    } else {
      existing.push(line)
    }
  }
  return byEntry
}

/** Which entry reversed each of these, where one did. Derived, never stored. */
async function reversedByOf(db: CofferDb, entryIds: string[]): Promise<Map<string, string>> {
  const rows = await db
    .selectFrom('journal_entries')
    .select(['id', 'reverses_entry_id'])
    .where('reverses_entry_id', 'in', entryIds)
    .execute()

  const byOriginal = new Map<string, string>()
  for (const row of rows) {
    if (row.reverses_entry_id !== null) {
      byOriginal.set(row.reverses_entry_id, row.id)
    }
  }
  return byOriginal
}

function toEntryDto(
  row: {
    id: string
    entry_number: string
    entry_date: string
    narration: string
    source_type: string
    source_id: string | null
    source_number: string | null
    period_id: string
    reverses_entry_id: string | null
    posted_at: string
  },
  lines: JournalLine[],
  reversedByEntryId: string | null,
): JournalEntry {
  let total: Decimal = ZERO
  for (const line of lines) {
    total = total.plus(D(line.debit))
  }
  return {
    id: row.id,
    entryNumber: row.entry_number,
    date: row.entry_date,
    narration: row.narration,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceNumber: row.source_number,
    periodId: row.period_id,
    reversesEntryId: row.reverses_entry_id,
    reversedByEntryId,
    lines,
    total: toMoneyString(total),
    postedAt: row.posted_at,
  }
}

// ---- Numbering -------------------------------------------------------------

/**
 * The next number in the fiscal year's journal series, e.g. `JV-2026-27-0043`.
 *
 * The sequence restarts each fiscal year, which is what Indian practice expects and what
 * makes a number quotable — 'JV-2026-27-0043' says when it was as well as which it is.
 *
 * The maximum is taken from the numeric suffix rather than from the string, so the
 * sequence keeps counting correctly past 9999 where a text sort would put `10000` before
 * `9999`. `entry_number` is UNIQUE, so a collision is refused rather than silently
 * producing two entries with one number.
 */
async function nextEntryNumber(db: CofferDb, fiscalYearLabel: string): Promise<string> {
  const prefix = `${ENTRY_PREFIX}-${fiscalYearLabel}-`
  const row = await db
    .selectFrom('journal_entries')
    .select(
      sql<number | null>`MAX(CAST(SUBSTR(entry_number, ${prefix.length + 1}) AS INTEGER))`.as(
        'highest',
      ),
    )
    .where('entry_number', 'like', `${prefix}%`)
    .executeTakeFirst()

  const next = (row?.highest ?? 0) + 1
  return `${prefix}${String(next).padStart(SEQUENCE_WIDTH, '0')}`
}

// ---- Guards ----------------------------------------------------------------

/**
 * Every line names an account that exists, is not a group, and is not archived.
 *
 * One query rather than one per line, and the whole set is reported rather than the
 * first offender — the same reasoning as `checkDraft`: somebody fixing a journal wants
 * the list.
 */
async function assertAccountsPostable(
  db: CofferDb,
  lines: readonly EntryLineDraft[],
  allowArchived: boolean,
): Promise<void> {
  const wanted = [...new Set(lines.map((line) => line.accountId))]
  const rows = await db
    .selectFrom('accounts')
    .select(['id', 'code', 'is_group', 'is_archived'])
    .where('id', 'in', wanted)
    .execute()

  const byId = new Map(rows.map((row) => [row.id, row]))

  const missing = wanted.filter((id) => !byId.has(id))
  if (missing.length > 0) {
    throw new RepoError('ACCOUNT_NOT_FOUND', 'A line names an account that does not exist.', {
      accountIds: missing,
    })
  }

  const groups = rows.filter((row) => row.is_group === 1).map((row) => row.code)
  if (groups.length > 0) {
    throw new RepoError(
      'ACCOUNT_IS_GROUP',
      `A group totals its children and holds no figures of its own: ${groups.join(', ')}.`,
      { codes: groups },
    )
  }

  if (!allowArchived) {
    const archived = rows.filter((row) => row.is_archived === 1).map((row) => row.code)
    if (archived.length > 0) {
      throw new RepoError(
        'ACCOUNT_ARCHIVED',
        `An archived account accepts nothing new: ${archived.join(', ')}.`,
        { codes: archived },
      )
    }
  }
}

/** Parse an amount from a decimal string, saying which line and which side it was on. */
function amountOf(text: string, lineIndex: number, side: 'debit' | 'credit'): Decimal {
  try {
    return parseMoney(text)
  } catch (error) {
    throw new RepoError(
      'INVALID_AMOUNT',
      `Line ${String(lineIndex + 1)}: ${JSON.stringify(text)} is not an amount.`,
      { lineIndex, side, value: text },
      { cause: error },
    )
  }
}

/** One sentence covering every structural problem, so the message is worth reading. */
function describeProblems(problems: readonly { code: string; lineIndex: number | null }[]): string {
  return problems
    .map((problem) =>
      problem.lineIndex === null
        ? problem.code
        : `${problem.code} on line ${String(problem.lineIndex + 1)}`,
    )
    .join('; ')
}
