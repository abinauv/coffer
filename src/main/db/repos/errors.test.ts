/*
 * The bridge between a trigger and a `RepoError`.
 *
 * Every rule this database enforces in a trigger says which rule it is, by raising its
 * `RepoErrorCode` as the abort message. `repoErrorFrom` reads that back so the caller
 * sees the rule that was broken rather than `SQLITE_CONSTRAINT_TRIGGER`.
 *
 * WHY THIS FILE EXISTS AT ALL. The list `repoErrorFrom` matches against is written by
 * hand, and a migration that adds a trigger has no way of knowing it must be extended.
 * When the two fall out of step nothing fails: the repository checks the same rule first
 * and answers before the trigger ever fires, so every test still passes and the mapping
 * is only wrong on the path it exists for — a concurrent write, or a code path that
 * skipped the check. That is the defence-in-depth blindness this codebase has now hit in
 * four separate batches, and 0007 walked into it again: three triggers raised
 * `SERIES_IN_USE` and nothing mapped it.
 *
 * So the test reads the migrations rather than a list somebody remembered to update.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { RepoError, isRepoError, repoErrorFrom } from './errors'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')

/** Every code named by a `RAISE(ABORT, '...')` anywhere in the migrations. */
function codesRaisedByTriggers(): string[] {
  const found = new Set<string>()
  for (const file of readdirSync(MIGRATIONS_DIR)) {
    if (!file.endsWith('.ts') || file === 'index.ts') continue
    const source = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    for (const match of source.matchAll(/RAISE\(ABORT,\s*'([A-Z_]+)'\)/g)) {
      const code = match[1]
      if (code !== undefined) found.add(code)
    }
  }
  return [...found].sort()
}

describe('repoErrorFrom', () => {
  it('finds the codes the migrations actually raise', () => {
    /* A guard on the scan itself. If the regex stopped matching — a migration formats a
     * RAISE differently, the folder moves — this file would silently assert nothing and
     * report success, which is the failure it was written to prevent. */
    const codes = codesRaisedByTriggers()

    expect(codes.length).toBeGreaterThanOrEqual(10)
    expect(codes).toContain('UNBALANCED_ENTRY')
    expect(codes).toContain('PARTY_REQUIRED')
  })

  /*
   * The rule with teeth. Every code a trigger can raise must map back to itself, because
   * a trigger firing is precisely the case the repository's own check did not catch.
   */
  it('maps every code a trigger raises back to that code', () => {
    for (const code of codesRaisedByTriggers()) {
      const raw = new Error(
        `SqliteError: ${code} --> in trigger somewhere (SQLITE_CONSTRAINT_TRIGGER)`,
      )
      expect(repoErrorFrom(raw, 'ACCOUNT_NOT_FOUND').code).toBe(code)
    }
  })

  it('falls back when the message names no rule at all', () => {
    const failure = repoErrorFrom(new Error('database is locked'), 'ACCOUNT_NOT_FOUND')

    expect(failure.code).toBe('ACCOUNT_NOT_FOUND')
    expect(failure.message).toContain('database is locked')
  })

  it('passes a RepoError straight through rather than rewrapping it', () => {
    const original = new RepoError('PERIOD_CLOSED', 'That month is closed.', { periodId: 'p1' })

    expect(repoErrorFrom(original, 'ACCOUNT_NOT_FOUND')).toBe(original)
  })

  it('keeps the original error as the cause, so a stack survives', () => {
    const raw = new Error('SqliteError: PERIOD_LOCKED')
    const failure = repoErrorFrom(raw, 'ACCOUNT_NOT_FOUND')

    expect(isRepoError(failure)).toBe(true)
    expect(failure.cause).toBe(raw)
  })
})
