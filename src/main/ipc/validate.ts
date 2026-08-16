/*
 * Argument validation for IPC handlers.
 *
 * The renderer is untrusted (docs/ARCHITECTURE.md §4). Everything arriving over a
 * channel is `unknown`: a compromised or simply buggy renderer can send a number where
 * a string belongs, a 200 MB string, an object missing half its fields, or nothing at
 * all. These helpers turn `unknown` into a narrowed value or throw an `IpcError`.
 *
 * THEY NEVER ECHO THE VALUE THEY REJECTED. A rejected argument may be a passphrase or a
 * recovery code; the message names the field and describes what was expected, and that
 * is all. `validate.test.ts` asserts it.
 */

import { IpcError } from './errors'

/**
 * Ceiling for any string crossing the boundary. Generous for a passphrase or a display
 * name, small enough that a hostile renderer cannot make main allocate its way to death.
 */
export const MAX_STRING_LENGTH = 8192

/** Ceiling for a filesystem path. Above every real platform limit, well below abuse. */
export const MAX_PATH_LENGTH = 4096

function invalid(field: string, expectation: string): never {
  throw new IpcError('INVALID_ARGUMENT', `The value supplied for '${field}' ${expectation}.`, {
    field,
  })
}

/** Narrow to a string, bounded in length. */
export function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(field, 'must be text')
  if (value.length > MAX_STRING_LENGTH) invalid(field, 'is too long')
  return value
}

/** Narrow to a string with at least one non-whitespace character. */
export function expectNonEmptyString(value: unknown, field: string): string {
  const text = expectString(value, field)
  if (text.trim().length === 0) invalid(field, 'cannot be empty')
  return text
}

/** Narrow to a plain object. Arrays, null and class instances are not one. */
export function expectRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(field, 'must be an object')
  }
  return value as Record<string, unknown>
}

/**
 * Narrow to an absolute filesystem path.
 *
 * Absoluteness is checked without `node:path` so the rule is the same on every platform:
 * a renderer running on Windows must not be able to smuggle a POSIX-looking path past a
 * developer's Mac. Interior NUL bytes are rejected outright — they truncate the path in
 * every syscall that eventually receives it.
 *
 * This says nothing about whether Coffer will *act* on the path. That is a separate
 * question, answered by the allowlist in ./path-access.ts.
 */
export function expectAbsolutePath(value: unknown, field: string): string {
  const path = expectNonEmptyString(value, field)
  if (path.length > MAX_PATH_LENGTH) invalid(field, 'is too long')
  if (path.includes('\0')) invalid(field, 'contains a character that is not allowed in a path')
  if (!isAbsolutePath(path)) invalid(field, 'must be a full path, not a relative one')
  return path
}

function isAbsolutePath(path: string): boolean {
  /* POSIX: leading slash. Windows: a drive letter, or a UNC share. */
  return (
    path.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith('\\\\') ||
    path.startsWith('//')
  )
}

/** A handler that takes no arguments. Anything the renderer sent is ignored. */
export function noArgs(): [] {
  return []
}

// ---- The rest of the primitives the ledger group needs ---------------------

export function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(field, 'must be true or false')
  return value
}

/**
 * Narrow to a safe integer within bounds.
 *
 * Bounded because these reach `LIMIT` and `OFFSET` clauses and a year arithmetic, and a
 * renderer sending 1e9 for a limit should get an argument error rather than a query that
 * takes a minute.
 */
export function expectInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value))
    invalid(field, 'must be a whole number')
  if (value < min || value > max) invalid(field, `must be between ${min} and ${max}`)
  return value
}

/** Narrow to an array, bounded in length. */
export function expectArray(value: unknown, field: string, maxLength: number): unknown[] {
  if (!Array.isArray(value)) invalid(field, 'must be a list')
  if (value.length > maxLength) invalid(field, `must have at most ${maxLength} entries`)
  return value
}

/**
 * A calendar date, 'YYYY-MM-DD'.
 *
 * The shape only. Whether the date exists, and whether the books reach it, are the
 * domain's business and the repository's respectively — both have their own errors, and
 * both say something more useful than 'INVALID_ARGUMENT' would.
 */
export function expectDateString(value: unknown, field: string): string {
  const text = expectNonEmptyString(value, field)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) invalid(field, 'must be a date in YYYY-MM-DD form')
  return text
}

/**
 * A decimal amount as text.
 *
 * Never a number: a JS number with a fractional part cannot represent money exactly, and
 * the whole storage layer is built on that (CONVENTIONS §1). A renderer that sends 12.34
 * as a number is a bug, and this is where it is caught rather than three layers down.
 */
export function expectDecimalString(value: unknown, field: string): string {
  const text = expectNonEmptyString(value, field)
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) invalid(field, 'must be a decimal amount as text')
  return text
}

/**
 * Narrow to one of a closed set of strings.
 *
 * For the unions that cross the boundary as free text — an account type, a period
 * status. The allowed values are named in the message because they are a fixed part of
 * the contract rather than anything the user typed.
 */
export function expectOneOf<const T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  const text = expectNonEmptyString(value, field)
  const match = allowed.find((candidate) => candidate === text)
  if (match === undefined) invalid(field, `must be one of: ${allowed.join(', ')}`)
  return match
}

/** Apply `parse` when the field is present, and pass `undefined` through when it is not. */
export function optional<T>(value: unknown, parse: (value: unknown) => T): T | undefined {
  return value === undefined || value === null ? undefined : parse(value)
}
