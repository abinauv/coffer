/*
 * The migration runner.
 *
 * Migrations are numbered files (`0001_snake_summary.ts`) registered in
 * ./migrations/index.ts. They are ordered by that number, applied exactly once each,
 * and recorded individually in the `schema_migrations` table — one row per migration,
 * not a single version counter, so the file itself says precisely what has run.
 *
 * Rules this runner enforces:
 *
 *   - Each migration runs inside its own transaction. SQLite makes DDL transactional,
 *     so a migration that throws half way leaves no trace. The run then stops: the
 *     migrations that already succeeded stay applied, and the version reflects that.
 *   - A database carrying migrations this build does not know is refused outright.
 *     That is an older build opening a newer company file, and the worst thing it
 *     could do is "helpfully" write to it.
 *   - Registry problems (duplicate or malformed ids) fail before anything is touched.
 *
 * Migrations use raw SQL against the connection rather than Kysely. A migration is a
 * historical record of one schema change; typing it against the current schema.ts
 * would make every later change able to break it.
 */

import type { SqliteDatabase } from './connection'
import { DbError } from './errors'

/** A single, immutable schema change. Never edited once merged (CONVENTIONS §1.5). */
export interface Migration {
  /** Zero-padded number, e.g. '0001'. Defines order and identity. */
  readonly id: string
  /** Short summary, matching the file name: 'accounts', 'journal_entries'. */
  readonly name: string
  /** Apply the change. Runs inside a transaction. */
  up(db: SqliteDatabase): void
  /**
   * Undo the change. Optional — some changes cannot be undone without losing data,
   * and saying so honestly is better than a `down` that silently drops a column.
   * A rollback across a migration without one is refused.
   */
  down?(db: SqliteDatabase): void
}

/** One row of `schema_migrations`. */
export interface AppliedMigration {
  id: string
  name: string
  /** ISO-8601 UTC. */
  appliedAt: string
}

export interface MigrateResult {
  /** Version before the run; null when the database had no migrations at all. */
  from: string | null
  /** Version after the run. */
  to: string | null
  /** Ids applied by this run, in the order they ran. Empty when already up to date. */
  applied: string[]
}

export interface RollbackResult {
  from: string | null
  to: string | null
  /** Ids reverted by this run, newest first. */
  reverted: string[]
}

export interface RunOptions {
  /** Stop after this migration instead of applying everything. */
  to?: string
}

export interface RollbackOptions {
  /** Revert down to (and keeping) this migration. `null` reverts everything. */
  to: string | null
}

const MIGRATIONS_TABLE = 'schema_migrations'
const MIGRATION_ID = /^\d{4,}$/

interface MigrationRow {
  id: string
  name: string
  applied_at: string
}

/**
 * Sort a registry into apply order and reject it if it is malformed.
 *
 * Exported because the registry's own test asserts this holds for the real list — the
 * cheapest place to catch two branches that claimed the same migration number.
 */
export function validateRegistry(migrations: readonly Migration[]): Migration[] {
  const seen = new Map<string, Migration>()
  for (const migration of migrations) {
    if (!MIGRATION_ID.test(migration.id)) {
      throw new DbError(
        'DB_MIGRATION_REGISTRY_INVALID',
        `Migration id '${migration.id}' is not a zero-padded number like '0001'.`,
      )
    }
    if (migration.name.trim() === '') {
      throw new DbError('DB_MIGRATION_REGISTRY_INVALID', `Migration ${migration.id} has no name.`)
    }
    const duplicate = seen.get(migration.id)
    if (duplicate !== undefined) {
      throw new DbError(
        'DB_MIGRATION_REGISTRY_INVALID',
        `Two migrations claim id ${migration.id}: '${duplicate.name}' and '${migration.name}'. ` +
          'Migration numbers are reserved, never chosen ad hoc.',
      )
    }
    seen.set(migration.id, migration)
  }
  return [...migrations].sort((a, b) => compareIds(a.id, b.id))
}

/** Every migration recorded in the database, oldest first. */
export function appliedMigrations(db: SqliteDatabase): AppliedMigration[] {
  ensureMigrationsTable(db)
  const rows = db
    .prepare<[], MigrationRow>(`SELECT id, name, applied_at FROM ${MIGRATIONS_TABLE}`)
    .all()
  return rows
    .map((row) => ({ id: row.id, name: row.name, appliedAt: row.applied_at }))
    .sort((a, b) => compareIds(a.id, b.id))
}

/** The highest applied migration id, or null on a database with none. */
export function currentVersion(db: SqliteDatabase): string | null {
  return appliedMigrations(db).at(-1)?.id ?? null
}

/**
 * Apply every migration the database has not already run, in id order.
 *
 * Refuses to touch a database that carries migrations this build does not know.
 */
export function runMigrations(
  db: SqliteDatabase,
  migrations: readonly Migration[],
  options: RunOptions = {},
): MigrateResult {
  const ordered = validateRegistry(migrations)
  const applied = appliedMigrations(db)
  assertSchemaIsKnown(ordered, applied)

  const target = options.to
  if (target !== undefined && !ordered.some((migration) => migration.id === target)) {
    throw new DbError(
      'DB_MIGRATION_REGISTRY_INVALID',
      `Cannot migrate to '${target}': there is no such migration.`,
    )
  }

  const from = applied.at(-1)?.id ?? null
  const appliedIds = new Set(applied.map((migration) => migration.id))
  const pending = ordered.filter(
    (migration) =>
      !appliedIds.has(migration.id) &&
      (target === undefined || compareIds(migration.id, target) <= 0),
  )

  const justApplied: string[] = []
  for (const migration of pending) {
    applyMigration(db, migration)
    justApplied.push(migration.id)
  }

  return { from, to: currentVersion(db), applied: justApplied }
}

