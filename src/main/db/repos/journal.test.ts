/*
 * Against a real encrypted database, not a mock.
 *
 * More so here than anywhere else in the project: the balance rule is a SQL trigger
 * doing integer arithmetic on text, the insert order is enforced by three triggers that
 * only exist in the migration, and a mock would exercise none of it. Every test opens a
 * SQLCipher file, migrates it, seeds a chart and a fiscal year, and puts the rule to the
 * database.
 *
 * `failureOf` is used wherever a rule is enforced twice, so a test can tell which layer
 * refused. Batch 1.1A and 1.1B each shipped tests that passed against a repository which
 * had stopped checking, because a trigger caught the mutation and reported the same code.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DATABASE_KEY_BYTES, closeDatabase, openDatabase, type SqliteDatabase } from '../connection'
import { createQueryBuilder, type CofferDb } from '../kysely'
import { runMigrations, rollbackMigrations } from '../migrate'
import { MIGRATIONS } from '../migrations'
import { aprilToMarch } from '@main/domain/time'
import { D, toMoneyString } from '@main/domain/money'
import { MANUAL_SOURCE, type EntryDraft } from '@main/domain/ledger'

import { seedChart } from './seed-chart'
import { createAccount, deleteAccount, listAccounts, updateAccount } from './accounts'
import { closePeriod, generateFiscalYear, periodForDate, reopenPeriod } from './periods'
import {
  getEntry,
  getEntryForSource,
  listEntries,
  postEntry,
  postManualEntry,
  reverseEntry,
} from './journal'
import { accountBalance, subtreeBalance, trialBalance } from './balances'
import { isRepoError, type RepoError, type RepoErrorCode } from './errors'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x3c)

const directories: string[] = []
const handles: SqliteDatabase[] = []

let connection: SqliteDatabase
let db: CofferDb
/** Account ids by code, from the seeded chart. */
let account: Record<string, string>

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-journal-'))
  directories.push(dir)
  connection = openDatabase({ filePath: join(dir, 'company.coffer'), key: KEY })
  handles.push(connection)
  runMigrations(connection, MIGRATIONS)
  db = createQueryBuilder(connection)

  await seedChart(db)
  await generateFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })

  account = {}
  for (const row of await listAccounts(db)) {
    account[row.code] = row.id
  }
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

/** Cash sale: debit bank, credit sales. The simplest entry that says something. */
const sale = (amount: string, date = '2026-04-15'): EntryDraft => ({
  date,
  narration: `Sale of ${amount}`,
  source: MANUAL_SOURCE,
  lines: [
    { accountId: account['1210']!, debit: D(amount), credit: D(0) },
    { accountId: account['4100']!, debit: D(0), credit: D(amount) },
  ],
})

const entryCount = () =>
  connection.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM journal_entries`).get()!.c
const lineCount = () =>
  connection.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM journal_lines`).get()!.c

describe('migration 0004', () => {
  it('creates the tables and rolls back cleanly', () => {
    const tableNames = () =>
      connection
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
        )
        .all()
        .map((row) => row.name)

    expect(tableNames()).toContain('journal_entries')
    expect(tableNames()).toContain('journal_lines')

    rollbackMigrations(connection, MIGRATIONS, { to: '0003' })
    expect(tableNames()).not.toContain('journal_entries')
    expect(tableNames()).not.toContain('journal_lines')
  })

  /*
   * The money shape is what makes the balance trigger's integer arithmetic exact. If
   * these CHECKs go, `REPLACE(debit, '.', '')` starts producing wrong integers and the
   * ledger stops balancing silently — so they are pinned individually.
   */
  it.each([
    ['12.3', 'one decimal place'],
    ['12.345', 'three decimal places'],
    ['12', 'no decimal point'],
    ['-1.00', 'a negative'],
    ['.50', 'a leading point'],
    ['1e5', 'an exponent'],
  ])('refuses %s as an amount (%s)', (value) => {
    expect(() =>
      connection
        .prepare(
          `INSERT INTO journal_lines (id, entry_id, line_number, account_id, debit, credit)
           VALUES ('l', 'e', 1, ?, ?, '0.00')`,
        )
        .run(account['1210'], value),
    ).toThrow(/CHECK/i)
  })

  it('refuses a line that is both a debit and a credit, and one that is neither', () => {
    const write = (debit: string, credit: string) =>
      connection
        .prepare(
          `INSERT INTO journal_lines (id, entry_id, line_number, account_id, debit, credit)
           VALUES (?, 'e', 1, ?, ?, ?)`,
        )
        .run(`l-${debit}-${credit}`, account['1210'], debit, credit)

    expect(() => write('10.00', '10.00')).toThrow(/CHECK/i)
    expect(() => write('0.00', '0.00')).toThrow(/CHECK/i)

    /* The valid one still fails, on the foreign key rather than the CHECK — which is
     * what proves it got past the CHECK. See the test below for why the key bites here
     * and not inside `postEntry`. */
    expect(() => write('10.00', '0.00')).toThrow(/FOREIGN KEY/i)
  })

  /*
   * Worth pinning: a deferred foreign key is deferred to the end of the enclosing
   * TRANSACTION, and a bare statement is its own transaction. So the lines-before-entry
   * order only works inside an explicit one — which `postEntry` always opens, and which
   * anything writing a journal by hand would have to.
   */
  it('defers the line-to-entry key only inside a transaction', () => {
    const line = (id: string) =>
      connection
        .prepare(
          `INSERT INTO journal_lines (id, entry_id, line_number, account_id, debit, credit)
           VALUES (?, 'pending', 1, ?, '10.00', '0.00')`,
        )
        .run(id, account['1210'])

    expect(() => line('loose')).toThrow(/FOREIGN KEY/i)
    expect(() =>
      connection.transaction(() => {
        line('held')
        throw new Error('rolled back before commit')
      })(),
    ).toThrow('rolled back before commit')
  })
})

