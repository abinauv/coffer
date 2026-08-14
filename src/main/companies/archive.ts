/*
 * A very small ZIP writer and reader.
 *
 * A backup has to be ONE file holding two (ARCHITECTURE §6.3) — the database is useless
 * without its vault, and two files travel apart. That needs a container format, and the
 * choice is between adding a dependency and writing the part of ZIP that a two-file
 * archive uses. This is that part: stored entries, no compression, no encryption, one
 * flat level. About two hundred lines, no supply chain, and the result is a real `.zip`
 * that Explorer, Finder and every file manager on Linux will open — which matters,
 * because a backup a user cannot inspect is a backup they have to take on faith.
 *
 * NO COMPRESSION IS DELIBERATE. The database is SQLCipher output: ciphertext, with no
 * redundancy left for deflate to find. Compressing it would spend CPU on a rounding
 * error's worth of saving. Reading still accepts deflated entries, so an archive
 * repacked by another tool restores.
 *
 * PATH TRAVERSAL. SECURITY.md names a crafted backup archive as a vulnerability class,
 * and the classic form is an entry called `../../autostart/evil`. This reader rejects any
 * name containing a separator, a drive letter or a leading dot, at parse time. There is
 * no option to allow them: a Coffer archive is flat, and nothing here ever joins an
 * archive name onto a path without that check having passed first.
 *
 * NOT SUPPORTED, ON PURPOSE: zip64 (entries or archives above 4 GiB), encrypted entries,
 * multi-disk archives, and directory entries. Each is refused with a clear message rather
 * than half-handled.
 */

import { inflateRawSync } from 'node:zlib'

import { CompanyError } from './errors'

/** One file in an archive. */
export interface ArchiveEntry {
  readonly name: string
  readonly data: Buffer
}

/** Largest entry the 32-bit ZIP fields can describe. */
export const MAX_ENTRY_BYTES = 0xfffffffe

const LOCAL_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50

const LOCAL_HEADER_BYTES = 30
const CENTRAL_HEADER_BYTES = 46
const END_OF_CENTRAL_DIRECTORY_BYTES = 22

/** 2.0: the floor for a reader that understands deflate. */
const VERSION_NEEDED = 20

/** Bit 11 declares the file name is UTF-8. */
const FLAG_UTF8_NAMES = 0x0800

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/** A ZIP comment may be 64 KiB, so the end record can sit that far from the end. */
const MAX_TRAILER_SCAN = END_OF_CENTRAL_DIRECTORY_BYTES + 0xffff

/** More entries than any Coffer archive has a reason to hold. */
const MAX_ENTRIES = 64

const CRC_TABLE = buildCrcTable()

/**
 * Build an archive from entries already in memory.
 *
 * Order is preserved. Put the manifest first: a reader that only wants to know what an
 * archive is should not have to walk past a database to find out.
 */
export function createArchive(entries: readonly ArchiveEntry[], modifiedAt = new Date()): Buffer {
  const { time, date } = dosTimestamp(modifiedAt)
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    assertFlatName(entry.name)
    if (entry.data.length > MAX_ENTRY_BYTES) {
      throw new CompanyError(
        'BACKUP_ARCHIVE_UNSUPPORTED',
        'This company is too large for a single backup archive (the limit is 4 GB per file).',
      )
    }

    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const size = entry.data.length

    const local = Buffer.alloc(LOCAL_HEADER_BYTES + name.length)
    local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0)
    local.writeUInt16LE(VERSION_NEEDED, 4)
    local.writeUInt16LE(FLAG_UTF8_NAMES, 6)
    local.writeUInt16LE(METHOD_STORE, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, LOCAL_HEADER_BYTES)

    const record = Buffer.alloc(CENTRAL_HEADER_BYTES + name.length)
    record.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0)
    record.writeUInt16LE(VERSION_NEEDED, 4)
    record.writeUInt16LE(VERSION_NEEDED, 6)
    record.writeUInt16LE(FLAG_UTF8_NAMES, 8)
    record.writeUInt16LE(METHOD_STORE, 10)
    record.writeUInt16LE(time, 12)
    record.writeUInt16LE(date, 14)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(size, 20)
    record.writeUInt32LE(size, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt16LE(0, 30)
    record.writeUInt16LE(0, 32)
    record.writeUInt16LE(0, 34)
    record.writeUInt16LE(0, 36)
    record.writeUInt32LE(0, 38)
    record.writeUInt32LE(offset, 42)
    name.copy(record, CENTRAL_HEADER_BYTES)

    parts.push(local, entry.data)
    central.push(record)
    offset += local.length + size
  }

  const centralSize = central.reduce((total, record) => total + record.length, 0)
  const trailer = Buffer.alloc(END_OF_CENTRAL_DIRECTORY_BYTES)
  trailer.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0)
  trailer.writeUInt16LE(0, 4)
  trailer.writeUInt16LE(0, 6)
  trailer.writeUInt16LE(entries.length, 8)
  trailer.writeUInt16LE(entries.length, 10)
  trailer.writeUInt32LE(centralSize, 12)
  trailer.writeUInt32LE(offset, 16)
  trailer.writeUInt16LE(0, 20)

  return Buffer.concat([...parts, ...central, trailer])
}

/**
 * Read every entry out of an archive.
 *
 * Each entry's CRC-32 and length are checked against the central directory, so a
 * truncated or edited archive fails here rather than when a restored database refuses
 * to open.
 *
 * @throws CompanyError `BACKUP_ARCHIVE_INVALID` | `BACKUP_ARCHIVE_UNSUPPORTED`
 */