/**
 * Revert applied migrations, newest first, down to `options.to` (which stays applied).
 *
 * The whole range is checked for a `down` before anything is reverted, so a rollback
 * either happens in full or does not start.
 */
export function rollbackMigrations(
  db: SqliteDatabase,
  migrations: readonly Migration[],
  options: RollbackOptions,
): RollbackResult {
  const ordered = validateRegistry(migrations)
  const applied = appliedMigrations(db)
  assertSchemaIsKnown(ordered, applied)

  const target = options.to
  if (target !== null && !applied.some((migration) => migration.id === target)) {
    throw new DbError(
      'DB_MIGRATION_REGISTRY_INVALID',
      `Cannot roll back to '${target}': it is not applied to this database.`,
    )
  }

  const from = applied.at(-1)?.id ?? null
  const byId = new Map(ordered.map((migration) => [migration.id, migration]))
  const toRevert = applied
    .filter((row) => target === null || compareIds(row.id, target) > 0)
    .sort((a, b) => compareIds(b.id, a.id))
    .map((row) => {
      const migration = byId.get(row.id)
      if (migration === undefined) {
        /* Unreachable: assertSchemaIsKnown already rejected unknown ids. */
        throw new DbError(
          'DB_SCHEMA_UNKNOWN',
          `Migration ${row.id} is applied but not in this build.`,
        )
      }
      return migration
    })

  const irreversible = toRevert.filter((migration) => migration.down === undefined)
  if (irreversible.length > 0) {
    throw new DbError(
      'DB_MIGRATION_IRREVERSIBLE',
      `Cannot roll back: ${irreversible
        .map((migration) => `${migration.id} (${migration.name})`)
        .join(', ')} declares no down migration. Restore a backup instead.`,
    )
  }

  const reverted: string[] = []
  for (const migration of toRevert) {
    revertMigration(db, migration)
    reverted.push(migration.id)
  }

  return { from, to: currentVersion(db), reverted }
}

// ---- Internals ------------------------------------------------------------

function ensureMigrationsTable(db: SqliteDatabase): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT`,
  )
}

/**
 * The older-build-opening-a-newer-file guard.
 *
 * Any migration recorded in the database that this build does not have is a refusal.
 * If every such id is beyond what we know, the file simply comes from a newer Coffer;
 * if one sits inside our range, the file is from a different lineage entirely. Either
 * way, writing to it could destroy data this build cannot even describe.
 */
function assertSchemaIsKnown(ordered: Migration[], applied: AppliedMigration[]): void {
  const known = new Set(ordered.map((migration) => migration.id))
  const unknown = applied.filter((row) => !known.has(row.id))
  if (unknown.length === 0) {
    return
  }

  const head = ordered.at(-1)?.id ?? null
  const ids = unknown.map((row) => row.id).join(', ')
  const isNewer = head === null || unknown.every((row) => compareIds(row.id, head) > 0)

  if (isNewer) {
    throw new DbError(
      'DB_SCHEMA_TOO_NEW',
      `This company file was created by a newer version of Coffer (it has migration ${ids}; ` +
        `this build knows up to ${head ?? 'none'}). Update Coffer to open it.`,
    )
  }
  throw new DbError(
    'DB_SCHEMA_UNKNOWN',
    `This company file contains migration ${ids}, which this build of Coffer does not ` +
      'recognise. It was not written by a Coffer release this build can follow.',
  )
}

function applyMigration(db: SqliteDatabase, migration: Migration): void {
  const run = db.transaction(() => {
    /* Table rebuilds inside a migration momentarily break their own references.
     * foreign_keys cannot be toggled inside a transaction; defer_foreign_keys can,
     * and still enforces every constraint at COMMIT. */
    db.pragma('defer_foreign_keys = ON')
    migration.up(db)
    db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (id, name, applied_at) VALUES (?, ?, ?)`).run(
      migration.id,
      migration.name,
      new Date().toISOString(),
    )
  })

  try {
    run()
  } catch (error) {
    throw new DbError(
      'DB_MIGRATION_FAILED',
      `Migration ${migration.id} (${migration.name}) failed and was rolled back; nothing ` +
        `it did was written. The database is still at version ${currentVersion(db) ?? 'none'}.`,
      { cause: error },
    )
  }
}

function revertMigration(db: SqliteDatabase, migration: Migration): void {
  const down = migration.down
  if (down === undefined) {
    throw new DbError(
      'DB_MIGRATION_IRREVERSIBLE',
      `Migration ${migration.id} (${migration.name}) declares no down migration.`,
    )
  }

  const run = db.transaction(() => {
    db.pragma('defer_foreign_keys = ON')
    down(db)
    db.prepare(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`).run(migration.id)
  })

  try {
    run()
  } catch (error) {
    throw new DbError(
      'DB_MIGRATION_FAILED',
      `Rolling back migration ${migration.id} (${migration.name}) failed and was itself ` +
        `undone. The database is still at version ${currentVersion(db) ?? 'none'}.`,
      { cause: error },
    )
  }
}

/** Numeric, so '0010' sorts after '0009' and a five-digit id still works. */
function compareIds(a: string, b: string): number {
  return Number.parseInt(a, 10) - Number.parseInt(b, 10)
}