describe('the balance rule', () => {
  it('posts a balanced entry', async () => {
    const result = await postEntry(db, sale('1000.00'))

    expect(result.entryNumber).toBe('JV-2026-27-0001')
    expect(result.total).toBe('1000.00')
    expect(result.lineCount).toBe(2)
    expect(entryCount()).toBe(1)
  })

  it('refuses an entry out by one paisa', async () => {
    const draft = sale('1000.00')
    const failure = await failureOf(() =>
      postEntry(db, {
        ...draft,
        lines: [draft.lines[0]!, { ...draft.lines[1]!, credit: D('999.99') }],
      }),
    )

    expect(failure.code).toBe('UNBALANCED_ENTRY')
    expect(entryCount()).toBe(0)
    expect(lineCount()).toBe(0)
  })

  it('refuses a single-line entry', async () => {
    const draft = sale('1000.00')
    expect(await codeOf(() => postEntry(db, { ...draft, lines: [draft.lines[0]!] }))).toBe(
      'INSUFFICIENT_LINES',
    )
  })

  it('reports every structural problem at once, not the first', async () => {
    const failure = await failureOf(() =>
      postEntry(db, {
        date: '2026-04-15',
        narration: 'A mess',
        source: MANUAL_SOURCE,
        lines: [
          { accountId: account['1210']!, debit: D('-5.00'), credit: D(0) },
          { accountId: account['4100']!, debit: D('1.00'), credit: D('1.00') },
        ],
      }),
    )

    const codes = (failure.details['problems'] as { code: string }[]).map((p) => p.code)
    expect(codes).toContain('NEGATIVE_AMOUNT')
    expect(codes).toContain('AMBIGUOUS_LINE')
    expect(failure.message).toContain('line 1')
    expect(failure.message).toContain('line 2')
  })

  /*
   * The trigger, reached directly. The repository refuses this long before the database
   * sees it, so without going round the repository there is no test that the database
   * would refuse it too — and the database is the half that a future caller cannot skip.
   */
  it('refuses an unbalanced entry at the database, not only in the repository', () => {
    const write = connection.transaction(() => {
      connection
        .prepare(
          `INSERT INTO journal_lines (id, entry_id, line_number, account_id, debit, credit)
           VALUES ('l1', 'raw', 1, ?, '100.00', '0.00')`,
        )
        .run(account['1210'])
      connection
        .prepare(
          `INSERT INTO journal_lines (id, entry_id, line_number, account_id, debit, credit)
           VALUES ('l2', 'raw', 2, ?, '0.00', '99.99')`,
        )
        .run(account['4100'])
      connection
        .prepare(
          `INSERT INTO journal_entries
             (id, entry_number, entry_date, narration, source_type, source_id, source_number,
              period_id, reverses_entry_id, posted_at)
           VALUES ('raw', 'JV-RAW-0001', '2026-04-15', 'raw', 'manual', NULL, NULL,
                   ?, NULL, '2026-04-15T00:00:00.000Z')`,
        )
        .run(periodId('2026-04-15'))
    })

    expect(() => write()).toThrow(/UNBALANCED_ENTRY/)
    expect(lineCount()).toBe(0)
  })

  /*
   * The finding that changed the design. A deferred foreign key does NOT stop an entry
   * being written before its lines, and that order skips the balance check entirely —
   * the trigger sums no lines, and no lines balance. What refuses it is the two-line
   * trigger, and this test is what keeps that true.
   */
  it('refuses an entry written before its lines, which the foreign key alone would allow', () => {
    const write = connection.transaction(() => {
      connection
        .prepare(
          `INSERT INTO journal_entries
             (id, entry_number, entry_date, narration, source_type, source_id, source_number,
              period_id, reverses_entry_id, posted_at)
           VALUES ('first', 'JV-RAW-0002', '2026-04-15', 'raw', 'manual', NULL, NULL,
                   ?, NULL, '2026-04-15T00:00:00.000Z')`,
        )
        .run(periodId('2026-04-15'))
      connection
        .prepare(
          `INSERT INTO journal_lines (id, entry_id, line_number, account_id, debit, credit)
           VALUES ('f1', 'first', 1, ?, '100.00', '0.00')`,
        )
        .run(account['1210'])
    })

    expect(() => write()).toThrow(/INSUFFICIENT_LINES/)
    expect(entryCount()).toBe(0)
  })

  it('refuses a line appended to an entry that is already posted', async () => {
    const posted = await postEntry(db, sale('500.00'))

    expect(() =>
      connection
        .prepare(
          `INSERT INTO journal_lines (id, entry_id, line_number, account_id, debit, credit)
           VALUES ('extra', ?, 3, ?, '1.00', '0.00')`,
        )
        .run(posted.entryId, account['1210']),
    ).toThrow(/ENTRY_IMMUTABLE/)
  })

  it('sums exactly, where floating point would not', async () => {
    /* Ten tenths, and a total that REAL arithmetic gets wrong by design. */
    await postEntry(db, {
      date: '2026-04-15',
      narration: 'Tenths',
      source: MANUAL_SOURCE,
      lines: [
        { accountId: account['1210']!, debit: D('1.00'), credit: D(0) },
        ...Array.from({ length: 10 }, () => ({
          accountId: account['4100']!,
          debit: D(0),
          credit: D('0.10'),
        })),
      ],
    })

    const balance = await accountBalance(db, account['4100']!)
    expect(balance.credit).toBe('1.00')
  })

  it('posts an entry whose tax splits three ways without drifting', async () => {
    const cgst = await createAccount(db, {
      code: '2210',
      name: 'CGST Output',
      type: 'liability',
      parentId: account['2200']!,
      isGroup: false,
    })
    const sgst = await createAccount(db, {
      code: '2220',
      name: 'SGST Output',
      type: 'liability',
      parentId: account['2200']!,
      isGroup: false,
    })

    await postEntry(db, {
      date: '2026-04-15',
      narration: 'Invoice with GST',
      source: MANUAL_SOURCE,
      lines: [
        { accountId: account['1300']!, debit: D('1234567.89'), credit: D(0) },
        { accountId: account['4100']!, debit: D(0), credit: D('1046243.97') },
        { accountId: cgst.id, debit: D(0), credit: D('94161.96') },
        { accountId: sgst.id, debit: D(0), credit: D('94161.96') },
      ],
    })

    const tb = await trialBalance(db)
    expect(tb.totalDebit).toBe('1234567.89')
    expect(tb.totalCredit).toBe('1234567.89')
    expect(tb.balanced).toBe(true)
  })
})

