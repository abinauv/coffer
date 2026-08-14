/*
 * The migration list a company database is brought up to.
 *
 * WHY THIS IS NOT SIMPLY `MIGRATIONS`. src/main/db/migrations/index.ts is the registry,
 * and it is where 0001 belongs. It was frozen before this batch started (CONVENTIONS §8:
 * contracts are frozen, own your paths), so this module composes the list instead of
 * editing a file it does not own.
 *
 * The composition is written to survive its own fix: once 0001 is registered in
 * index.ts, it arrives through `MIGRATIONS` and the append below finds it already there
 * and does nothing. Nothing has to change here, and no database sees a migration twice.
 */

import type { Migration } from '../db/migrate'
import { MIGRATIONS } from '../db/migrations'
import { m0001 } from '../db/migrations/0001_app_metadata'

/** Every migration a company file must have run, in order. */
export const COMPANY_MIGRATIONS: readonly Migration[] = withMigration(MIGRATIONS, m0001)

function withMigration(registry: readonly Migration[], migration: Migration): readonly Migration[] {
  if (registry.some((existing) => existing.id === migration.id)) {
    return registry
  }
  return [...registry, migration].sort(
    (a, b) => Number.parseInt(a.id, 10) - Number.parseInt(b.id, 10),
  )
}
