/*
 * Migration runner tests. Every one runs against a real encrypted file, because the
 * runner's contract is about what survives on disk between two runs of the app.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DATABASE_KEY_BYTES, type SqliteDatabase, closeDatabase, openDatabase } from './connection'
import { DbError } from './errors'
import {
  type Migration,
  appliedMigrations,
  currentVersion,
  rollbackMigrations,
  runMigrations,
  validateRegistry,
} from './migrate'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x5e)

const directories: string[] = []
const handles: SqliteDatabase[] = []

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-migrate-'))
  directories.push(dir)
  return join(dir, 'company.coffer')
}

function open(filePath: string): SqliteDatabase {
  const db = openDatabase({ filePath, key: KEY })
  handles.push(db)
  return db
}

function freshDb(): SqliteDatabase {
  return open(tempPath())
}

afterEach(() => {
  for (const db of handles.splice(0)) {
    try {
      closeDatabase(db)
    } catch {
      /* a test may have closed it already */
    }
  }
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

/** A migration that creates one table and drops it again. */
function createsTable(id: string, name: string): Migration {
  return {
    id,
    name,
    up(db) {
      db.exec(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY) STRICT`)
    },
    down(db) {
      db.exec(`DROP TABLE ${name}`)
    },
  }
}

/** A migration that does real work and then throws part way through. */
function throwsHalfWay(id: string, name: string): Migration {
  return {
    id,
    name,
    up(db) {
      db.exec(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY) STRICT`)
      db.exec(`CREATE TABLE ${name}_second (id INTEGER PRIMARY KEY) STRICT`)
      throw new Error('deliberate failure')
    },
    down(db) {
      db.exec(`DROP TABLE ${name}`)
    },
  }
}