describe('where an entry may land', () => {
  it('refuses a date no period covers', async () => {
    expect(await codeOf(() => postEntry(db, sale('100.00', '2030-01-01')))).toBe('NO_PERIOD')
  })

  it('refuses a closed period', async () => {
    const april = await periodForDate(db, '2026-04-15')
    await closePeriod(db, april!.id)

    expect(await codeOf(() => postEntry(db, sale('100.00')))).toBe('PERIOD_CLOSED')
  })

  it('refuses a closed period at the database as well', async () => {
    const april = await periodForDate(db, '2026-04-15')
    await closePeriod(db, april!.id)

    const write = connection.transaction(() => {
      connection
        .prepare(
          `INSERT INTO journal_lines (id, entry_id, line_number, account_id, debit, credit)
           VALUES ('c1', 'closed', 1, ?, '10.00', '0.00')`,
        )
        .run(account['1210'])
      connection
        .prepare(
          `INSERT INTO journal_lines (id, entry_id, line_number, account_id, debit, credit)
           VALUES ('c2', 'closed', 2, ?, '0.00', '10.00')`,
        )
        .run(account['4100'])
      connection
        .prepare(
          `INSERT INTO journal_entries
             (id, entry_number, entry_date, narration, source_type, source_id, source_number,
              period_id, reverses_entry_id, posted_at)
           VALUES ('closed', 'JV-RAW-0003', '2026-04-15', 'raw', 'manual', NULL, NULL,
                   ?, NULL, '2026-04-15T00:00:00.000Z')`,
        )
        .run(april!.id)
    })

    expect(() => write()).toThrow(/PERIOD_CLOSED/)
  })

  it('accepts the period again once it is reopened', async () => {
    const april = await periodForDate(db, '2026-04-15')
    await closePeriod(db, april!.id)
    await reopenPeriod(db, april!.id)

    await expect(postEntry(db, sale('100.00'))).resolves.toMatchObject({ total: '100.00' })
  })

  it('refuses an entry whose date is outside the period it names', () => {
    const write = connection.transaction(() => {
      connection
        .prepare(
          `INSERT INTO journal_lines (id, entry_id, line_number, account_id, debit, credit)
           VALUES ('m1', 'mismatch', 1, ?, '10.00', '0.00')`,
        )
        .run(account['1210'])
      connection
        .prepare(
          `INSERT INTO journal_lines (id, entry_id, line_number, account_id, debit, credit)
           VALUES ('m2', 'mismatch', 2, ?, '0.00', '10.00')`,
        )
        .run(account['4100'])
      connection
        .prepare(
          `INSERT INTO journal_entries
             (id, entry_number, entry_date, narration, source_type, source_id, source_number,
              period_id, reverses_entry_id, posted_at)
           VALUES ('mismatch', 'JV-RAW-0004', '2026-09-15', 'raw', 'manual', NULL, NULL,
                   ?, NULL, '2026-09-15T00:00:00.000Z')`,
        )
        .run(periodId('2026-04-15'))
    })

    expect(() => write()).toThrow(/ENTRY_PERIOD_MISMATCH/)
  })

  it('refuses a posting to a group account', async () => {
    const draft = sale('100.00')
    const failure = await failureOf(() =>
      postEntry(db, {
        ...draft,
        lines: [{ ...draft.lines[0]!, accountId: account['1000']! }, draft.lines[1]!],
      }),
    )

    expect(failure.code).toBe('ACCOUNT_IS_GROUP')
    expect(failure.details).toMatchObject({ codes: ['1000'] })
  })

  it('refuses a posting to a group account at the database as well', () => {
    expect(() =>
      connection
        .prepare(
          `INSERT INTO journal_lines (id, entry_id, line_number, account_id, debit, credit)
           VALUES ('g1', 'grp', 1, ?, '10.00', '0.00')`,
        )
        .run(account['1000']),
    ).toThrow(/ACCOUNT_IS_GROUP/)
  })

  it('refuses a posting to an archived account, naming it', async () => {
    await updateAccount(db, { id: account['1210']!, isArchived: true })
    const failure = await failureOf(() => postEntry(db, sale('100.00')))

    expect(failure.code).toBe('ACCOUNT_ARCHIVED')
    expect(failure.details).toMatchObject({ codes: ['1210'] })
  })

  it('refuses a line naming an account that does not exist', async () => {
    const draft = sale('100.00')
    const failure = await failureOf(() =>
      postEntry(db, {
        ...draft,
        lines: [{ ...draft.lines[0]!, accountId: 'not-an-account' }, draft.lines[1]!],
      }),
    )

    expect(failure.code).toBe('ACCOUNT_NOT_FOUND')
    expect(failure.details).toMatchObject({ accountIds: ['not-an-account'] })
  })
})

