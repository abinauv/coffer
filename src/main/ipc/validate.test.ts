import { describe, expect, it } from 'vitest'
import { IpcError } from './errors'
import {
  MAX_PATH_LENGTH,
  MAX_STRING_LENGTH,
  expectAbsolutePath,
  expectNonEmptyString,
  expectRecord,
  expectString,
  noArgs,
} from './validate'

const SECRET = 'correct horse battery staple'

function rejection(run: () => unknown): IpcError {
  try {
    run()
  } catch (cause) {
    if (cause instanceof IpcError) return cause
    throw cause
  }
  throw new Error('expected the validator to reject')
}

describe('expectString', () => {
  it('accepts text', () => {
    expect(expectString('acme', 'id')).toBe('acme')
  })

  it('accepts empty text — an empty passphrase has a code of its own', () => {
    expect(expectString('', 'passphrase')).toBe('')
  })

  it.each([
    ['a number', 7],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
    ['an array', []],
    ['a boolean', true],
  ])('rejects %s', (_label, value) => {
    expect(rejection(() => expectString(value, 'id')).code).toBe('INVALID_ARGUMENT')
  })

  it('rejects a string long enough to be an attack', () => {
    const error = rejection(() => expectString('x'.repeat(MAX_STRING_LENGTH + 1), 'displayName'))

    expect(error.code).toBe('INVALID_ARGUMENT')
    expect(error.message).toContain('too long')
  })

  it('names the field and never echoes the value', () => {
    const error = rejection(() => expectString({ passphrase: SECRET }, 'passphrase'))

    expect(error.message).toContain('passphrase')
    expect(error.message).not.toContain(SECRET)
    expect(JSON.stringify(error.details)).not.toContain(SECRET)
  })
})

describe('expectNonEmptyString', () => {
  it('accepts text with content', () => {
    expect(expectNonEmptyString(' acme ', 'id')).toBe(' acme ')
  })

  it.each([
    ['an empty string', ''],
    ['only spaces', '   '],
    ['only a tab', '\t'],
  ])('rejects %s', (_label, value) => {
    expect(rejection(() => expectNonEmptyString(value, 'id')).message).toContain('cannot be empty')
  })
})

describe('expectRecord', () => {
  it('accepts a plain object', () => {
    expect(expectRecord({ id: 'a' }, 'input')).toEqual({ id: 'a' })
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', [{ id: 'a' }]],
    ['a string', '{"id":"a"}'],
    ['a number', 1],
  ])('rejects %s', (_label, value) => {
    expect(rejection(() => expectRecord(value, 'input')).code).toBe('INVALID_ARGUMENT')
  })

  it('does not echo the rejected value', () => {
    const error = rejection(() => expectRecord(`{"passphrase":"${SECRET}"}`, 'input'))

    expect(error.message).not.toContain(SECRET)
  })
})

describe('expectAbsolutePath', () => {
  it.each([
    ['a POSIX path', '/home/ada/books.coffer'],
    ['a Windows drive path', 'C:\\Users\\ada\\books.coffer'],
    ['a Windows drive path with forward slashes', 'C:/Users/ada/books.coffer'],
    ['a UNC path', '\\\\server\\share\\books.coffer'],
  ])('accepts %s', (_label, value) => {
    expect(expectAbsolutePath(value, 'filePath')).toBe(value)
  })

  it.each([
    ['a relative path', 'books.coffer'],
    ['a dot-relative path', './books.coffer'],
    ['a traversal', '../../etc/passwd'],
    ['a bare drive letter', 'C:'],
    ['an empty string', ''],
    ['a number', 42],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(rejection(() => expectAbsolutePath(value, 'filePath')).code).toBe('INVALID_ARGUMENT')
  })

  it('rejects an interior NUL, which truncates the path in every syscall below', () => {
    const error = rejection(() => expectAbsolutePath('/home/ada/books.coffer\0.txt', 'filePath'))

    expect(error.message).toContain('not allowed in a path')
  })

  it('rejects a path long enough to be an attack', () => {
    const path = `/${'a'.repeat(MAX_PATH_LENGTH)}`

    expect(rejection(() => expectAbsolutePath(path, 'filePath')).message).toContain('too long')
  })
})

describe('noArgs', () => {
  it('yields an empty argument list', () => {
    expect(noArgs()).toEqual([])
  })
})
