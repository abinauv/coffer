/*
 * The typed query builder.
 *
 * Kysely is a type layer over the connection, not a second connection. The handle is
 * opened, keyed and pragma'd by ./connection.ts and passed in here; the dialect uses
 * that exact instance, so there is one file lock, one key application, and one set of
 * pragmas. Anything else would open the file twice.
 *
 * Table types come from ./schema.ts, which grows as migrations land. Migrations
 * themselves deliberately do NOT go through Kysely — they run raw SQL against the
 * connection, because a migration describes the schema as it was at that moment and
 * must not be re-typed every time schema.ts moves on.
 */

import { Kysely, SqliteDialect } from 'kysely'
import type { SqliteDatabase } from './connection'
import type { Database } from './schema'

/** The query builder, typed with the current schema. */
export type CofferDb = Kysely<Database>

/**
 * Wrap an open, keyed connection in a typed query builder.
 *
 * Ownership stays with the caller: the connection was opened by `openDatabase()` and
 * should be closed by `closeDatabase()`. Calling `destroy()` on the returned builder
 * also closes the underlying handle — do one or the other, not both halves of two.
 */
export function createQueryBuilder(connection: SqliteDatabase): CofferDb {
  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: connection }),
  })
}