describe('a posted entry is immutable', () => {
  it('refuses every update and delete, on the entry and on its lines', async () => {
    const posted = await postEntry(db, sale('250.00'))

    expect(() =>
      connection
        .prepare(`UPDATE journal_entries SET narration = 'edited' WHERE id = ?`)
        .run(posted.entryId),
    ).toThrow(/ENTRY_IMMUTABLE/)
    expect(() =>
      connection.prepare(`DELETE FROM journal_entries WHERE id = ?`).run(posted.entryId),
    ).toThrow(/ENTRY_IMMUTABLE/)
    expect(() =>
      connection
        .prepare(`UPDATE journal_lines SET debit = '9999.00' WHERE entry_id = ?`)
        .run(posted.entryId),
    ).toThrow(/ENTRY_IMMUTABLE/)
    expect(() =>
      connection.prepare(`DELETE FROM journal_lines WHERE entry_id = ?`).run(posted.entryId),
    ).toThrow(/ENTRY_IMMUTABLE/)
  })

  it('refuses to delete an account that has been posted to', async () => {
    await postEntry(db, sale('100.00'))
    const failure = await failureOf(() => deleteAccount(db, account['1210']!))

    expect(failure.code).toBe('ACCOUNT_IN_USE')
    expect(failure.message).toContain('Archive it instead')
  })

  it('refuses to turn a posted-to account into a group', async () => {
    await postEntry(db, sale('100.00'))

    expect(() =>
      connection.prepare(`UPDATE accounts SET is_group = 1 WHERE id = ?`).run(account['1210']),
    ).toThrow(/ACCOUNT_IN_USE/)
  })

  it('still allows an account with no postings to become a group', () => {
    expect(() =>
      connection.prepare(`UPDATE accounts SET is_group = 1 WHERE id = ?`).run(account['1600']),
    ).not.toThrow()
  })
})

