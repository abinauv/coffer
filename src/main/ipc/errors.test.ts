import { describe, expect, it } from 'vitest'
import { DbError, type DbErrorCode } from '../db/errors'
import { SecurityError } from '../security/errors'
import {
  type ErrorMapper,
  INTERNAL_ERROR_CODE,
  INTERNAL_ERROR_MESSAGE,
  IpcError,
  mapError,
  mapKnownError,
  toAppError,
} from './errors'

const SECRET = 'correct horse battery staple'

describe('toAppError — IpcError', () => {
  it('keeps the code and the message', () => {
    const error = toAppError(new IpcError('INVALID_ARGUMENT', "The value for 'id' must be text."))

    expect(error).toEqual({ code: 'INVALID_ARGUMENT', message: "The value for 'id' must be text." })
  })

  it('carries details through when there are any', () => {
    const error = toAppError(new IpcError('PATH_NOT_ALLOWED', 'Not allowed.', { field: 'path' }))

    expect(error.details).toEqual({ field: 'path' })
  })

  it('omits details entirely when there are none', () => {
    expect(toAppError(new IpcError('PATH_NOT_FOUND', 'Gone.'))).not.toHaveProperty('details')
  })
})

describe('toAppError — SecurityError', () => {
  it('preserves the code so the UI can branch on it', () => {
    const error = toAppError(
      new SecurityError('PASSPHRASE_INVALID', 'That passphrase did not unlock this company.'),
    )

    expect(error.code).toBe('PASSPHRASE_INVALID')
  })

  it('passes the message through — the module guarantees it holds no key material', () => {
    const error = toAppError(new SecurityError('RECOVERY_CODE_ALREADY_USED', 'That code is spent.'))

    expect(error.message).toBe('That code is spent.')
  })
})

describe('toAppError — DbError', () => {
  it('preserves the code', () => {
    const error = toAppError(new DbError('DB_WRONG_KEY', 'anything at all'))

    expect(error.code).toBe('DB_WRONG_KEY')
  })

  it('replaces the message, which interpolates paths and build detail', () => {
    const error = toAppError(
      new DbError(
        'DB_OPEN_FAILED',
        'Could not open the database file at C:\\Users\\ada\\books.coffer.',
      ),
    )

    expect(error.message).not.toContain('C:\\Users\\ada')
    expect(error.message).toContain('drive is connected')
  })

  it('has user-facing text for every code the db layer can raise', () => {
    const codes: DbErrorCode[] = [
      'DB_KEY_INVALID',
      'DB_WRONG_KEY',
      'DB_CORRUPT',
      'DB_OPEN_FAILED',
      'DB_MIGRATION_FAILED',
      'DB_SCHEMA_TOO_NEW',
      'DB_SCHEMA_UNKNOWN',
      'DB_MIGRATION_REGISTRY_INVALID',
      'DB_MIGRATION_IRREVERSIBLE',
    ]

    for (const code of codes) {
      const error = toAppError(new DbError(code, 'internal detail'))
      expect(error.code).toBe(code)
      expect(error.message).not.toBe(INTERNAL_ERROR_MESSAGE)
      expect(error.message.length).toBeGreaterThan(20)
    }
  })
})

describe('toAppError — anything unexpected', () => {
  it('never lets the message reach the renderer', () => {
    const error = toAppError(new Error(`Unbalanced entry for ${SECRET} at /home/ada/.coffer/x.db`))

    expect(error).toEqual({ code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE })
    expect(JSON.stringify(error)).not.toContain(SECRET)
    expect(JSON.stringify(error)).not.toContain('/home/ada')
  })

  it('collapses a Node error whose own `code` looks stable but whose message is not', () => {
    const nodeError = Object.assign(new Error("ENOENT: no such file, open '/home/ada/vault'"), {
      code: 'ENOENT',
      path: '/home/ada/vault',
    })

    const error = toAppError(nodeError)

    expect(error.code).toBe(INTERNAL_ERROR_CODE)
    expect(JSON.stringify(error)).not.toContain('/home/ada')
  })

  it.each([
    ['a thrown string', `boom ${SECRET}`],
    ['a thrown object', { message: SECRET }],
    ['null', null],
    ['undefined', undefined],
  ])('collapses %s', (_label, thrown) => {
    const error = toAppError(thrown)

    expect(error.code).toBe(INTERNAL_ERROR_CODE)
    expect(JSON.stringify(error)).not.toContain(SECRET)
  })

  it('says what to do rather than apologising', () => {
    expect(INTERNAL_ERROR_MESSAGE).not.toMatch(/something went wrong|sorry/i)
    expect(INTERNAL_ERROR_MESSAGE).toContain('log')
  })
})

describe('mapKnownError', () => {
  it.each([
    ['IpcError', new IpcError('INVALID_ARGUMENT', 'no')],
    ['SecurityError', new SecurityError('VAULT_TAMPERED', 'no')],
    ['DbError', new DbError('DB_CORRUPT', 'no')],
  ])('recognises %s', (_label, error) => {
    expect(mapKnownError(error)).not.toBeNull()
  })

  it.each([
    ['a plain Error', new Error('no')],
    ['a TypeError', new TypeError('no')],
    ['a string', 'no'],
    ['null', null],
  ])('does not recognise %s', (_label, error) => {
    expect(mapKnownError(error)).toBeNull()
  })
})

describe('mapError — the extension point', () => {
  /* How `CompanyError` reaches the UI with its code intact, given that nothing under
   * src/main/ipc is allowed to import src/main/companies. */
  class CompanyError extends Error {
    readonly code = 'COMPANY_VAULT_MISSING'
  }

  const companyMapper: ErrorMapper = (cause) =>
    cause instanceof CompanyError ? { code: cause.code, message: 'The vault is missing.' } : null

  it('lets a supplied mapper claim an error this layer does not know', () => {
    expect(mapError(new CompanyError(), [companyMapper])).toEqual({
      code: 'COMPANY_VAULT_MISSING',
      message: 'The vault is missing.',
    })
  })

  it('still returns null when no mapper claims it', () => {
    expect(mapError(new Error('boom'), [companyMapper])).toBeNull()
  })

  it('runs the built-in mappings first, so a mapper cannot weaken them', () => {
    const greedy: ErrorMapper = () => ({ code: 'MINE', message: 'C:\\Users\\ada\\books.coffer' })

    expect(mapError(new DbError('DB_WRONG_KEY', 'internal'), [greedy])?.code).toBe('DB_WRONG_KEY')
  })

  it('tries mappers in order and stops at the first claim', () => {
    const first: ErrorMapper = () => ({ code: 'FIRST', message: 'first' })
    const second: ErrorMapper = () => ({ code: 'SECOND', message: 'second' })

    expect(mapError(new Error('boom'), [first, second])?.code).toBe('FIRST')
  })

  it('ignores a mapper that returns something that is not an AppError', () => {
    const broken: ErrorMapper = () => 'nope' as unknown as null

    expect(mapError(new Error('boom'), [broken])).toBeNull()
  })

  it('falls back to the generic error through toAppError', () => {
    expect(toAppError(new Error('boom'), [companyMapper])).toEqual({
      code: INTERNAL_ERROR_CODE,
      message: INTERNAL_ERROR_MESSAGE,
    })
  })
})