/** A migration that cannot be undone. */
function irreversible(id: string, name: string): Migration {
  return {
    id,
    name,
    up(db) {
      db.exec(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY) STRICT`)
    },
  }
}

function tableNames(db: SqliteDatabase): string[] {
  return db
    .prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all()
    .map((row) => row.name)
    .sort()
}

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof DbError ? error.code : `not a DbError: ${String(error)}`
  }
  return 'did not throw'
}

describe('validateRegistry', () => {
  it('orders by number rather than by string', () => {
    const registry = [createsTable('0010', 'ten'), createsTable('0009', 'nine')]
    expect(validateRegistry(registry).map((m) => m.id)).toEqual(['0009', '0010'])
  })

  it('rejects two migrations claiming the same number', () => {
    const registry = [createsTable('0001', 'first'), createsTable('0001', 'also_first')]
    expect(codeOf(() => validateRegistry(registry))).toBe('DB_MIGRATION_REGISTRY_INVALID')
  })

  it('rejects an id that is not a zero-padded number', () => {
    expect(codeOf(() => validateRegistry([createsTable('1', 'first')]))).toBe(
      'DB_MIGRATION_REGISTRY_INVALID',
    )
    expect(codeOf(() => validateRegistry([createsTable('0001a', 'first')]))).toBe(
      'DB_MIGRATION_REGISTRY_INVALID',
    )
  })

  it('rejects a migration with no name', () => {
    expect(codeOf(() => validateRegistry([{ id: '0001', name: '  ', up: () => {} }]))).toBe(
      'DB_MIGRATION_REGISTRY_INVALID',
    )
  })

  it('accepts an empty registry', () => {
    expect(validateRegistry([])).toEqual([])
  })
})

describe('runMigrations', () => {
  it('applies every migration in order and records each one', () => {
    const db = freshDb()
    const registry = [
      createsTable('0002', 'second'),
      createsTable('0001', 'first'),
      createsTable('0010', 'tenth'),
    ]

    const result = runMigrations(db, registry)

    expect(result).toEqual({ from: null, to: '0010', applied: ['0001', '0002', '0010'] })
    expect(tableNames(db)).toEqual(['first', 'schema_migrations', 'second', 'tenth'])

    const applied = appliedMigrations(db)
    expect(applied.map((m) => m.id)).toEqual(['0001', '0002', '0010'])
    expect(applied.map((m) => m.name)).toEqual(['first', 'second', 'tenth'])
    for (const migration of applied) {
      expect(migration.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
  })

  it('applies each migration exactly once', () => {
    const db = freshDb()
    const registry = [createsTable('0001', 'first'), createsTable('0002', 'second')]

    runMigrations(db, registry)
    const second = runMigrations(db, registry)

    expect(second).toEqual({ from: '0002', to: '0002', applied: [] })
    expect(appliedMigrations(db)).toHaveLength(2)
  })

  it('stays applied across a close and reopen', () => {
    const path = tempPath()
    const registry = [createsTable('0001', 'first'), createsTable('0002', 'second')]

    const first = open(path)
    runMigrations(first, registry)
    closeDatabase(first)

    const reopened = open(path)
    expect(currentVersion(reopened)).toBe('0002')
    expect(runMigrations(reopened, registry).applied).toEqual([])
    expect(tableNames(reopened)).toContain('second')
  })

  it('applies only what a later run adds', () => {
    const db = freshDb()
    runMigrations(db, [createsTable('0001', 'first')])

    const result = runMigrations(db, [
      createsTable('0001', 'first'),
      createsTable('0002', 'second'),
    ])

    expect(result).toEqual({ from: '0001', to: '0002', applied: ['0002'] })
  })

  it('stops at an explicit target', () => {
    const db = freshDb()
    const registry = [
      createsTable('0001', 'first'),
      createsTable('0002', 'second'),
      createsTable('0003', 'third'),
    ]

    const result = runMigrations(db, registry, { to: '0002' })

    expect(result.applied).toEqual(['0001', '0002'])
    expect(currentVersion(db)).toBe('0002')
    expect(tableNames(db)).not.toContain('third')
  })

  it('rejects a target that is not in the registry', () => {
    const db = freshDb()
    expect(codeOf(() => runMigrations(db, [createsTable('0001', 'first')], { to: '0009' }))).toBe(
      'DB_MIGRATION_REGISTRY_INVALID',
    )
  })

  it('leaves an empty registry as a database with no version', () => {
    const db = freshDb()

    expect(runMigrations(db, [])).toEqual({ from: null, to: null, applied: [] })
    expect(currentVersion(db)).toBeNull()
    expect(tableNames(db)).toEqual(['schema_migrations'])
  })

  it('rolls a failing migration back completely and stops the run', () => {
    const db = freshDb()
    const registry = [
      createsTable('0001', 'first'),
      throwsHalfWay('0002', 'second'),
      createsTable('0003', 'third'),
    ]

    let thrown: unknown
    try {
      runMigrations(db, registry)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(DbError)
    expect((thrown as DbError).code).toBe('DB_MIGRATION_FAILED')
    expect((thrown as DbError).cause).toBeInstanceOf(Error)
    expect(((thrown as DbError).cause as Error).message).toBe('deliberate failure')

    /* Nothing the failed migration did survives, and the run did not continue. */
    expect(tableNames(db)).toEqual(['first', 'schema_migrations'])
    expect(currentVersion(db)).toBe('0001')
    expect(appliedMigrations(db).map((m) => m.id)).toEqual(['0001'])
  })

  it('resumes from where a failure stopped once the migration is fixed', () => {
    const db = freshDb()
    const broken = [createsTable('0001', 'first'), throwsHalfWay('0002', 'second')]
    expect(codeOf(() => runMigrations(db, broken))).toBe('DB_MIGRATION_FAILED')

    const fixed = [createsTable('0001', 'first'), createsTable('0002', 'second')]
    expect(runMigrations(db, fixed).applied).toEqual(['0002'])
    expect(currentVersion(db)).toBe('0002')
  })

  it('refuses a database written by a newer build', () => {
    const path = tempPath()
    const newer = [createsTable('0001', 'first'), createsTable('0002', 'second')]
    const older = [createsTable('0001', 'first')]

    const db = open(path)
    runMigrations(db, newer)
    closeDatabase(db)

    const olderBuild = open(path)
    expect(codeOf(() => runMigrations(olderBuild, older))).toBe('DB_SCHEMA_TOO_NEW')
    /* And it touched nothing on the way out. */
    expect(currentVersion(olderBuild)).toBe('0002')
    expect(tableNames(olderBuild)).toContain('second')
  })

  it('refuses a database carrying a migration it has never heard of', () => {
    const db = freshDb()
    runMigrations(db, [createsTable('0001', 'first'), createsTable('0005', 'stranger')])

    const registry = [createsTable('0001', 'first'), createsTable('0009', 'ninth')]

    expect(codeOf(() => runMigrations(db, registry))).toBe('DB_SCHEMA_UNKNOWN')
    expect(tableNames(db)).not.toContain('ninth')
  })

  it('refuses before applying anything, not part way through', () => {
    const path = tempPath()
    const db = open(path)
    runMigrations(db, [createsTable('0001', 'first'), createsTable('0007', 'seventh')])
    closeDatabase(db)

    const otherBuild = open(path)
    const registry = [
      createsTable('0001', 'first'),
      createsTable('0002', 'second'),
      createsTable('0009', 'ninth'),
    ]

    expect(codeOf(() => runMigrations(otherBuild, registry))).toBe('DB_SCHEMA_UNKNOWN')
    expect(tableNames(otherBuild)).not.toContain('second')
    expect(appliedMigrations(otherBuild).map((m) => m.id)).toEqual(['0001', '0007'])
  })

  it('runs migrations inside a transaction that a failure undoes atomically', () => {
    const db = freshDb()
    const multiStep: Migration = {
      id: '0001',
      name: 'multi_step',
      up(database) {
        database.exec(`CREATE TABLE kept (id INTEGER PRIMARY KEY) STRICT`)
        database.exec(`INSERT INTO kept (id) VALUES (1)`)
        database.exec(`CREATE TABLE broken (id INTEGER PRIMARY KEY) STRICT`)
        /* Same table name twice: SQLite raises, the transaction unwinds. */
        database.exec(`CREATE TABLE broken (id INTEGER PRIMARY KEY) STRICT`)
      },
    }

    expect(codeOf(() => runMigrations(db, [multiStep]))).toBe('DB_MIGRATION_FAILED')
    expect(tableNames(db)).toEqual(['schema_migrations'])
    expect(currentVersion(db)).toBeNull()
  })
})

describe('rollbackMigrations', () => {
  const registry = [
    createsTable('0001', 'first'),
    createsTable('0002', 'second'),
    createsTable('0003', 'third'),
  ]

  it('reverts newest first, down to the target', () => {
    const db = freshDb()
    runMigrations(db, registry)

    const result = rollbackMigrations(db, registry, { to: '0001' })

    expect(result).toEqual({ from: '0003', to: '0001', reverted: ['0003', '0002'] })
    expect(tableNames(db)).toEqual(['first', 'schema_migrations'])
    expect(appliedMigrations(db).map((m) => m.id)).toEqual(['0001'])
  })

  it('reverts everything when the target is null', () => {
    const db = freshDb()
    runMigrations(db, registry)

    const result = rollbackMigrations(db, registry, { to: null })

    expect(result.reverted).toEqual(['0003', '0002', '0001'])
    expect(currentVersion(db)).toBeNull()
    expect(tableNames(db)).toEqual(['schema_migrations'])
  })

  it('can be re-applied afterwards', () => {
    const db = freshDb()
    runMigrations(db, registry)
    rollbackMigrations(db, registry, { to: null })

    expect(runMigrations(db, registry).applied).toEqual(['0001', '0002', '0003'])
    expect(tableNames(db)).toEqual(['first', 'schema_migrations', 'second', 'third'])
  })

  it('refuses the whole rollback when any step declares no down', () => {
    const db = freshDb()
    const withIrreversible = [
      createsTable('0001', 'first'),
      irreversible('0002', 'second'),
      createsTable('0003', 'third'),
    ]
    runMigrations(db, withIrreversible)

    expect(codeOf(() => rollbackMigrations(db, withIrreversible, { to: null }))).toBe(
      'DB_MIGRATION_IRREVERSIBLE',
    )
    /* 0003 is reversible but sits above 0002, so nothing was reverted at all. */
    expect(tableNames(db)).toEqual(['first', 'schema_migrations', 'second', 'third'])
    expect(currentVersion(db)).toBe('0003')
  })

  it('allows a rollback that stops above an irreversible migration', () => {
    const db = freshDb()
    const withIrreversible = [
      createsTable('0001', 'first'),
      irreversible('0002', 'second'),
      createsTable('0003', 'third'),
    ]
    runMigrations(db, withIrreversible)

    expect(rollbackMigrations(db, withIrreversible, { to: '0002' }).reverted).toEqual(['0003'])
    expect(currentVersion(db)).toBe('0002')
  })

  it('rejects a target that is not applied', () => {
    const db = freshDb()
    runMigrations(db, registry, { to: '0002' })

    expect(codeOf(() => rollbackMigrations(db, registry, { to: '0003' }))).toBe(
      'DB_MIGRATION_REGISTRY_INVALID',
    )
  })

  it('refuses to touch a database written by a newer build', () => {
    const db = freshDb()
    runMigrations(db, registry)

    expect(
      codeOf(() => rollbackMigrations(db, [createsTable('0001', 'first')], { to: null })),
    ).toBe('DB_SCHEMA_TOO_NEW')
    expect(currentVersion(db)).toBe('0003')
  })

  it('undoes a failing down migration and stops', () => {
    const db = freshDb()
    const willFail: Migration = {
      id: '0002',
      name: 'second',
      up(database) {
        database.exec(`CREATE TABLE second (id INTEGER PRIMARY KEY) STRICT`)
      },
      down(database) {
        database.exec(`DROP TABLE second`)
        database.exec(`DROP TABLE does_not_exist`)
      },
    }
    const withFailingDown = [createsTable('0001', 'first'), willFail]
    runMigrations(db, withFailingDown)

    expect(codeOf(() => rollbackMigrations(db, withFailingDown, { to: null }))).toBe(
      'DB_MIGRATION_FAILED',
    )
    expect(tableNames(db)).toEqual(['first', 'schema_migrations', 'second'])
    expect(currentVersion(db)).toBe('0002')
  })
})

describe('currentVersion', () => {
  it('is null before anything has been applied', () => {
    expect(currentVersion(freshDb())).toBeNull()
  })

  it('is the highest applied migration, compared numerically', () => {
    const db = freshDb()
    runMigrations(db, [createsTable('0009', 'ninth'), createsTable('0010', 'tenth')])

    expect(currentVersion(db)).toBe('0010')
  })
})

/*
 * TABLE REBUILDS — the reason foreign keys come off for a migration.
 *
 * SQLite cannot alter or drop a CHECK constraint, so changing one means building a new
 * table, copying the rows, dropping the old one and renaming. The runner used to do that
 * with `defer_foreign_keys = ON` and a comment saying it was enough. It was not: deferring
 * postpones the CHECKING of violations, and does nothing about REFERENTIAL ACTIONS. The
 * implicit `DELETE FROM` inside `DROP TABLE` fires `ON DELETE CASCADE` on every child, the
 * cascade chains to the grandchildren, and `foreign_key_check` then reports nothing wrong
 * — because nothing is wrong. The rows are simply gone.
 *
 * These tests exist because no test in this file could have told the difference. Every
 * migration written so far creates tables; none had rebuilt one with children.
 */
describe('a migration that rebuilds a table with children', () => {
  const rows = (db: SqliteDatabase, table: string): number =>
    db.prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${table}`).get()!.n

  /** Parent, child and grandchild, each cascading from the one above. */
  function family(id: string): Migration {
    return {
      id,
      name: 'family',
      up(db) {
        db.exec(`CREATE TABLE parent (id TEXT PRIMARY KEY, kind TEXT NOT NULL,
          CHECK (kind <> 'forbidden')) STRICT`)
        db.exec(`CREATE TABLE child (id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE) STRICT`)
        db.exec(`CREATE TABLE grandchild (id TEXT PRIMARY KEY,
          child_id TEXT NOT NULL REFERENCES child(id) ON DELETE CASCADE) STRICT`)
        db.prepare(`INSERT INTO parent VALUES ('p-1', 'allowed')`).run()
        db.prepare(`INSERT INTO child VALUES ('c-1', 'p-1')`).run()
        db.prepare(`INSERT INTO grandchild VALUES ('g-1', 'c-1')`).run()
      },
    }
  }

  /** The twelve-step rebuild, relaxing the parent's CHECK. */
  function relaxesTheCheck(id: string): Migration {
    return {
      id,
      name: 'relax',
      up(db) {
        db.exec(`CREATE TABLE parent_new (id TEXT PRIMARY KEY, kind TEXT NOT NULL) STRICT`)
        db.exec(`INSERT INTO parent_new SELECT id, kind FROM parent`)
        db.exec(`DROP TABLE parent`)
        db.exec(`ALTER TABLE parent_new RENAME TO parent`)
      },
      down(db) {
        db.exec(`CREATE TABLE parent_new (id TEXT PRIMARY KEY, kind TEXT NOT NULL,
          CHECK (kind <> 'forbidden')) STRICT`)
        db.exec(`INSERT INTO parent_new SELECT id, kind FROM parent`)
        db.exec(`DROP TABLE parent`)
        db.exec(`ALTER TABLE parent_new RENAME TO parent`)
      },
    }
  }

  it('keeps every child and grandchild row', () => {
    const db = freshDb()
    runMigrations(db, [family('0001'), relaxesTheCheck('0002')])

    expect(rows(db, 'parent')).toBe(1)
    expect(rows(db, 'child')).toBe(1)
    expect(rows(db, 'grandchild')).toBe(1)
  })

  /* The rebuild is pointless if the constraint it was for did not actually change. */
  it('really did relax the constraint', () => {
    const db = freshDb()
    runMigrations(db, [family('0001')])
    expect(() => db.prepare(`INSERT INTO parent VALUES ('p-2', 'forbidden')`).run()).toThrow(
      /CHECK/i,
    )

    runMigrations(db, [family('0001'), relaxesTheCheck('0002')])

    expect(() => db.prepare(`INSERT INTO parent VALUES ('p-2', 'forbidden')`).run()).not.toThrow()
  })

  /*
   * The child's foreign key must still point at the rebuilt table and still cascade. A
   * rebuild that left it dangling would pass every test above — the rows are all there —
   * and fail the first time anybody deleted a parent.
   */
  it('leaves the foreign key live, not merely present', () => {
    const db = freshDb()
    runMigrations(db, [family('0001'), relaxesTheCheck('0002')])

    db.prepare(`DELETE FROM parent WHERE id = 'p-1'`).run()

    expect(rows(db, 'child')).toBe(0)
    expect(rows(db, 'grandchild')).toBe(0)
  })

  it('turns foreign keys back on afterwards', () => {
    const db = freshDb()
    runMigrations(db, [family('0001'), relaxesTheCheck('0002')])

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(() => db.prepare(`INSERT INTO child VALUES ('c-2', 'nobody')`).run()).toThrow(
      /FOREIGN KEY/i,
    )
  })

  /* And back on even when the migration threw, which is the case that would otherwise
   * leave a connection enforcing nothing for the rest of the session. */
  it('turns foreign keys back on after a migration fails', () => {
    const db = freshDb()

    expect(codeOf(() => runMigrations(db, [family('0001'), throwsHalfWay('0002', 'boom')]))).toBe(
      'DB_MIGRATION_FAILED',
    )

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  /*
   * What replaces the enforcement that was switched off. A migration that drops a row the
   * child still points at is caught by `foreign_key_check` INSIDE the transaction, so the
   * whole thing rolls back rather than committing a broken database.
   */
  it('refuses a rebuild that leaves a row pointing at nothing', () => {
    const db = freshDb()
    const losesARow: Migration = {
      id: '0002',
      name: 'loses',
      up(db) {
        db.exec(`CREATE TABLE parent_new (id TEXT PRIMARY KEY, kind TEXT NOT NULL) STRICT`)
        /* Copies everything except the row the child references. */
        db.exec(`INSERT INTO parent_new SELECT id, kind FROM parent WHERE id <> 'p-1'`)
        db.exec(`DROP TABLE parent`)
        db.exec(`ALTER TABLE parent_new RENAME TO parent`)
      },
    }

    expect(codeOf(() => runMigrations(db, [family('0001'), losesARow]))).toBe('DB_MIGRATION_FAILED')

    /* Rolled back whole: the old table, its CHECK and every row are still there. */
    expect(currentVersion(db)).toBe('0001')
    expect(rows(db, 'parent')).toBe(1)
    expect(rows(db, 'child')).toBe(1)
    expect(() => db.prepare(`INSERT INTO parent VALUES ('p-2', 'forbidden')`).run()).toThrow(
      /CHECK/i,
    )
  })

  /*
   * The pragma that makes the rename possible must not be left on. `ALTER TABLE ... RENAME
   * TO` normally rewrites references to the old name across the schema; `legacy_alter_table`
   * turns that off, which a table rebuild needs and a later column rename would be quietly
   * broken by. Migrations set it themselves, so what is checked here is the connection they
   * hand back.
   */
  it('leaves legacy_alter_table off', () => {
    const db = freshDb()
    const rebuilds: Migration = {
      id: '0002',
      name: 'rebuilds',
      up(db) {
        db.pragma('legacy_alter_table = ON')
        try {
          db.exec(`CREATE TABLE parent_new (id TEXT PRIMARY KEY, kind TEXT NOT NULL) STRICT`)
          db.exec(`INSERT INTO parent_new SELECT id, kind FROM parent`)
          db.exec(`DROP TABLE parent`)
          db.exec(`ALTER TABLE parent_new RENAME TO parent`)
        } finally {
          db.pragma('legacy_alter_table = OFF')
        }
      },
    }
    runMigrations(db, [family('0001'), rebuilds])

    expect(db.pragma('legacy_alter_table', { simple: true })).toBe(0)
  })

  /*
   * The reference check guards a rollback as well as a migration. A `down` that drops a
   * row its children still point at is the same failure in the other direction, and it is
   * the direction nobody exercises until the day they need it.
   */
  it('refuses a rollback that leaves a row pointing at nothing', () => {
    const db = freshDb()
    const losesARowOnTheWayBack: Migration = {
      id: '0002',
      name: 'loses-back',
      up(db) {
        db.exec(`ALTER TABLE parent ADD COLUMN note TEXT`)
      },
      down(db) {
        db.exec(`DELETE FROM parent WHERE id = 'p-1'`)
      },
    }
    const registry = [family('0001'), losesARowOnTheWayBack]
    runMigrations(db, registry)

    expect(codeOf(() => rollbackMigrations(db, registry, { to: '0001' }))).toBe(
      'DB_MIGRATION_FAILED',
    )

    /* Rolled back whole: the migration is still applied and the rows are all there. */
    expect(currentVersion(db)).toBe('0002')
    expect(rows(db, 'parent')).toBe(1)
    expect(rows(db, 'child')).toBe(1)
  })

  it('protects a rollback the same way', () => {
    const db = freshDb()
    const registry = [family('0001'), relaxesTheCheck('0002')]
    runMigrations(db, registry)

    rollbackMigrations(db, registry, { to: '0001' })

    expect(rows(db, 'child')).toBe(1)
    expect(rows(db, 'grandchild')).toBe(1)
    expect(() => db.prepare(`INSERT INTO parent VALUES ('p-2', 'forbidden')`).run()).toThrow(
      /CHECK/i,
    )
  })
})