describe('numbering', () => {
  it('counts up within a fiscal year', async () => {
    const first = await postEntry(db, sale('10.00'))
    const second = await postEntry(db, sale('20.00'))
    const third = await postEntry(db, sale('30.00', '2026-06-01'))

    expect([first.entryNumber, second.entryNumber, third.entryNumber]).toEqual([
      'JV-2026-27-0001',
      'JV-2026-27-0002',
      'JV-2026-27-0003',
    ])
  })

  it('restarts each fiscal year', async () => {
    await generateFiscalYear(db, { rule: aprilToMarch, startYear: 2027 })
    await postEntry(db, sale('10.00', '2026-04-15'))
    const next = await postEntry(db, sale('10.00', '2027-04-15'))

    expect(next.entryNumber).toBe('JV-2027-28-0001')
  })

  /*
   * The sequence is derived from the numeric suffix, not from a text sort, so it keeps
   * counting where a string comparison would put '10000' before '9999' and hand out
   * 'JV-2026-27-10000' twice.
   */
  it('keeps counting past the padding width rather than colliding', async () => {
    await postEntry(db, sale('10.00'))

    /* Reach 9999 by writing one entry numbered there, then post the next. */
    const period = await periodForDate(db, '2026-04-15')
    const write = connection.transaction(() => {
      connection
        .prepare(
          `INSERT INTO journal_lines (id, entry_id, line_number, account_id, debit, credit)
           VALUES ('h1', 'high', 1, ?, '1.00', '0.00')`,
        )
        .run(account['1210'])
      connection
        .prepare(
          `INSERT INTO journal_lines (id, entry_id, line_number, account_id, debit, credit)
           VALUES ('h2', 'high', 2, ?, '0.00', '1.00')`,
        )
        .run(account['4100'])
      connection
        .prepare(
          `INSERT INTO journal_entries
             (id, entry_number, entry_date, narration, source_type, source_id, source_number,
              period_id, reverses_entry_id, posted_at)
           VALUES ('high', 'JV-2026-27-9999', '2026-04-15', 'high', 'manual', NULL, NULL,
                   ?, NULL, '2026-04-15T00:00:00.000Z')`,
        )
        .run(period!.id)
    })
    write()

    const next = await postEntry(db, sale('10.00'))
    expect(next.entryNumber).toBe('JV-2026-27-10000')
  })
})

