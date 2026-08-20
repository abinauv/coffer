/*
 * Against a real encrypted database, like every other repository test here.
 *
 * What could not be learned from a mock: two partial unique indexes, a `COLLATE NOCASE`
 * one, three triggers, a foreign key that refuses a delete, and an `UPDATE ... RETURNING`
 * whose whole value is that it is one statement. A mock would agree with whatever this
 * file believed, including about the thing this batch exists to get right.
 *
 * THE RULES BELOW ARE ENFORCED TWICE, in 0007 and in the repository, and a test that goes
 * through the repository passes whichever layer answers first — after which the database
 * constraint can be deleted with nothing failing. That has now been found in three
 * separate batches (CONVENTIONS §6). Every such rule therefore has a test in
 * `describe('migration 0007')` that goes straight at the table through
 * `connection.prepare`, and a separate one through the repository for the sentence.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DATABASE_KEY_BYTES, closeDatabase, openDatabase, type SqliteDatabase } from '../connection'
import { createQueryBuilder, type CofferDb } from '../kysely'
import { runMigrations, rollbackMigrations } from '../migrate'
import { MIGRATIONS } from '../migrations'

import {
  allocateNumber,
  archiveSeries,
  createSeries,
  defaultSeriesFor,
  deleteSeries,
  getSeries,
  listSeries,
  previewNumber,
  updateSeries,
} from './numbering'
import { isRepoError, type RepoError, type RepoErrorCode } from './errors'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x5a)
const AT = '2026-08-19T00:00:00.000Z'

const directories: string[] = []
const handles: SqliteDatabase[] = []

let filePath: string
let connection: SqliteDatabase
let db: CofferDb

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-numbering-'))
  directories.push(dir)
  filePath = join(dir, 'company.coffer')
  connection = openDatabase({ filePath, key: KEY })
  handles.push(connection)
  runMigrations(connection, MIGRATIONS)
  db = createQueryBuilder(connection)
})

afterEach(() => {
  for (const handle of handles.splice(0)) {
    try {
      closeDatabase(handle)
    } catch {
      /* a test may have closed it already */
    }
  }
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

async function codeOf(action: () => Promise<unknown>): Promise<RepoErrorCode | string> {
  try {
    await action()
  } catch (error) {
    return isRepoError(error) ? error.code : `not a RepoError: ${String(error)}`
  }
  return 'no error thrown'
}

async function failureOf(action: () => Promise<unknown>): Promise<RepoError> {
  try {
    await action()
  } catch (error) {
    if (isRepoError(error)) {
      return error
    }
    throw error
  }
  throw new Error('Expected the action to fail, and it did not.')
}

/**
 * A series written straight to the table, bypassing the repository.
 *
 * The only way to test a constraint the repository also checks. Every rule tested through
 * `createSeries` is answered by whichever layer runs first, which is how a test keeps
 * passing against a database that has stopped enforcing anything.
 */
