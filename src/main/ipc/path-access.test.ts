import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPathAllowlist } from './path-access'

/* Built with `resolve` so the expectations are the same shape on every platform: a
 * drive-rooted path on Windows, a slash-rooted one elsewhere. */
const DATA = resolve('/coffer-data')
const BOOKS = join(DATA, 'acme', 'books.coffer')
const VAULT = `${BOOKS}.vault`
const ELSEWHERE = resolve('/home/ada/.ssh/id_ed25519')

const IS_CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

describe('createPathAllowlist', () => {
  it('allows nothing by default', () => {
    const allowlist = createPathAllowlist()

    expect(allowlist.isAllowed(BOOKS)).toBe(false)
    expect(allowlist.isAllowed(ELSEWHERE)).toBe(false)
  })

  it('allows the seeded roots', () => {
    expect(createPathAllowlist([DATA]).isAllowed(DATA)).toBe(true)
  })

  it('allows a file inside a granted directory', () => {
    expect(createPathAllowlist([DATA]).isAllowed(BOOKS)).toBe(true)
  })

  it('allows a path granted after construction', () => {
    const allowlist = createPathAllowlist()
    expect(allowlist.isAllowed(VAULT)).toBe(false)

    allowlist.allow(VAULT)

    expect(allowlist.isAllowed(VAULT)).toBe(true)
  })

  it('does not allow a granted file to stand in for its directory', () => {
    const allowlist = createPathAllowlist()
    allowlist.allow(BOOKS)

    expect(allowlist.isAllowed(join(DATA, 'acme', 'other.coffer'))).toBe(false)
  })

  it('refuses a path outside every granted root', () => {
    expect(createPathAllowlist([DATA]).isAllowed(ELSEWHERE)).toBe(false)
  })

  it('refuses a sibling that merely shares a prefix', () => {
    const allowlist = createPathAllowlist([join(DATA, 'books')])

    expect(allowlist.isAllowed(join(DATA, 'books-elsewhere', 'secret'))).toBe(false)
  })

  it('normalises traversal before judging it, so `..` cannot climb out', () => {
    const allowlist = createPathAllowlist([DATA])
    const escape = join(DATA, '..', '..', 'home', 'ada', '.ssh', 'id_ed25519')

    expect(allowlist.isAllowed(escape)).toBe(false)
  })

  it('accepts traversal that stays inside a granted root', () => {
    const allowlist = createPathAllowlist([DATA])

    expect(allowlist.isAllowed(join(DATA, 'acme', '..', 'beta', 'books.coffer'))).toBe(true)
  })

  it('ignores an empty path on both sides', () => {
    const allowlist = createPathAllowlist([''])

    expect(allowlist.isAllowed('')).toBe(false)
    expect(allowlist.isAllowed(BOOKS)).toBe(false)
  })

  it.runIf(IS_CASE_INSENSITIVE)('folds case where the filesystem does', () => {
    const allowlist = createPathAllowlist([DATA])

    expect(allowlist.isAllowed(BOOKS.toUpperCase())).toBe(true)
  })

  it.runIf(!IS_CASE_INSENSITIVE)('respects case where the filesystem does', () => {
    const allowlist = createPathAllowlist([DATA])

    expect(allowlist.isAllowed(BOOKS.toUpperCase())).toBe(false)
  })
})