describe('reversing', () => {
  it('writes the mirror of the original', async () => {
    const original = await postEntry(db, sale('750.00'))
    const reversal = await reverseEntry(db, {
      entryId: original.entryId,
      date: '2026-05-10',
      narration: 'Reversing the April sale',
    })

    const reversed = await getEntry(db, reversal.entryId)
    expect(reversed?.date).toBe('2026-05-10')
    expect(reversed?.reversesEntryId).toBe(original.entryId)
    expect(reversed?.lines.map((line) => [line.accountCode, line.debit, line.credit])).toEqual([
      ['1210', '0.00', '750.00'],
      ['4100', '750.00', '0.00'],
    ])
  })

  it('leaves the two entries netting to nothing', async () => {
    const original = await postEntry(db, sale('750.00'))
    await reverseEntry(db, {
      entryId: original.entryId,
      date: '2026-05-10',
      narration: 'Reversed',
    })

    const balance = await accountBalance(db, account['1210']!)
    expect(balance.balance).toBe('0.00')
    expect(balance.debit).toBe('750.00')
    expect(balance.credit).toBe('750.00')
  })

  it('does not edit or remove the original — invariant 3', async () => {
    const original = await postEntry(db, sale('750.00'))
    await reverseEntry(db, {
      entryId: original.entryId,
      date: '2026-05-10',
      narration: 'Reversed',
    })

    const still = await getEntry(db, original.entryId)
    expect(still?.lines[0]?.debit).toBe('750.00')
    expect(entryCount()).toBe(2)
  })

  it('links both ways', async () => {
    const original = await postEntry(db, sale('750.00'))
    const reversal = await reverseEntry(db, {
      entryId: original.entryId,
      date: '2026-05-10',
      narration: 'Reversed',
    })

    expect((await getEntry(db, original.entryId))?.reversedByEntryId).toBe(reversal.entryId)
    expect((await getEntry(db, reversal.entryId))?.reversesEntryId).toBe(original.entryId)
  })

  it('refuses to reverse the same entry twice', async () => {
    const original = await postEntry(db, sale('750.00'))
    await reverseEntry(db, { entryId: original.entryId, date: '2026-05-10', narration: 'One' })

    const failure = await failureOf(() =>
      reverseEntry(db, { entryId: original.entryId, date: '2026-05-11', narration: 'Two' }),
    )
    expect(failure.code).toBe('ALREADY_REVERSED')
    expect(failure.details).toMatchObject({ entryId: original.entryId })
  })

  it('refuses a second reversal at the database as well', async () => {
    const original = await postEntry(db, sale('750.00'))
    await reverseEntry(db, { entryId: original.entryId, date: '2026-05-10', narration: 'One' })

    const write = connection.transaction(() => {
      connection
        .prepare(
          `INSERT INTO journal_lines (id, entry_id, line_number, account_id, debit, credit)
           VALUES ('r1', 'second', 1, ?, '750.00', '0.00')`,
        )
        .run(account['4100'])
      connection
        .prepare(
          `INSERT INTO journal_lines (id, entry_id, line_number, account_id, debit, credit)
           VALUES ('r2', 'second', 2, ?, '0.00', '750.00')`,
        )
        .run(account['1210'])
      connection
        .prepare(
          `INSERT INTO journal_entries
             (id, entry_number, entry_date, narration, source_type, source_id, source_number,
              period_id, reverses_entry_id, posted_at)
           VALUES ('second', 'JV-RAW-0005', '2026-05-11', 'raw', 'manual', NULL, NULL,
                   ?, ?, '2026-05-11T00:00:00.000Z')`,
        )
        .run(periodId('2026-05-11'), original.entryId)
    })

    expect(() => write()).toThrow(/UNIQUE/i)
  })

  it('reverses an entry whose account has since been archived', async () => {
    const original = await postEntry(db, sale('750.00'))
    await updateAccount(db, { id: account['1210']!, isArchived: true })

    await expect(
      reverseEntry(db, { entryId: original.entryId, date: '2026-05-10', narration: 'Reversed' }),
    ).resolves.toMatchObject({ total: '750.00' })
  })

  it('refuses to reverse an entry that is not there', async () => {
    expect(
      await codeOf(() =>
        reverseEntry(db, { entryId: 'nothing', date: '2026-05-10', narration: 'x' }),
      ),
    ).toBe('ENTRY_NOT_FOUND')
  })

  it('refuses a reversal dated into a closed period', async () => {
    const original = await postEntry(db, sale('750.00'))
    const may = await periodForDate(db, '2026-05-10')
    const april = await periodForDate(db, '2026-04-15')
    await closePeriod(db, april!.id)
    await closePeriod(db, may!.id)

    expect(
      await codeOf(() =>
        reverseEntry(db, { entryId: original.entryId, date: '2026-05-10', narration: 'x' }),
      ),
    ).toBe('PERIOD_CLOSED')
  })
})

describe('reading back', () => {
  it('returns an entry with its lines in order and its total', async () => {
    const posted = await postEntry(db, sale('120.50'))
    const entry = await getEntry(db, posted.entryId)

    expect(entry?.entryNumber).toBe('JV-2026-27-0001')
    expect(entry?.total).toBe('120.50')
    expect(entry?.lines.map((line) => line.lineNumber)).toEqual([1, 2])
    expect(entry?.lines[0]?.accountCode).toBe('1210')
    expect(entry?.lines[0]?.accountName).toBe('Bank Account')
  })

  it('returns null for an entry these books do not have', async () => {
    expect(await getEntry(db, 'nothing')).toBeNull()
  })

  it('lists in date order, then by number', async () => {
    await postEntry(db, sale('10.00', '2026-06-01'))
    await postEntry(db, sale('20.00', '2026-04-15'))
    await postEntry(db, sale('30.00', '2026-04-15'))

    const entries = await listEntries(db)
    expect(entries.map((entry) => [entry.date, entry.entryNumber])).toEqual([
      ['2026-04-15', 'JV-2026-27-0002'],
      ['2026-04-15', 'JV-2026-27-0003'],
      ['2026-06-01', 'JV-2026-27-0001'],
    ])
  })

  it('filters by date range, period and account', async () => {
    await postEntry(db, sale('10.00', '2026-04-15'))
    await postEntry(db, sale('20.00', '2026-06-01'))

    expect(await listEntries(db, { fromDate: '2026-05-01' })).toHaveLength(1)
    expect(await listEntries(db, { toDate: '2026-05-01' })).toHaveLength(1)
    expect(
      await listEntries(db, { periodId: (await periodForDate(db, '2026-06-01'))!.id }),
    ).toHaveLength(1)
    expect(await listEntries(db, { accountId: account['4100']! })).toHaveLength(2)
    expect(await listEntries(db, { accountId: account['1100']! })).toHaveLength(0)
  })

  it('finds the entry a document posted, and not that document’s reversal', async () => {
    const draft = sale('500.00')
    const posted = await postEntry(db, {
      ...draft,
      source: { type: 'sales-invoice', id: 'inv-1', number: 'INV-2026-27-0001' },
    })
    await reverseEntry(db, { entryId: posted.entryId, date: '2026-05-10', narration: 'Cancelled' })

    const found = await getEntryForSource(db, 'sales-invoice', 'inv-1')
    expect(found?.id).toBe(posted.entryId)
    expect(found?.sourceNumber).toBe('INV-2026-27-0001')
  })
})

