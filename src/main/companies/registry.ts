/*
 * The company registry.
 *
 * A JSON file at the application data path listing the companies this machine knows
 * about: an id, a display name, where the two files are, and when the company was made
 * and last opened. That is the whole of it.
 *
 * WHAT IS NOT IN HERE, EVER: keys, passphrases, recovery codes, or a single figure from
 * anybody's books. The registry is an index of file locations. Deleting it loses nothing
 * except the list — every company can be added back with `addExisting`, because the
 * company is the pair of files, not the row that points at them (ARCHITECTURE §6.3).
 *
 * IT MUST SURVIVE BEING WRONG. This file is plain text in a folder the user can open, so
 * it will occasionally be hand-edited, truncated by a full disk, or synced badly by a
 * cloud drive. A registry that throws on load would take the whole app down at launch,
 * before the user can reach the one screen that could fix it. So:
 *
 *   - An unreadable file degrades to "no companies" and a stated problem. It never throws.
 *   - An entry that fails validation is dropped; its siblings are kept.
 *   - Nothing is overwritten silently. The first write after a degraded read renames the
 *     old file aside as `companies.json.corrupt-<timestamp>` first, so a user who
 *     hand-edited their list badly still has the original.
 *
 * Writes are atomic: a temporary file, flushed, then renamed over the target.
 */

import type { CompanyAvailability, CompanySummary, Timestamp } from '@shared/dto'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

import { CompanyError } from './errors'
import { displayNameFromFilePath, vaultPathFor } from './paths'

/** One row of the registry. The `CompanySummary` DTO is this plus a live availability. */
export interface CompanyRecord {
  readonly id: string
  readonly displayName: string
  /** Absolute path to the encrypted database file. */
  readonly filePath: string
  /** Absolute path to the sidecar vault. Always `filePath` + `.vault`. */
  readonly vaultPath: string
  readonly createdAt: Timestamp
  readonly lastOpenedAt: Timestamp | null
}

/** What the last read of the registry found. Reported, never thrown. */
export interface RegistryStatus {
  readonly filePath: string
  /** False when the file could not be read, or when entries had to be dropped. */
  readonly isHealthy: boolean
  /** What went wrong, in words a user can act on. Null when healthy. */
  readonly problem: string | null
  /** How many entries were unusable and skipped. */
  readonly droppedEntries: number
}

/** Marker written into the file. A file without it is not a registry. */
export const REGISTRY_FORMAT = 'coffer.companies'

/** Format version this build writes. */
export const REGISTRY_VERSION = 1

const REGISTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/

interface RegistryDocument {
  format: string
  version: number
  companies: CompanyRecord[]
}

export class CompanyRegistry {
  readonly filePath: string

  private lastStatus: RegistryStatus

  constructor(filePath: string) {
    this.filePath = filePath
    this.lastStatus = { filePath, isHealthy: true, problem: null, droppedEntries: 0 }
  }