export function readArchive(archive: Buffer): ArchiveEntry[] {
  const trailerOffset = findTrailer(archive)
  const diskNumber = archive.readUInt16LE(trailerOffset + 4)
  const entryCount = archive.readUInt16LE(trailerOffset + 10)
  const centralSize = archive.readUInt32LE(trailerOffset + 12)
  const centralOffset = archive.readUInt32LE(trailerOffset + 16)

  if (diskNumber !== 0) {
    throw unsupported('is split across several volumes')
  }
  if (entryCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw unsupported('uses the zip64 extensions')
  }
  if (entryCount > MAX_ENTRIES) {
    throw invalid('holds more files than a Coffer backup ever contains')
  }
  requireRange(archive, centralOffset, centralSize)

  const entries: ArchiveEntry[] = []
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    requireRange(archive, cursor, CENTRAL_HEADER_BYTES)
    if (archive.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) {
      throw invalid('has a damaged index')
    }

    const flags = archive.readUInt16LE(cursor + 8)
    const method = archive.readUInt16LE(cursor + 10)
    const crc = archive.readUInt32LE(cursor + 16)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const uncompressedSize = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const localOffset = archive.readUInt32LE(cursor + 42)

    if ((flags & 0x0001) !== 0) {
      throw unsupported('is password-protected')
    }
    requireRange(archive, cursor + CENTRAL_HEADER_BYTES, nameLength)
    const name = archive.toString(
      'utf8',
      cursor + CENTRAL_HEADER_BYTES,
      cursor + CENTRAL_HEADER_BYTES + nameLength,
    )
    assertFlatName(name)

    /* The local header repeats the name and may carry different extra data, so the
     * payload offset must be computed from it and not assumed. */
    requireRange(archive, localOffset, LOCAL_HEADER_BYTES)
    if (archive.readUInt32LE(localOffset) !== LOCAL_HEADER_SIGNATURE) {
      throw invalid('has a damaged file header')
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    requireRange(archive, localOffset + LOCAL_HEADER_BYTES, localNameLength)
    const localName = archive.toString(
      'utf8',
      localOffset + LOCAL_HEADER_BYTES,
      localOffset + LOCAL_HEADER_BYTES + localNameLength,
    )
    if (localName !== name) {
      /* The index and the file disagree about what this entry is called. Nothing good
       * produces that, and a reader that trusts one over the other is a reader that can
       * be steered. */
      throw invalid('has a file header that disagrees with its index')
    }
    const dataOffset = localOffset + LOCAL_HEADER_BYTES + localNameLength + localExtraLength
    requireRange(archive, dataOffset, compressedSize)
    const payload = archive.subarray(dataOffset, dataOffset + compressedSize)

    const data = decompress(payload, method, uncompressedSize)
    if (data.length !== uncompressedSize || crc32(data) !== crc) {
      throw invalid('is damaged — one of the files inside it does not match its checksum')
    }

    entries.push({ name, data })
    cursor += CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength
  }

  return entries
}

/** CRC-32, the ZIP variant (reflected, polynomial 0xedb88320). */
export function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * A Coffer archive is flat: names are plain file names and nothing else.
 *
 * @throws CompanyError `BACKUP_ARCHIVE_INVALID`
 */
export function assertFlatName(name: string): void {
  if (
    name === '' ||
    name.length > 128 ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes(':') ||
    name.startsWith('.') ||
    name.includes('\0')
  ) {
    throw invalid('contains a file name Coffer will not write to disk')
  }
}

// ---- Internals ------------------------------------------------------------

function decompress(payload: Buffer, method: number, uncompressedSize: number): Buffer {
  if (method === METHOD_STORE) {
    return Buffer.from(payload)
  }
  if (method === METHOD_DEFLATE) {
    try {
      return inflateRawSync(payload, { maxOutputLength: Math.max(1, uncompressedSize) })
    } catch (error) {
      throw new CompanyError(
        'BACKUP_ARCHIVE_INVALID',
        'That backup archive is damaged and could not be unpacked.',
        { cause: error },
      )
    }
  }
  throw unsupported('was packed in a way this version of Coffer cannot read')
}

function findTrailer(archive: Buffer): number {
  if (archive.length < END_OF_CENTRAL_DIRECTORY_BYTES) {
    throw invalid('is not a Coffer backup')
  }
  const floor = Math.max(0, archive.length - MAX_TRAILER_SCAN)
  for (let offset = archive.length - END_OF_CENTRAL_DIRECTORY_BYTES; offset >= floor; offset -= 1) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset
    }
  }
  throw invalid('is not a Coffer backup, or was cut short while it was being copied')
}

function requireRange(archive: Buffer, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > archive.length) {
    throw invalid('is damaged — it points past its own end')
  }
}

/** MS-DOS date and time, which is what a ZIP header stores. Two-second resolution. */
function dosTimestamp(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getFullYear())
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  }
}

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
}

function invalid(what: string): CompanyError {
  return new CompanyError('BACKUP_ARCHIVE_INVALID', `That file ${what}.`)
}

function unsupported(what: string): CompanyError {
  return new CompanyError(
    'BACKUP_ARCHIVE_UNSUPPORTED',
    `That backup archive ${what}, which this version of Coffer cannot open.`,
  )
}