describe('posting a typed journal', () => {
  it('parses decimal strings and posts', async () => {
    const result = await postManualEntry(db, {
      date: '2026-04-15',
      narration: 'Owner introduces capital',
      lines: [
        { accountId: account['1210']!, debit: '50000.00', credit: '0.00' },
        { accountId: account['3100']!, debit: '0.00', credit: '50000.00' },
      ],
    })

    expect(result.total).toBe('50000.00')
    expect((await getEntry(db, result.entryId))?.sourceType).toBe('manual')
  })

  it('refuses an amount that is not a number, saying which line', async () => {
    const failure = await failureOf(() =>
      postManualEntry(db, {
        date: '2026-04-15',
        narration: 'Bad',
        lines: [
          { accountId: account['1210']!, debit: '50000.00', credit: '0.00' },
          { accountId: account['3100']!, debit: '0.00', credit: 'fifty thousand' },
        ],
      }),
    )

    expect(failure.code).toBe('INVALID_AMOUNT')
    expect(failure.details).toMatchObject({ lineIndex: 1, side: 'credit' })
  })
})

describe('the trial balance', () => {
  beforeEach(async () => {
    await postManualEntry(db, {
      date: '2026-04-01',
      narration: 'Capital introduced',
      lines: [
        { accountId: account['1210']!, debit: '100000.00', credit: '0.00' },
        { accountId: account['3100']!, debit: '0.00', credit: '100000.00' },
      ],
    })
    await postManualEntry(db, {
      date: '2026-04-15',
      narration: 'Sale on credit',
      lines: [
        { accountId: account['1300']!, debit: '23600.00', credit: '0.00' },
        { accountId: account['4100']!, debit: '0.00', credit: '23600.00' },
      ],
    })
    await postManualEntry(db, {
      date: '2026-05-02',
      narration: 'Rent',
      lines: [
        { accountId: account['6200']!, debit: '15000.00', credit: '0.00' },
        { accountId: account['1210']!, debit: '0.00', credit: '15000.00' },
      ],
    })
  })

  it('ties', async () => {
    const tb = await trialBalance(db)

    expect(tb.balanced).toBe(true)
    expect(tb.totalDebit).toBe(tb.totalCredit)
    expect(tb.totalDebit).toBe('138600.00')
  })

  it('puts each account on the side its balance falls', async () => {
    const tb = await trialBalance(db)
    const row = (code: string) => tb.rows.find((r) => r.code === code)

    expect(row('1210')).toMatchObject({ debitBalance: '85000.00', creditBalance: '0.00' })
    expect(row('3100')).toMatchObject({ debitBalance: '0.00', creditBalance: '100000.00' })
    expect(row('6200')).toMatchObject({ debitBalance: '15000.00', creditBalance: '0.00' })
  })

  it('lists in code order and never includes a group', async () => {
    const tb = await trialBalance(db)
    const codes = tb.rows.map((row) => row.code)

    expect(codes).toEqual([...codes].sort())
    expect(codes).not.toContain('1000')
    expect(codes).not.toContain('2000')
  })

  it('ties for any date range', async () => {
    for (const range of [
      { toDate: '2026-04-30' },
      { fromDate: '2026-04-15' },
      { fromDate: '2026-04-02', toDate: '2026-05-01' },
      { fromDate: '2030-01-01' },
    ]) {
      const tb = await trialBalance(db, range)
      expect(tb.balanced, JSON.stringify(range)).toBe(true)
    }
  })

  it('excludes what falls after toDate', async () => {
    const tb = await trialBalance(db, { toDate: '2026-04-30' })
    expect(tb.rows.find((row) => row.code === '6200')).toBeUndefined()
    expect(tb.totalDebit).toBe('123600.00')
  })

  /*
   * The lower bound, pinned separately. `balanced` stays true whether or not `fromDate`
   * is applied — both filters drop whole entries, and a whole entry balances — so a test
   * asserting only that the totals agree cannot tell the filter has stopped working.
   * Dropping it survived the first mutation pass for exactly that reason.
   */
  it('excludes what falls before fromDate', async () => {
    const tb = await trialBalance(db, { fromDate: '2026-05-01' })

    expect(tb.rows.map((row) => row.code)).toEqual(['1210', '6200'])
    expect(tb.totalDebit).toBe('15000.00')
    expect(tb.rows.find((row) => row.code === '3100')).toBeUndefined()
  })

  it('applies both bounds together', async () => {
    const tb = await trialBalance(db, { fromDate: '2026-04-10', toDate: '2026-04-20' })

    expect(tb.rows.map((row) => row.code)).toEqual(['1300', '4100'])
    expect(tb.totalDebit).toBe('23600.00')
  })

  it('still ties after a reversal', async () => {
    const entries = await listEntries(db, { fromDate: '2026-04-15', toDate: '2026-04-15' })
    await reverseEntry(db, {
      entryId: entries[0]!.id,
      date: '2026-05-20',
      narration: 'Sale cancelled',
    })

    const tb = await trialBalance(db)
    expect(tb.balanced).toBe(true)
    expect(tb.rows.find((row) => row.code === '4100')).toMatchObject({
      debitBalance: '0.00',
      creditBalance: '0.00',
    })
  })

  it('keeps the accounting equation: assets - liabilities - equity = income - expenses', async () => {
    const tb = await trialBalance(db)
    const totalFor = (types: string[]) =>
      tb.rows
        .filter((row) => types.includes(row.type))
        .reduce((sum, row) => sum.plus(D(row.debit)).minus(D(row.credit)), D(0))

    const permanent = totalFor(['asset', 'liability', 'equity'])
    const temporary = totalFor(['income', 'expense'])
    expect(toMoneyString(permanent.plus(temporary))).toBe('0.00')
  })
})