function writeSeries(id: string, over: Record<string, unknown> = {}): void {
  const row = {
    kind: 'sales-invoice',
    label: id,
    prefix: 'INV',
    suffix: '',
    separator: '/',
    include_fiscal_year: 1,
    width: 4,
    reset_on: 'fiscal-year',
    is_default: 0,
    is_archived: 0,
    ...over,
  }
  connection
    .prepare(
      `INSERT INTO numbering_series
         (id, kind, label, prefix, suffix, separator, include_fiscal_year, width, reset_on,
          is_default, is_archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      row.kind,
      row.label,
      row.prefix,
      row.suffix,
      row.separator,
      row.include_fiscal_year,
      row.width,
      row.reset_on,
      row.is_default,
      row.is_archived,
      AT,
      AT,
    )
}

/** A counter row written straight to the table. */
function writeCounter(seriesId: string, scope: string | null, nextSequence: number): void {
  connection
    .prepare(
      `INSERT INTO numbering_counters (series_id, fiscal_year_label, next_sequence, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(seriesId, scope, nextSequence, AT)
}

function counterRows(): { series_id: string; fiscal_year_label: string; next_sequence: number }[] {
  return connection
    .prepare<[], { series_id: string; fiscal_year_label: string; next_sequence: number }>(
      `SELECT series_id, fiscal_year_label, next_sequence FROM numbering_counters
       ORDER BY series_id, fiscal_year_label`,
    )
    .all()
}

/** The Indian invoice series everybody arrives wanting: `INV/2026-27/0001`. */
const indianInvoice = (over: Record<string, unknown> = {}) =>
  createSeries(db, {
    kind: 'sales-invoice',
    label: 'Main',
    prefix: 'INV',
    separator: '/',
    includeFiscalYear: true,
    width: 4,
    resetOn: 'fiscal-year',
    ...over,
  })

describe('migration 0007', () => {
  const tableNames = () =>
    connection
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
      )
      .all()
      .map((row) => row.name)

  it('creates both tables and rolls back cleanly', () => {
    expect(tableNames()).toContain('numbering_series')
    expect(tableNames()).toContain('numbering_counters')

    rollbackMigrations(connection, MIGRATIONS, { to: '0006' })

    expect(tableNames()).not.toContain('numbering_series')
    expect(tableNames()).not.toContain('numbering_counters')
  })

  it('leaves a database that migrates forward again', () => {
    /* A `down` that leaves a trigger or an index behind fails on the way back up, and
     * the failure lands on whoever opens the file next rather than on whoever wrote it. */
    writeSeries('s-1')
    rollbackMigrations(connection, MIGRATIONS, { to: '0006' })
    runMigrations(connection, MIGRATIONS)

    expect(tableNames()).toContain('numbering_series')
    expect(
      connection.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM numbering_series`).get()?.n,
    ).toBe(0)
  })

  it('drops the counters even though their trigger refuses every delete', () => {
    /* DROP TABLE fires no delete triggers. If it did, `numbering_counters_no_delete`
     * would make this migration irreversible. */
    writeSeries('s-1')
    writeCounter('s-1', '2026-27', 9)

    expect(() => rollbackMigrations(connection, MIGRATIONS, { to: '0006' })).not.toThrow()
  })

  it('refuses a kind that is not one of the five', () => {
    expect(() => writeSeries('s-bad', { kind: 'delivery-note' })).toThrow(/CHECK/i)
    expect(() => writeSeries('s-good', { kind: 'purchase-bill' })).not.toThrow()
  })

  it('refuses a blank label', () => {
    expect(() => writeSeries('s-blank', { label: '   ' })).toThrow(/CHECK/i)
  })

  it('refuses a width outside the range a number can be read at', () => {
    expect(() => writeSeries('s-narrow', { width: -1 })).toThrow(/CHECK/i)
    expect(() => writeSeries('s-wide', { width: 13 })).toThrow(/CHECK/i)
    expect(() => writeSeries('s-none', { width: 0 })).not.toThrow()
    expect(() => writeSeries('s-max', { width: 12 })).not.toThrow()
  })

  it('refuses a reset rule that is neither of the two', () => {
    expect(() => writeSeries('s-odd', { reset_on: 'monthly' })).toThrow(/CHECK/i)
  })

  it('refuses a flag that is not 0 or 1', () => {
    expect(() => writeSeries('s-flag', { is_default: 2 })).toThrow(/CHECK/i)
    expect(() => writeSeries('s-flag2', { include_fiscal_year: 7 })).toThrow(/CHECK/i)
    expect(() => writeSeries('s-flag3', { is_archived: -1 })).toThrow(/CHECK/i)
  })

  it('refuses a label another series of the same kind holds, ignoring case', () => {
    writeSeries('s-1', { label: 'Export' })
    expect(() => writeSeries('s-2', { label: 'EXPORT' })).toThrow(/UNIQUE/i)
  })

  it('lets two kinds each have a series called the same thing', () => {
    /* A `Main` invoice series and a `Main` quotation series are not duplicates. */
    writeSeries('s-1', { kind: 'sales-invoice', label: 'Main' })
    expect(() => writeSeries('s-2', { kind: 'quotation', label: 'Main' })).not.toThrow()
  })

  it('refuses a second default for one kind', () => {
    writeSeries('s-1', { label: 'Main', is_default: 1 })
    expect(() => writeSeries('s-2', { label: 'Export', is_default: 1 })).toThrow(/UNIQUE/i)
  })

  it('allows any number of series for a kind while only one is the default', () => {
    writeSeries('s-1', { label: 'Main', is_default: 1 })
    expect(() => writeSeries('s-2', { label: 'Export', is_default: 0 })).not.toThrow()
    expect(() => writeSeries('s-3', { label: 'Job work', is_default: 0 })).not.toThrow()
  })

  it('lets each kind have its own default', () => {
    writeSeries('s-1', { kind: 'sales-invoice', label: 'Main', is_default: 1 })
    expect(() =>
      writeSeries('s-2', { kind: 'quotation', label: 'Quotes', is_default: 1 }),
    ).not.toThrow()
  })

  it('keeps an archived default out of the way of a live one', () => {
    /* The `AND is_archived = 0` in the partial index. Without it, archiving the old
     * invoice series and starting a new one is a constraint error naming an index. */
    writeSeries('s-old', { label: 'Old', is_default: 1, is_archived: 1 })
    expect(() => writeSeries('s-new', { label: 'New', is_default: 1 })).not.toThrow()
  })

  it('refuses a NULL scope on a counter', () => {
    /* The whole reason `fiscal_year_label` is NOT NULL: NULLs do not collide in a unique
     * index, so a nullable scope would let one series carry two counters. */
    writeSeries('s-1')
    expect(() => writeCounter('s-1', null, 1)).toThrow(/NOT NULL/i)
  })

  it('refuses a second counter for one series in one scope', () => {
    writeSeries('s-1')
    writeCounter('s-1', '2026-27', 1)
    expect(() => writeCounter('s-1', '2026-27', 1)).toThrow(/UNIQUE/i)
  })

  it('treats the empty-string scope as a scope like any other', () => {
    writeSeries('s-1')
    writeCounter('s-1', '', 1)
    expect(() => writeCounter('s-1', '', 1)).toThrow(/UNIQUE/i)
    expect(() => writeCounter('s-1', '2026-27', 1)).not.toThrow()
  })

  it('refuses a counter below one', () => {
    writeSeries('s-1')
    expect(() => writeCounter('s-1', '2026-27', 0)).toThrow(/CHECK/i)
    expect(() => writeCounter('s-1', '2026-27', -5)).toThrow(/CHECK/i)
  })

  it('refuses a counter for a series that does not exist', () => {
    expect(() => writeCounter('nobody', '2026-27', 1)).toThrow(/FOREIGN KEY/i)
  })

  it('refuses to delete a series that has a counter', () => {
    /* ON DELETE RESTRICT. CASCADE would let a settings screen throw away how far a
     * series had got, after which the next series starts again at 1. */
    writeSeries('s-1')
    writeCounter('s-1', '2026-27', 4)

    expect(() => connection.prepare(`DELETE FROM numbering_series WHERE id = 's-1'`).run()).toThrow(
      /FOREIGN KEY/i,
    )
  })

  it('lets a series with no counter be deleted', () => {
    writeSeries('s-1')
    expect(() =>
      connection.prepare(`DELETE FROM numbering_series WHERE id = 's-1'`).run(),
    ).not.toThrow()
  })

  describe('the counter only ever goes forward', () => {
    beforeEach(() => {
      writeSeries('s-1')
      writeCounter('s-1', '2026-27', 8)
    })

    it('refuses an update that lowers it', () => {
      expect(() =>
        connection.prepare(`UPDATE numbering_counters SET next_sequence = 3`).run(),
      ).toThrow(/SERIES_IN_USE/)
    })

    it('refuses an update that leaves it where it is', () => {
      /* `<=` and not `<`: the only legitimate write to this column is the allocation's
       * own `+ 1`, and a write that moves nothing has handed nothing out. */
      expect(() =>
        connection.prepare(`UPDATE numbering_counters SET next_sequence = 8`).run(),
      ).toThrow(/SERIES_IN_USE/)
    })

    it('allows one that raises it', () => {
      expect(() =>
        connection.prepare(`UPDATE numbering_counters SET next_sequence = 9`).run(),
      ).not.toThrow()
    })

    it('does not fire when only updated_at is written', () => {
      /* `BEFORE UPDATE OF next_sequence`. A plain `BEFORE UPDATE` would see NEW equal to
       * OLD here and abort a write that changes nothing about the counter. */
      expect(() =>
        connection
          .prepare(`UPDATE numbering_counters SET updated_at = '2027-01-01T00:00:00.000Z'`)
          .run(),
      ).not.toThrow()
    })

    it('refuses a delete', () => {
      /* Deleting the row releases every number the series has handed out: the next
       * allocation recreates it at 1 and reissues them. */
      expect(() => connection.prepare(`DELETE FROM numbering_counters`).run()).toThrow(
        /SERIES_IN_USE/,
      )
    })
  })

  describe('the shape of a series that has issued is frozen', () => {
    beforeEach(() => {
      writeSeries('s-1', { label: 'Main' })
      writeSeries('s-2', { label: 'Fresh' })
      writeCounter('s-1', '2026-27', 4)
    })

    const change = (id: string, sql: string) =>
      connection.prepare(`UPDATE numbering_series SET ${sql} WHERE id = '${id}'`).run()

    it('refuses every part of the shape', () => {
      expect(() => change('s-1', `prefix = 'SI'`)).toThrow(/SERIES_IN_USE/)
      expect(() => change('s-1', `suffix = 'A'`)).toThrow(/SERIES_IN_USE/)
      expect(() => change('s-1', `separator = '-'`)).toThrow(/SERIES_IN_USE/)
      expect(() => change('s-1', `include_fiscal_year = 0`)).toThrow(/SERIES_IN_USE/)
      expect(() => change('s-1', `width = 6`)).toThrow(/SERIES_IN_USE/)
      expect(() => change('s-1', `reset_on = 'never'`)).toThrow(/SERIES_IN_USE/)
      expect(() => change('s-1', `kind = 'credit-note'`)).toThrow(/SERIES_IN_USE/)
    })

    it('allows what does not change a number already printed', () => {
      expect(() => change('s-1', `label = 'Renamed'`)).not.toThrow()
      expect(() => change('s-1', `is_default = 1`)).not.toThrow()
      expect(() => change('s-1', `is_archived = 1`)).not.toThrow()
    })

    it('allows a shape change on a series that has issued nothing', () => {
      expect(() => change('s-2', `prefix = 'SI'`)).not.toThrow()
      expect(() => change('s-2', `reset_on = 'never'`)).not.toThrow()
    })

    it('allows re-writing the shape it already has', () => {
      /* A settings screen posts the whole record back. The trigger compares OLD against
       * NEW rather than firing on a column appearing in the SET list, so re-sending an
       * unchanged prefix is not a change. */
      expect(() =>
        change('s-1', `prefix = 'INV', width = 4, reset_on = 'fiscal-year'`),
      ).not.toThrow()
    })
  })
})

describe('creating a series', () => {
  it('keeps what it was given', async () => {
    const series = await indianInvoice({ label: 'Export', suffix: 'EX' })

    expect(series.kind).toBe('sales-invoice')
    expect(series.label).toBe('Export')
    expect(series.prefix).toBe('INV')
    expect(series.suffix).toBe('EX')
    expect(series.separator).toBe('/')
    expect(series.includeFiscalYear).toBe(true)
    expect(series.width).toBe(4)
    expect(series.resetOn).toBe('fiscal-year')
    expect(series.isArchived).toBe(false)
    expect(series.hasIssued).toBe(false)
  })

  it('fills the parts of the shape nobody sent', async () => {
    const series = await createSeries(db, { kind: 'sales-invoice', label: 'Bare' })

    expect(series.prefix).toBe('')
    expect(series.suffix).toBe('')
    expect(series.separator).toBe('')
    expect(series.includeFiscalYear).toBe(false)
    expect(series.width).toBe(4)
  })

  it('resets on the fiscal year for a document that reaches the ledger', async () => {
    /* Rule 46(b) asks for a consecutive series within a financial year, and it asks it
     * of a supply. Read off `postsToLedger` so a kind added later answers for itself. */
    expect((await createSeries(db, { kind: 'sales-invoice', label: 'A' })).resetOn).toBe(
      'fiscal-year',
    )
    expect((await createSeries(db, { kind: 'credit-note', label: 'B' })).resetOn).toBe(
      'fiscal-year',
    )
  })

  it('runs on forever for a quotation, which supplies nothing', async () => {
    expect((await createSeries(db, { kind: 'quotation', label: 'Q' })).resetOn).toBe('never')
  })

  it('honours a reset rule that was sent', async () => {
    const series = await createSeries(db, {
      kind: 'sales-invoice',
      label: 'Running',
      resetOn: 'never',
    })
    expect(series.resetOn).toBe('never')
  })

  it('trims the label and leaves the prefix alone', async () => {
    /* A space is a legitimate separator and a prefix ending in one is somebody's
     * existing format. A label is a name, and a name with edge whitespace is a typo. */
    const series = await createSeries(db, {
      kind: 'sales-invoice',
      label: '  Spaced  ',
      prefix: 'INV ',
      separator: ' ',
    })

    expect(series.label).toBe('Spaced')
    expect(series.prefix).toBe('INV ')
    expect(series.separator).toBe(' ')
  })

  it('refuses a blank label', async () => {
    expect(await codeOf(() => createSeries(db, { kind: 'sales-invoice', label: '   ' }))).toBe(
      'SERIES_LABEL_REQUIRED',
    )
  })

  it('refuses a kind the domain does not know', async () => {
    /* A programmer error rather than something a user can act on, so it throws rather
     * than carrying a code (CONVENTIONS §5). */
    await expect(createSeries(db, { kind: 'delivery-note', label: 'X' })).rejects.toThrow(
      /Unknown document kind/,
    )
  })

  it('refuses a width nothing could be read at', async () => {
    expect(await codeOf(() => indianInvoice({ label: 'W1', width: 13 }))).toBe(
      'SERIES_WIDTH_INVALID',
    )
    expect(await codeOf(() => indianInvoice({ label: 'W2', width: -1 }))).toBe(
      'SERIES_WIDTH_INVALID',
    )
    expect(await codeOf(() => indianInvoice({ label: 'W3', width: 2.5 }))).toBe(
      'SERIES_WIDTH_INVALID',
    )
  })

  it('accepts a width of zero, which is padding turned off', async () => {
    expect((await indianInvoice({ label: 'Unpadded', width: 0 })).width).toBe(0)
  })
})

describe('labels are unique within a kind', () => {
  it('refuses one another series of the kind already holds', async () => {
    await indianInvoice({ label: 'Export' })
    expect(await codeOf(() => indianInvoice({ label: 'Export' }))).toBe('SERIES_LABEL_TAKEN')
  })

  it('refuses one that differs only in case', async () => {
    await indianInvoice({ label: 'Export' })
    expect(await codeOf(() => indianInvoice({ label: 'EXPORT' }))).toBe('SERIES_LABEL_TAKEN')
  })

  it('says which label clashed, from the repository', async () => {
    /* `details` is only populated here. Without this the test would pass against a
     * repository that had left it to the index, which reports a constraint name. */
    await indianInvoice({ label: 'Export' })
    const failure = await failureOf(() => indianInvoice({ label: 'export' }))

    expect(failure.code).toBe('SERIES_LABEL_TAKEN')
    expect(failure.details).toMatchObject({ existingLabel: 'Export' })
  })

  it('lets another kind use the same label', async () => {
    await indianInvoice({ label: 'Main' })
    const quotes = await createSeries(db, { kind: 'quotation', label: 'Main' })
    expect(quotes.label).toBe('Main')
  })

  it('lets a series keep its own label through an update', async () => {
    const series = await indianInvoice({ label: 'Main' })
    expect((await updateSeries(db, { id: series.id, label: 'Main' })).label).toBe('Main')
  })
})

describe('the default series', () => {
  it('makes the first series of a kind the default', async () => {
    /* A kind with a series and no default numbers nothing, and the tick box that fixes
     * it is the one nobody thinks to look at. */
    expect((await indianInvoice({ label: 'Main' })).isDefault).toBe(true)
  })

  it('does not make the second one the default too', async () => {
    await indianInvoice({ label: 'Main' })
    expect((await indianInvoice({ label: 'Export' })).isDefault).toBe(false)
  })

  it('honours an explicit refusal on the first one', async () => {
    const series = await indianInvoice({ label: 'Main', isDefault: false })
    expect(series.isDefault).toBe(false)
    expect(await defaultSeriesFor(db, 'sales-invoice')).toBeNull()
  })

  it('moves the default rather than colliding with the one that holds it', async () => {
    const main = await indianInvoice({ label: 'Main' })
    const exported = await indianInvoice({ label: 'Export', isDefault: true })

    expect((await getSeries(db, main.id))?.isDefault).toBe(false)
    expect((await defaultSeriesFor(db, 'sales-invoice'))?.id).toBe(exported.id)
  })

  it('moves it through an update as well as through a create', async () => {
    const main = await indianInvoice({ label: 'Main' })
    const exported = await indianInvoice({ label: 'Export' })

    await updateSeries(db, { id: exported.id, isDefault: true })

    expect((await getSeries(db, main.id))?.isDefault).toBe(false)
    expect((await defaultSeriesFor(db, 'sales-invoice'))?.id).toBe(exported.id)
  })

  it('keeps each kind out of the others way', async () => {
    const invoice = await indianInvoice({ label: 'Main' })
    const quote = await createSeries(db, { kind: 'quotation', label: 'Quotes' })

    expect((await defaultSeriesFor(db, 'sales-invoice'))?.id).toBe(invoice.id)
    expect((await defaultSeriesFor(db, 'quotation'))?.id).toBe(quote.id)
  })

  it('offers nothing for a kind with no series at all', async () => {
    expect(await defaultSeriesFor(db, 'purchase-bill')).toBeNull()
  })

  it('does not offer an archived series, even one still carrying the flag', async () => {
    /* The archived row keeps the flag as a record of what it was; the query is what
     * makes sure a document never takes it. */
    const main = await indianInvoice({ label: 'Main' })
    await archiveSeries(db, main.id, true)

    expect((await getSeries(db, main.id))?.isDefault).toBe(true)
    expect(await defaultSeriesFor(db, 'sales-invoice')).toBeNull()
  })

  it('does not take the default back off the series in use when one returns', async () => {
    const main = await indianInvoice({ label: 'Main' })
    await archiveSeries(db, main.id, true)
    const replacement = await indianInvoice({ label: 'New', isDefault: true })

    await archiveSeries(db, main.id, false)

    expect((await defaultSeriesFor(db, 'sales-invoice'))?.id).toBe(replacement.id)
    expect((await getSeries(db, main.id))?.isDefault).toBe(false)
  })

  it('gives the default back when nothing took it in the meantime', async () => {
    const main = await indianInvoice({ label: 'Main' })
    await archiveSeries(db, main.id, true)
    await archiveSeries(db, main.id, false)

    expect((await defaultSeriesFor(db, 'sales-invoice'))?.id).toBe(main.id)
  })

  it('leaves the kind with a default when the series taking it could not be written', async () => {
    /* Moving the default is two statements — take it off the one that holds it, then
     * write the one that takes it — and half of that is a kind with no default at all,
     * which numbers nothing. The trigger below is the test's own, standing in for
     * whatever else could make the insert fail after the first statement had run. */
    const main = await indianInvoice({ label: 'Main' })
    connection.exec(
      `CREATE TRIGGER test_refuse_export
       BEFORE INSERT ON numbering_series
       WHEN NEW.label = 'Export'
       BEGIN SELECT RAISE(ABORT, 'REFUSED_BY_THE_TEST'); END`,
    )

    await expect(indianInvoice({ label: 'Export', isDefault: true })).rejects.toThrow(
      /REFUSED_BY_THE_TEST/,
    )

    expect((await defaultSeriesFor(db, 'sales-invoice'))?.id).toBe(main.id)
  })
})

describe('listing', () => {
  beforeEach(async () => {
    /* Deliberately out of the order the assertions expect: a list sorted by nothing at
     * all would come back in this order and look right. */
    await createSeries(db, { kind: 'quotation', label: 'Zebra quotes' })
    await indianInvoice({ label: 'Zebra', isDefault: false })
    await indianInvoice({ label: 'apple', isDefault: true })
    await indianInvoice({ label: 'Mango', isDefault: false })
  })

  it('groups by kind, puts the default first and then sorts by label ignoring case', async () => {
    expect((await listSeries(db)).map((series) => `${series.kind}:${series.label}`)).toEqual([
      'quotation:Zebra quotes',
      'sales-invoice:apple',
      'sales-invoice:Mango',
      'sales-invoice:Zebra',
    ])
  })

  it('offers one kind when asked for one kind', async () => {
    expect((await listSeries(db, { kind: 'quotation' })).map((s) => s.label)).toEqual([
      'Zebra quotes',
    ])
  })

  it('hides archived series by default and shows them when asked', async () => {
    const mango = (await listSeries(db)).find((series) => series.label === 'Mango')!
    await archiveSeries(db, mango.id, true)

    expect((await listSeries(db)).map((s) => s.label)).not.toContain('Mango')
    expect((await listSeries(db, { includeArchived: true })).map((s) => s.label)).toContain('Mango')
  })
})

describe('previewing a number', () => {
  it('shows what the series would produce next', async () => {
    const series = await indianInvoice()
    const preview = await previewNumber(db, series.id, '2026-27')

    expect(preview.preview).toBe('INV/2026-27/0001')
    expect(preview.nextSequence).toBe(1)
    expect(preview.fiscalYearLabel).toBe('2026-27')
    expect(preview.seriesId).toBe(series.id)
  })

  it('spends nothing', async () => {
    const series = await indianInvoice()
    await previewNumber(db, series.id, '2026-27')
    await previewNumber(db, series.id, '2026-27')
    await previewNumber(db, series.id, '2026-27')

    expect(counterRows()).toEqual([])
    expect(await allocateNumber(db, series.id, '2026-27')).toBe('INV/2026-27/0001')
  })

  it('follows the counter once numbers have been handed out', async () => {
    const series = await indianInvoice()
    await allocateNumber(db, series.id, '2026-27')
    await allocateNumber(db, series.id, '2026-27')

    const preview = await previewNumber(db, series.id, '2026-27')
    expect(preview.nextSequence).toBe(3)
    expect(preview.preview).toBe('INV/2026-27/0003')
  })

  it('is the same answer the allocation gives', async () => {
    /* The point of building the preview through `formatDocumentNumber` rather than
     * through a lookalike: a preview that matches is evidence about the real thing. */
    const series = await indianInvoice({ prefix: '', suffix: 'A', separator: '-', width: 2 })
    const preview = await previewNumber(db, series.id, '2026-27')

    expect(await allocateNumber(db, series.id, '2026-27')).toBe(preview.preview)
  })

  it('reports the counter scope rather than the printed year', async () => {
    /* A series that shows the year and runs on across years draws from ONE counter, and
     * (fiscalYearLabel, nextSequence) has to name that counter or it names nothing. */
    const series = await indianInvoice({ resetOn: 'never' })
    const preview = await previewNumber(db, series.id, '2026-27')

    expect(preview.fiscalYearLabel).toBeNull()
    expect(preview.preview).toBe('INV/2026-27/0001')
  })

  it('refuses to guess a year the series needs', async () => {
    const series = await indianInvoice()
    expect(await codeOf(() => previewNumber(db, series.id, null))).toBe('FISCAL_YEAR_REQUIRED')
  })

  it('refuses a series that does not exist', async () => {
    expect(await codeOf(() => previewNumber(db, 'nobody', '2026-27'))).toBe('SERIES_NOT_FOUND')
  })
})

describe('allocating a number', () => {
  it('hands out the number and moves the counter past it', async () => {
    const series = await indianInvoice()

    expect(await allocateNumber(db, series.id, '2026-27')).toBe('INV/2026-27/0001')
    expect(await allocateNumber(db, series.id, '2026-27')).toBe('INV/2026-27/0002')
    expect(await allocateNumber(db, series.id, '2026-27')).toBe('INV/2026-27/0003')
    expect(counterRows()).toEqual([
      { series_id: series.id, fiscal_year_label: '2026-27', next_sequence: 4 },
    ])
  })

  it('marks the series as having issued, without storing a flag', async () => {
    const series = await indianInvoice()
    expect(series.hasIssued).toBe(false)

    await allocateNumber(db, series.id, '2026-27')
    expect((await getSeries(db, series.id))?.hasIssued).toBe(true)
  })

  it('keeps one counter per year for a series that resets', async () => {
    const series = await indianInvoice()
    await allocateNumber(db, series.id, '2026-27')
    await allocateNumber(db, series.id, '2026-27')

    expect(await allocateNumber(db, series.id, '2027-28')).toBe('INV/2027-28/0001')
    expect(await allocateNumber(db, series.id, '2026-27')).toBe('INV/2026-27/0003')
  })

  it('keeps one counter for all time for a series that never resets', async () => {
    /* `counterScopeOf` reads `resetOn` and not `includeFiscalYear`, so this series
     * prints the year and carries on counting across it. */
    const series = await indianInvoice({ resetOn: 'never' })
    await allocateNumber(db, series.id, '2026-27')

    expect(await allocateNumber(db, series.id, '2027-28')).toBe('INV/2027-28/0002')
    expect(counterRows()).toEqual([
      { series_id: series.id, fiscal_year_label: '', next_sequence: 3 },
    ])
  })

  it('resets quietly for a series that does not print the year', async () => {
    /* The other half of the same independence: legal under rule 46(b), which asks for
     * consecutive within a year and nothing about what is printed. */
    const series = await indianInvoice({ includeFiscalYear: false, resetOn: 'fiscal-year' })

    expect(await allocateNumber(db, series.id, '2026-27')).toBe('INV/0001')
    expect(await allocateNumber(db, series.id, '2027-28')).toBe('INV/0001')
  })

  it('needs no year at all for a series that neither shows nor resets on one', async () => {
    const series = await createSeries(db, {
      kind: 'quotation',
      label: 'Quotes',
      prefix: 'QT',
      separator: '-',
    })

    expect(await allocateNumber(db, series.id, null)).toBe('QT-0001')
    expect(await allocateNumber(db, series.id, null)).toBe('QT-0002')
    expect(counterRows()).toEqual([
      { series_id: series.id, fiscal_year_label: '', next_sequence: 3 },
    ])
  })

  it('refuses to number a document whose year the series needs and nobody gave', async () => {
    const series = await indianInvoice()
    expect(await codeOf(() => allocateNumber(db, series.id, null))).toBe('FISCAL_YEAR_REQUIRED')
  })

  it('refuses it for a series that resets on the year without printing it', async () => {
    /* The counter to draw from is the question here, not the segment to print. Guessing
     * would draw from the wrong counter and hand out a number twice. */
    const series = await indianInvoice({ includeFiscalYear: false, resetOn: 'fiscal-year' })
    expect(await codeOf(() => allocateNumber(db, series.id, null))).toBe('FISCAL_YEAR_REQUIRED')
  })

  /*
   * The mirror of the case above, and the one a mutation found nothing testing. Here the
   * year IS printed and the counter never resets: `counterScopeOf` wants no year, but
   * `formatDocumentNumber` cannot build the number without one. Refusing on either flag
   * alone is not enough — the two are independent, which is the whole reason 0007 keeps
   * them as separate columns.
   */
  it('refuses it for a series that prints the year without resetting on it', async () => {
    const series = await indianInvoice({ includeFiscalYear: true, resetOn: 'never' })
    expect(await codeOf(() => allocateNumber(db, series.id, null))).toBe('FISCAL_YEAR_REQUIRED')
  })

  it('spends nothing when it refuses', async () => {
    const series = await indianInvoice()
    await codeOf(() => allocateNumber(db, series.id, null))

    expect(counterRows()).toEqual([])
    expect(await allocateNumber(db, series.id, '2026-27')).toBe('INV/2026-27/0001')
  })

  it('refuses a series that does not exist', async () => {
    expect(await codeOf(() => allocateNumber(db, 'nobody', '2026-27'))).toBe('SERIES_NOT_FOUND')
  })

  it('grows past the width rather than cutting a number down to one already issued', async () => {
    const series = await indianInvoice({
      width: 2,
      separator: '',
      prefix: '',
      includeFiscalYear: false,
    })
    writeCounter(series.id, '2026-27', 99)

    expect(await allocateNumber(db, series.id, '2026-27')).toBe('99')
    expect(await allocateNumber(db, series.id, '2026-27')).toBe('100')
  })
})

describe('allocation is atomic', () => {
  it('hands out two hundred numbers with no duplicate and no gap', async () => {
    const series = await indianInvoice({ prefix: '', separator: '', includeFiscalYear: false })

    const issued: string[] = []
    for (let i = 0; i < 200; i += 1) {
      issued.push(await allocateNumber(db, series.id, '2026-27'))
    }

    expect(new Set(issued).size).toBe(200)
    expect(issued[0]).toBe('0001')
    expect(issued[199]).toBe('0200')
    /* No gap, checked as a sequence rather than as a count: 200 distinct numbers that
     * skipped 17 and issued 201 would pass the two assertions above. */
    expect(issued).toEqual(Array.from({ length: 200 }, (_, i) => String(i + 1).padStart(4, '0')))
  })

  it('reads the counter inside the statement that advances it', async () => {
    /* The demonstration that this is not a read-then-write pair. Another writer moves
     * the counter after the first allocation; a cached read would hand out 2, and the
     * single UPDATE ... RETURNING hands out what the counter actually holds. */
    const series = await indianInvoice()
    expect(await allocateNumber(db, series.id, '2026-27')).toBe('INV/2026-27/0001')

    connection.prepare(`UPDATE numbering_counters SET next_sequence = next_sequence + 5`).run()

    expect(await allocateNumber(db, series.id, '2026-27')).toBe('INV/2026-27/0007')
  })

  it('does not hand one number to two connections', async () => {
    /* Two handles on the same file, alternating. Anything that read the counter into
     * memory and wrote it back would give the same number to both. */
    const series = await indianInvoice()
    const second = openDatabase({ filePath, key: KEY })
    handles.push(second)
    const otherDb = createQueryBuilder(second)

    const issued: string[] = []
    for (let i = 0; i < 20; i += 1) {
      issued.push(await allocateNumber(i % 2 === 0 ? db : otherDb, series.id, '2026-27'))
    }

    expect(new Set(issued).size).toBe(20)
    expect(issued[19]).toBe('INV/2026-27/0020')
  })

  it('rolls back with the transaction that was issuing the document', async () => {
    /* Rule 3: issuing is one transaction. A document that fails to post must not leave
     * its number spent, and a number spent on nothing is a gap in the series. */
    const series = await indianInvoice()

    await expect(
      db.transaction().execute(async (trx) => {
        await allocateNumber(trx, series.id, '2026-27')
        throw new Error('the entry did not balance')
      }),
    ).rejects.toThrow(/did not balance/)

    expect(counterRows()).toEqual([])
    expect(await allocateNumber(db, series.id, '2026-27')).toBe('INV/2026-27/0001')
  })

  it('joins the caller transaction rather than opening its own', async () => {
    /* Kysely refuses a transaction inside a transaction outright, so a repository
     * function that always opened one could not be called from `postEntry` at all. */
    const series = await indianInvoice()

    const numbers = await db
      .transaction()
      .execute(async (trx) => [
        await allocateNumber(trx, series.id, '2026-27'),
        await allocateNumber(trx, series.id, '2026-27'),
      ])

    expect(numbers).toEqual(['INV/2026-27/0001', 'INV/2026-27/0002'])
    expect(counterRows()[0]?.next_sequence).toBe(3)
  })

  it('keeps a number that was allocated in a transaction that committed', async () => {
    const series = await indianInvoice()
    await db.transaction().execute(async (trx) => allocateNumber(trx, series.id, '2026-27'))

    expect(await allocateNumber(db, series.id, '2026-27')).toBe('INV/2026-27/0002')
  })
})

describe('a series that has numbered something', () => {
  it('refuses every change to its shape, with the field named', async () => {
    const series = await indianInvoice()
    await allocateNumber(db, series.id, '2026-27')

    const failure = await failureOf(() => updateSeries(db, { id: series.id, prefix: 'SI' }))
    expect(failure.code).toBe('SERIES_IN_USE')
    expect(failure.details).toMatchObject({ changed: ['prefix'] })

    expect(await codeOf(() => updateSeries(db, { id: series.id, width: 6 }))).toBe('SERIES_IN_USE')
    expect(await codeOf(() => updateSeries(db, { id: series.id, separator: '-' }))).toBe(
      'SERIES_IN_USE',
    )
    expect(await codeOf(() => updateSeries(db, { id: series.id, suffix: 'X' }))).toBe(
      'SERIES_IN_USE',
    )
    expect(await codeOf(() => updateSeries(db, { id: series.id, includeFiscalYear: false }))).toBe(
      'SERIES_IN_USE',
    )
    expect(await codeOf(() => updateSeries(db, { id: series.id, resetOn: 'never' }))).toBe(
      'SERIES_IN_USE',
    )
  })

  it('still takes a new label, and the default', async () => {
    const series = await indianInvoice()
    await indianInvoice({ label: 'Other' })
    await allocateNumber(db, series.id, '2026-27')

    expect((await updateSeries(db, { id: series.id, label: 'Renamed' })).label).toBe('Renamed')
    expect((await updateSeries(db, { id: series.id, isDefault: true })).isDefault).toBe(true)
    expect((await archiveSeries(db, series.id, true)).isArchived).toBe(true)
  })

  it('accepts the shape it already has being sent back to it', async () => {
    /* A settings screen posts the whole record. Refusing an unchanged prefix would make
     * the label uneditable on every series that has issued anything. */
    const series = await indianInvoice()
    await allocateNumber(db, series.id, '2026-27')

    const updated = await updateSeries(db, {
      id: series.id,
      label: 'Renamed',
      prefix: 'INV',
      suffix: '',
      separator: '/',
      includeFiscalYear: true,
      width: 4,
      resetOn: 'fiscal-year',
    })

    expect(updated.label).toBe('Renamed')
  })

  it('changes shape freely before it has issued anything', async () => {
    const series = await indianInvoice()
    const updated = await updateSeries(db, {
      id: series.id,
      prefix: 'SI',
      separator: '-',
      width: 6,
      resetOn: 'never',
    })

    expect(updated.prefix).toBe('SI')
    expect(updated.separator).toBe('-')
    expect(updated.width).toBe(6)
    expect(updated.resetOn).toBe('never')
  })

  it('refuses a width nothing could be read at, before it looks at anything else', async () => {
    const series = await indianInvoice()
    expect(await codeOf(() => updateSeries(db, { id: series.id, width: 40 }))).toBe(
      'SERIES_WIDTH_INVALID',
    )
  })

  it('refuses a series that does not exist', async () => {
    expect(await codeOf(() => updateSeries(db, { id: 'nobody', label: 'X' }))).toBe(
      'SERIES_NOT_FOUND',
    )
  })
})

describe('archiving and deleting', () => {
  it('archives and unarchives, because a business restarts a series', async () => {
    const series = await indianInvoice()

    expect((await archiveSeries(db, series.id, true)).isArchived).toBe(true)
    expect((await archiveSeries(db, series.id, false)).isArchived).toBe(false)
  })

  it('deletes one that has never numbered anything', async () => {
    const series = await indianInvoice()
    await deleteSeries(db, series.id)
    expect(await getSeries(db, series.id)).toBeNull()
  })

  it('refuses to delete one that has', async () => {
    /* The numbers are on documents. Deleting the series throws away how far it had got,
     * and the next one created in its place starts again at 1. */
    const series = await indianInvoice()
    await allocateNumber(db, series.id, '2026-27')

    expect(await codeOf(() => deleteSeries(db, series.id))).toBe('SERIES_IN_USE')
    expect(await getSeries(db, series.id)).not.toBeNull()
  })

  it('refuses to delete one that does not exist', async () => {
    expect(await codeOf(() => deleteSeries(db, 'nobody'))).toBe('SERIES_NOT_FOUND')
  })

  it('archives a series without its counter going anywhere', async () => {
    const series = await indianInvoice()
    await allocateNumber(db, series.id, '2026-27')
    await archiveSeries(db, series.id, true)

    expect(counterRows()[0]?.next_sequence).toBe(2)
  })
})