  /**
   * Every company on file, in the order they were added.
   *
   * Never throws. A registry that cannot be read is an empty registry with a problem
   * recorded against it — see `status()`.
   */
  async read(): Promise<CompanyRecord[]> {
    let text: string
    try {
      const handle = await open(this.filePath, 'r')
      try {
        text = await handle.readFile('utf8')
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (isMissingFile(error)) {
        /* No registry yet is the state of every fresh install. Not a problem. */
        this.lastStatus = this.healthy()
        return []
      }
      this.lastStatus = this.degraded(
        'Coffer could not read its list of companies. Add a company again with ' +
          '"Add an existing company", or restore a backup.',
      )
      return []
    }
    return this.parse(text)
  }

  /** What the last `read()` found. */
  status(): RegistryStatus {
    return this.lastStatus
  }

  /** The record with that id, or null. */
  async find(id: string): Promise<CompanyRecord | null> {
    const records = await this.read()
    return records.find((record) => record.id === id) ?? null
  }

  /** The record pointing at that database file, or null. Paths are compared as given. */
  async findByFilePath(filePath: string): Promise<CompanyRecord | null> {
    const records = await this.read()
    return records.find((record) => samePath(record.filePath, filePath)) ?? null
  }

  /** Append a record. Refuses a duplicate id. */
  async add(record: CompanyRecord): Promise<CompanyRecord> {
    const records = await this.read()
    if (records.some((existing) => existing.id === record.id)) {
      throw new CompanyError('REGISTRY_IO_FAILED', 'That company is already in the list.')
    }
    await this.write([...records, record])
    return record
  }

  /**
   * Apply changes to one record.
   *
   * @throws CompanyError `COMPANY_NOT_FOUND`
   */
  async patch(id: string, changes: Partial<Omit<CompanyRecord, 'id'>>): Promise<CompanyRecord> {
    const records = await this.read()
    const existing = records.find((record) => record.id === id)
    if (existing === undefined) {
      throw notFound()
    }
    const updated: CompanyRecord = { ...existing, ...changes, id: existing.id }
    await this.write(records.map((record) => (record.id === id ? updated : record)))
    return updated
  }

  /**
   * Drop a record from the list. The files it points at are never touched.
   *
   * @throws CompanyError `COMPANY_NOT_FOUND`
   */
  async remove(id: string): Promise<void> {
    const records = await this.read()
    if (!records.some((record) => record.id === id)) {
      throw notFound()
    }
    await this.write(records.filter((record) => record.id !== id))
  }

  // ---- Internals ----------------------------------------------------------

  private parse(text: string): CompanyRecord[] {
    let document: unknown
    try {
      document = JSON.parse(text) as unknown
    } catch {
      this.lastStatus = this.degraded(
        'The list of companies Coffer keeps is not readable. Add your companies again with ' +
          '"Add an existing company" — your books are untouched.',
      )
      return []
    }

    const root = asRecord(document)
    const rawCompanies = root === null ? null : root['companies']
    if (root === null || root['format'] !== REGISTRY_FORMAT || !Array.isArray(rawCompanies)) {
      this.lastStatus = this.degraded(
        'The list of companies Coffer keeps is not in the expected shape. Add your companies ' +
          'again with "Add an existing company" — your books are untouched.',
      )
      return []
    }

    const records: CompanyRecord[] = []
    const seenIds = new Set<string>()
    let dropped = 0
    for (const candidate of rawCompanies) {
      const record = toRecord(candidate)
      if (record === null || seenIds.has(record.id)) {
        dropped += 1
        continue
      }
      seenIds.add(record.id)
      records.push(record)
    }

    this.lastStatus =
      dropped === 0
        ? this.healthy()
        : {
            filePath: this.filePath,
            isHealthy: false,
            problem:
              `${dropped} ${dropped === 1 ? 'entry' : 'entries'} in the list of companies Coffer ` +
              'companies could not be read and were skipped. Add those companies again with ' +
              '"Add an existing company".',
            droppedEntries: dropped,
          }
    return records
  }

  /**
   * Write the list, atomically, preserving anything unreadable that was there before.
   *
   * The quarantine step is the important one: the caller has just read a degraded list,
   * so writing it back would delete whatever could not be parsed. Renaming the old file
   * aside first costs one syscall and keeps the user's data recoverable by hand.
   */
  private async write(records: readonly CompanyRecord[]): Promise<void> {
    if (!this.lastStatus.isHealthy) {
      await this.quarantine()
    }

    const document: RegistryDocument = {
      format: REGISTRY_FORMAT,
      version: REGISTRY_VERSION,
      companies: [...records],
    }
    const payload = `${JSON.stringify(document, null, 2)}\n`
    const temporaryPath = `${this.filePath}.tmp`
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      const handle = await open(temporaryPath, 'w', 0o600)
      try {
        await handle.writeFile(payload, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporaryPath, this.filePath)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw new CompanyError(
        'REGISTRY_IO_FAILED',
        `Coffer could not save its list of companies to ${this.filePath}.`,
        { cause: error },
      )
    }
    this.lastStatus = this.healthy()
  }

  private async quarantine(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    try {
      await rename(this.filePath, `${this.filePath}.corrupt-${stamp}`)
    } catch (error) {
      if (isMissingFile(error)) {
        return
      }
      throw new CompanyError(
        'REGISTRY_IO_FAILED',
        `Coffer could not set aside the damaged list of companies at ${this.filePath}.`,
        { cause: error },
      )
    }
  }

  private healthy(): RegistryStatus {
    return { filePath: this.filePath, isHealthy: true, problem: null, droppedEntries: 0 }
  }

  private degraded(problem: string): RegistryStatus {
    return { filePath: this.filePath, isHealthy: false, problem, droppedEntries: 0 }
  }
}

// ---------------------------------------------------------------------------
//  Availability
// ---------------------------------------------------------------------------

/**
 * Can this company be opened, and if not, why not?
 *
 * The distinction is the whole reason `CompanyAvailability` exists: a missing database is
 * a file that moved, and a missing vault is a set of keys that will never come back
 * except from a backup holding both. They need different words in front of the user, and
 * neither of them is a decryption error.
 */
export async function availabilityOf(record: CompanyRecord): Promise<CompanyAvailability> {
  if (!(await fileExists(record.filePath))) {
    return 'database-missing'
  }
  if (!(await fileExists(record.vaultPath))) {
    return 'vault-missing'
  }
  return 'ok'
}

/** The DTO the renderer sees: a record plus what the filesystem says about it now. */
export function toSummary(
  record: CompanyRecord,
  availability: CompanyAvailability,
): CompanySummary {
  return {
    id: record.id,
    displayName: record.displayName,
    filePath: record.filePath,
    vaultPath: record.vaultPath,
    createdAt: record.createdAt,
    lastOpenedAt: record.lastOpenedAt,
    availability,
  }
}

/** `toSummary`, with the availability looked up. */
export async function describeCompany(record: CompanyRecord): Promise<CompanySummary> {
  return toSummary(record, await availabilityOf(record))
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await stat(filePath)
    return stats.isFile()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
//  Parsing helpers — tolerant where it is safe, strict where it is not
// ---------------------------------------------------------------------------

/**
 * Validate one entry.
 *
 * The id and the database path are load-bearing and must be right; a missing display name
 * or timestamp is repaired from what is there, because dropping a company from the list
 * over a cosmetic field would be the worse failure.
 */
function toRecord(value: unknown): CompanyRecord | null {
  const record = asRecord(value)
  if (record === null) {
    return null
  }

  const id = record['id']
  const filePath = record['filePath']
  if (typeof id !== 'string' || !REGISTRY_ID.test(id)) {
    return null
  }
  if (typeof filePath !== 'string' || filePath.trim() === '' || !isAbsolute(filePath)) {
    return null
  }

  const vaultPath = record['vaultPath']
  const displayName = record['displayName']
  const createdAt = record['createdAt']
  const lastOpenedAt = record['lastOpenedAt']

  return {
    id,
    filePath,
    vaultPath:
      typeof vaultPath === 'string' && vaultPath.trim() !== '' ? vaultPath : vaultPathFor(filePath),
    displayName:
      typeof displayName === 'string' && displayName.trim() !== ''
        ? displayName.trim()
        : displayNameFromFilePath(filePath),
    createdAt: isTimestamp(createdAt) ? createdAt : new Date().toISOString(),
    lastOpenedAt: isTimestamp(lastOpenedAt) ? lastOpenedAt : null,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function isTimestamp(value: unknown): value is Timestamp {
  return typeof value === 'string' && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value))
}

/** Windows and macOS compare paths case-insensitively; Linux does not. */
function samePath(a: string, b: string): boolean {
  return process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase()
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function notFound(): CompanyError {
  return new CompanyError(
    'COMPANY_NOT_FOUND',
    'That company is no longer in the list. Add it again with "Add an existing company".',
  )
}