describe('account balances', () => {
  it('reports a balance positive in the account’s own direction', async () => {
    await postManualEntry(db, {
      date: '2026-04-01',
      narration: 'Capital',
      lines: [
        { accountId: account['1210']!, debit: '100000.00', credit: '0.00' },
        { accountId: account['3100']!, debit: '0.00', credit: '100000.00' },
      ],
    })

    /* An asset rises on debit, equity on credit — both report a positive balance. */
    expect((await accountBalance(db, account['1210']!)).balance).toBe('100000.00')
    expect((await accountBalance(db, account['3100']!)).balance).toBe('100000.00')
  })

  it('reports zero for an account nothing has touched', async () => {
    const balance = await accountBalance(db, account['1100']!)
    expect(balance.balance).toBe('0.00')
    expect(balance.debit).toBe('0.00')
  })

  it('refuses a group, which holds no figures of its own', async () => {
    expect(await codeOf(() => accountBalance(db, account['1000']!))).toBe('ACCOUNT_IS_GROUP')
  })

  it('refuses an account that does not exist', async () => {
    expect(await codeOf(() => accountBalance(db, 'nothing'))).toBe('ACCOUNT_NOT_FOUND')
  })

  it('totals a group from its leaves', async () => {
    await postManualEntry(db, {
      date: '2026-04-01',
      narration: 'Capital',
      lines: [
        { accountId: account['1210']!, debit: '100000.00', credit: '0.00' },
        { accountId: account['3100']!, debit: '0.00', credit: '100000.00' },
      ],
    })
    await postManualEntry(db, {
      date: '2026-04-02',
      narration: 'Cash float',
      lines: [
        { accountId: account['1100']!, debit: '5000.00', credit: '0.00' },
        { accountId: account['1210']!, debit: '0.00', credit: '5000.00' },
      ],
    })

    const currentAssets = await subtreeBalance(db, account['1000']!)
    expect(toMoneyString(currentAssets)).toBe('100000.00')
  })
})

/** The id of the period covering a date, read straight from the connection. */
function periodId(date: string): string {
  const row = connection
    .prepare<[string, string], { id: string }>(
      `SELECT id FROM accounting_periods WHERE start_date <= ? AND end_date >= ?`,
    )
    .get(date, date)
  if (row === undefined) {
    throw new Error(`no period covers ${date}`)
  }
  return row.id
}
