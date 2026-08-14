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
