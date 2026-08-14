/*
 * The archive tests build ZIPs by hand as well as with `createArchive`, so that the
 * reader is checked against an independent construction rather than only against the
 * inverse of its own writer.
 */

import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import { assertFlatName, createArchive, crc32, readArchive } from './archive'
import { CompanyError } from './errors'

const MANIFEST = Buffer.from('{"format":"coffer.backup"}', 'utf8')
const DATABASE = Buffer.from('SQLite format 3\u0000 and then some bytes', 'binary')

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof CompanyError ? error.code : `unexpected error: ${String(error)}`
  }
  return 'did not throw'
}

/** A ZIP built from first principles, so the reader has something to disagree with. */
function handBuilt(
  entries: ReadonlyArray<{ name: string; data: Buffer; deflate?: boolean }>,
): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const payload = entry.deflate === true ? deflateRawSync(entry.data) : entry.data
    const method = entry.deflate === true ? 8 : 0

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc32(entry.data), 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)

    const record = Buffer.alloc(46 + name.length)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(method, 10)
    record.writeUInt32LE(crc32(entry.data), 16)
    record.writeUInt32LE(payload.length, 20)
    record.writeUInt32LE(entry.data.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(offset, 42)
    name.copy(record, 46)

    locals.push(local, payload)
    central.push(record)
    offset += local.length + payload.length
  }

  const centralSize = central.reduce((total, record) => total + record.length, 0)
  const trailer = Buffer.alloc(22)
  trailer.writeUInt32LE(0x06054b50, 0)
  trailer.writeUInt16LE(entries.length, 8)
  trailer.writeUInt16LE(entries.length, 10)
  trailer.writeUInt32LE(centralSize, 12)
  trailer.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, ...central, trailer])
}

describe('crc32', () => {
  it('agrees with the standard check value', () => {
    /* The value every CRC-32 implementation is checked against. */
    expect(crc32(Buffer.from('123456789', 'ascii'))).toBe(0xcbf43926)
    expect(crc32(Buffer.alloc(0))).toBe(0)
  })
})

describe('createArchive', () => {
  it('round-trips entries, in order and byte for byte', () => {
    const archive = createArchive([
      { name: 'manifest.json', data: MANIFEST },
      { name: 'books.coffer', data: DATABASE },
    ])

    const entries = readArchive(archive)
    expect(entries.map((entry) => entry.name)).toEqual(['manifest.json', 'books.coffer'])
    expect(entries[0]?.data.equals(MANIFEST)).toBe(true)
    expect(entries[1]?.data.equals(DATABASE)).toBe(true)
  })

  it('writes something a ZIP reader recognises', () => {
    const archive = createArchive([{ name: 'a.txt', data: Buffer.from('hello') }])
    expect(archive.readUInt32LE(0)).toBe(0x04034b50)
    expect(archive.subarray(0, 2).toString('ascii')).toBe('PK')
  })

  it('round-trips an empty file', () => {
    const entries = readArchive(createArchive([{ name: 'empty', data: Buffer.alloc(0) }]))
    expect(entries[0]?.data.length).toBe(0)
  })

  it('refuses to write a name that is a path', () => {
    expect(codeOf(() => createArchive([{ name: '../escape', data: MANIFEST }]))).toBe(
      'BACKUP_ARCHIVE_INVALID',
    )
  })
})

describe('readArchive', () => {
  it('reads an archive built by something else, deflated entries included', () => {
    const archive = handBuilt([
      { name: 'manifest.json', data: MANIFEST },
      { name: 'books.coffer', data: DATABASE, deflate: true },
    ])

    const entries = readArchive(archive)
    expect(entries.map((entry) => entry.name)).toEqual(['manifest.json', 'books.coffer'])
    expect(entries[1]?.data.equals(DATABASE)).toBe(true)
  })

  it('refuses an entry that would escape the folder it is restored into', () => {
    /* SECURITY.md names this exact attack. The name is patched in place so the entry
     * stays otherwise valid — this must fail on the name alone. */
    const archive = handBuilt([{ name: 'aa.txt', data: MANIFEST }])
    const tampered = Buffer.from(
      archive.toString('latin1').replaceAll('aa.txt', '../a/b'),
      'latin1',
    )

    expect(codeOf(() => readArchive(tampered))).toBe('BACKUP_ARCHIVE_INVALID')
  })

  it('refuses an absolute Windows path as an entry name', () => {
    const archive = handBuilt([{ name: 'aaaaa.txt', data: MANIFEST }])
    const tampered = Buffer.from(
      archive.toString('latin1').replaceAll('aaaaa.txt', 'C:\\a\\b\\c'),
      'latin1',
    )

    expect(codeOf(() => readArchive(tampered))).toBe('BACKUP_ARCHIVE_INVALID')
  })

  it('detects a flipped byte in an entry', () => {
    const archive = createArchive([{ name: 'books.coffer', data: DATABASE }])
    const flipped = Buffer.from(archive)
    const target = archive.indexOf(DATABASE) + 3
    expect(target).toBeGreaterThan(3)
    flipped[target] = (flipped[target] ?? 0) ^ 0xff

    expect(codeOf(() => readArchive(flipped))).toBe('BACKUP_ARCHIVE_INVALID')
  })

  it('detects a name changed in one header and not the other', () => {
    const archive = createArchive([{ name: 'books.coffer', data: DATABASE }])
    const tampered = Buffer.from(archive)
    /* Only the copy in the local header, which is the one the payload sits behind. */
    tampered.write('hooks.coffer', archive.indexOf('books.coffer'), 'utf8')

    expect(codeOf(() => readArchive(tampered))).toBe('BACKUP_ARCHIVE_INVALID')
  })

  it('refuses a truncated archive', () => {
    const archive = createArchive([{ name: 'books.coffer', data: DATABASE }])

    expect(codeOf(() => readArchive(archive.subarray(0, archive.length - 8)))).toBe(
      'BACKUP_ARCHIVE_INVALID',
    )
    expect(codeOf(() => readArchive(Buffer.alloc(4)))).toBe('BACKUP_ARCHIVE_INVALID')
  })

  it('refuses an archive whose index points past its own end', () => {
    const archive = createArchive([{ name: 'books.coffer', data: DATABASE }])
    const broken = Buffer.from(archive)
    /* The central directory offset, in the end-of-central-directory record. */
    broken.writeUInt32LE(0xff_ff_ff_00, broken.length - 6)

    expect(codeOf(() => readArchive(broken))).toBe('BACKUP_ARCHIVE_INVALID')
  })
})

describe('assertFlatName', () => {
  it('accepts a plain file name and nothing else', () => {
    expect(() => assertFlatName('books.coffer.vault')).not.toThrow()
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'C:file', '.hidden', 'x'.repeat(200)]) {
      expect(codeOf(() => assertFlatName(name))).toBe('BACKUP_ARCHIVE_INVALID')
    }
  })
})
