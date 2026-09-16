/*
 * Backup and restore.
 *
 * ONE ARCHIVE, BOTH FILES. A company is a SQLCipher database and the vault holding its
 * wrapped keys (ARCHITECTURE §6.3). Copying the database alone produces a file nobody
 * will ever open again — not the user, not us, not a court-appointed accountant. So the
 * only artefact Coffer calls a backup is an archive carrying the pair, and this module
 * refuses to write one that is missing either half.
 *
 * The archive holds three entries:
 *
 *     manifest.json          what this is, when it was made, and the SHA-256 of each file
 *     Acme-Traders.coffer.vault
 *     Acme-Traders.coffer
 *
 * The manifest exists so restore knows which entry is which without guessing from names,
 * and so a damaged archive is detected before anything is written to disk rather than
 * after. The hashes are checked on the way in and on the way out.
 *
 * CHECKPOINT FIRST. In WAL mode the newest committed rows may still be in the `-wal`
 * sidecar, which is not in the archive. The caller checkpoints the open database before
 * calling here — `checkpoint()` in src/main/db/connection.ts exists for this.
 */

import type { Timestamp } from '@shared/dto'
import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { createArchive, readArchive } from './archive'
import { CompanyError } from './errors'
import { fileNameSlug, vaultPathFor } from './paths'

/** Marker in the manifest. A file without it is not a Coffer backup. */
export const BACKUP_FORMAT = 'coffer.backup'

/** Manifest version this build writes. */
export const BACKUP_VERSION = 1

/**
 * Extension of a backup archive.
 *
 * It ends in `.zip` because it is one, and because a user who wants to check that their
 * backup contains what it claims should be able to double-click it. The middle part says
 * whose it is.
 */
export const BACKUP_FILE_SUFFIX = '.coffer-backup.zip'

/** The manifest entry, first in the archive so a reader finds it immediately. */
export const MANIFEST_ENTRY_NAME = 'manifest.json'

/** How many name collisions to work around before giving up. */
const MAX_NAME_ATTEMPTS = 100

/** One of the two files in a backup. */
export interface BackupFileEntry {
  /** Name inside the archive, and the name restored on disk. Never a path. */
  readonly fileName: string
  readonly sizeBytes: number
  /** Lowercase hex SHA-256 of the file as it was archived. */
  readonly sha256: string
}

/** The archive's own description of itself. Carries no key material. */
export interface BackupManifest {
  readonly format: string
  readonly version: number
  readonly createdAt: Timestamp
  /** The company's display name when the backup was taken. Advisory. */
  readonly displayName: string
  readonly database: BackupFileEntry
  readonly vault: BackupFileEntry
}

export interface WriteBackupOptions {
  readonly databaseFilePath: string
  readonly vaultFilePath: string
  readonly displayName: string
  /** Directory to write the archive into. Created if it does not exist. */
  readonly directoryPath: string
  /** Overridable so a test can assert the name. Defaults to now. */
  readonly now?: Date
}

/** An archive that has been read and verified, ready to be written out. */
export interface OpenedBackup {
  readonly manifest: BackupManifest
  readonly database: Buffer
  readonly vault: Buffer
}

/**
 * Write one archive holding the database and its vault.
 *
 * @throws CompanyError `COMPANY_DATABASE_MISSING` | `COMPANY_VAULT_MISSING` | `COMPANY_IO_FAILED`
 */
/**
 * What writing an archive produced.
 *
 * The transport's `BackupResult` is this plus the company as it now stands, which this
 * module cannot know: it writes files and has never heard of the registry. The service
 * puts the two together.
 */
export interface WrittenArchive {
  archivePath: string
  sizeBytes: number
  createdAt: Timestamp
}

export async function writeBackup(options: WriteBackupOptions): Promise<WrittenArchive> {
  const when = options.now ?? new Date()
  const database = await readCompanyFile(
    options.databaseFilePath,
    'COMPANY_DATABASE_MISSING',
    'The database file for this company could not be read, so there is nothing to back up.',
  )
  const vault = await readCompanyFile(
    options.vaultFilePath,
    'COMPANY_VAULT_MISSING',
    'The keys for this company are missing, and a backup without them could never be ' +
      'restored. Find the .vault file that belongs beside the database before backing up.',
  )

  const databaseFileName = baseName(options.databaseFilePath)
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: when.toISOString(),
    displayName: options.displayName,
    database: describeFile(databaseFileName, database),
    vault: describeFile(vaultPathFor(databaseFileName), vault),
  }

  const archive = createArchive(
    [
      { name: MANIFEST_ENTRY_NAME, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
      { name: manifest.vault.fileName, data: vault },
      { name: manifest.database.fileName, data: database },
    ],
    when,
  )

  const archivePath = await writeUnique(
    options.directoryPath,
    `${fileNameSlug(options.displayName)}-${localStamp(when)}`,
    archive,
  )

  return {
    archivePath,
    sizeBytes: archive.length,
    createdAt: manifest.createdAt,
  }
}

/**
 * Read an archive and check it against its own manifest.
 *
 * Nothing is written to disk here. Restore reads first, verifies, and only then decides
 * where files go — an archive that fails any check must not have left a half-restored
 * company behind.
 *
 * @throws CompanyError `BACKUP_ARCHIVE_INVALID` | `BACKUP_ARCHIVE_UNSUPPORTED` | `COMPANY_IO_FAILED`
 */
export async function readBackup(archivePath: string): Promise<OpenedBackup> {
  let bytes: Buffer
  try {
    bytes = await readFile(archivePath)
  } catch (error) {
    throw new CompanyError('COMPANY_IO_FAILED', `Coffer could not read ${archivePath}.`, {
      cause: error,
    })
  }

  const entries = new Map(readArchive(bytes).map((entry) => [entry.name, entry.data]))
  const manifestBytes = entries.get(MANIFEST_ENTRY_NAME)
  if (manifestBytes === undefined) {
    throw new CompanyError(
      'BACKUP_ARCHIVE_INVALID',
      'That file is not a Coffer backup: it has no manifest.',
    )
  }

  const manifest = parseManifest(manifestBytes)
  const database = requireEntry(entries, manifest.database)
  const vault = requireEntry(entries, manifest.vault)

  if (manifest.vault.fileName !== vaultPathFor(manifest.database.fileName)) {
    throw new CompanyError(
      'BACKUP_ARCHIVE_INVALID',
      'That backup names its key file inconsistently and cannot be restored safely.',
    )
  }

  return { manifest, database, vault }
}

// ---- Internals ------------------------------------------------------------

function describeFile(fileName: string, data: Buffer): BackupFileEntry {
  return {
    fileName,
    sizeBytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  }
}

function requireEntry(entries: Map<string, Buffer>, expected: BackupFileEntry): Buffer {
  const data = entries.get(expected.fileName)
  if (data === undefined) {
    throw new CompanyError(
      'BACKUP_ARCHIVE_INVALID',
      'That backup is incomplete — one of the two files it should hold is not in it.',
    )
  }
  const actual = createHash('sha256').update(data).digest('hex')
  if (data.length !== expected.sizeBytes || actual !== expected.sha256) {
    throw new CompanyError(
      'BACKUP_ARCHIVE_INVALID',
      'That backup is damaged: what is inside it does not match what it says should be. ' +
        'Use an older backup.',
    )
  }
  return data
}

function parseManifest(bytes: Buffer): BackupManifest {
  let document: unknown
  try {
    document = JSON.parse(bytes.toString('utf8')) as unknown
  } catch (error) {
    throw new CompanyError('BACKUP_ARCHIVE_INVALID', 'That backup has an unreadable manifest.', {
      cause: error,
    })
  }

  const record = asRecord(document)
  if (record === null || record['format'] !== BACKUP_FORMAT) {
    throw new CompanyError('BACKUP_ARCHIVE_INVALID', 'That file is not a Coffer backup.')
  }
  const version = record['version']
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new CompanyError(
      'BACKUP_ARCHIVE_INVALID',
      'That backup does not say which format it uses.',
    )
  }
  if (version > BACKUP_VERSION) {
    throw new CompanyError(
      'BACKUP_ARCHIVE_UNSUPPORTED',
      'That backup was written by a newer version of Coffer. Update Coffer to restore it.',
    )
  }

  const createdAt = record['createdAt']
  const displayName = record['displayName']
  return {
    format: BACKUP_FORMAT,
    version,
    createdAt: typeof createdAt === 'string' ? createdAt : new Date(0).toISOString(),
    displayName:
      typeof displayName === 'string' && displayName.trim() !== '' ? displayName.trim() : 'Company',
    database: parseFileEntry(record['database']),
    vault: parseFileEntry(record['vault']),
  }
}

function parseFileEntry(value: unknown): BackupFileEntry {
  const record = asRecord(value)
  const fileName = record?.['fileName']
  const sizeBytes = record?.['sizeBytes']
  const sha256 = record?.['sha256']
  if (
    typeof fileName !== 'string' ||
    typeof sizeBytes !== 'number' ||
    !Number.isInteger(sizeBytes) ||
    sizeBytes < 0 ||
    typeof sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(sha256)
  ) {
    throw new CompanyError(
      'BACKUP_ARCHIVE_INVALID',
      'That backup does not describe its contents properly and cannot be trusted.',
    )
  }
  return { fileName, sizeBytes, sha256 }
}

async function readCompanyFile(
  filePath: string,
  code: 'COMPANY_DATABASE_MISSING' | 'COMPANY_VAULT_MISSING',
  message: string,
): Promise<Buffer> {
  try {
    return await readFile(filePath)
  } catch (error) {
    throw new CompanyError(code, message, { cause: error })
  }
}

/**
 * Write the archive under a name nothing else has.
 *
 * A backup never overwrites a backup. Two in the same minute get `-2`, `-3`, and the
 * exclusive-create flag is what makes that a guarantee rather than a check-then-write
 * race.
 */
async function writeUnique(
  directoryPath: string,
  baseName_: string,
  data: Buffer,
): Promise<string> {
  try {
    await mkdir(directoryPath, { recursive: true })
  } catch (error) {
    throw new CompanyError(
      'COMPANY_IO_FAILED',
      `Coffer could not write to ${directoryPath}. Choose another folder.`,
      { cause: error },
    )
  }

  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const suffix = attempt === 1 ? '' : `-${attempt}`
    const archivePath = join(directoryPath, `${baseName_}${suffix}${BACKUP_FILE_SUFFIX}`)
    const handle = await openExclusive(archivePath, directoryPath)
    if (handle === null) {
      continue
    }
    try {
      await handle.writeFile(data)
      await handle.sync()
      return archivePath
    } catch (error) {
      await rm(archivePath, { force: true }).catch(() => undefined)
      throw new CompanyError(
        'COMPANY_IO_FAILED',
        `Coffer could not finish writing the backup to ${directoryPath}. The disk may be full.`,
        { cause: error },
      )
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  throw new CompanyError(
    'COMPANY_IO_FAILED',
    `Coffer could not find an unused name for a backup in ${directoryPath}.`,
  )
}

/** Open for exclusive creation. Null when something is already there. */
async function openExclusive(
  archivePath: string,
  directoryPath: string,
): Promise<FileHandle | null> {
  try {
    return await open(archivePath, 'wx', 0o600)
  } catch (error) {
    if (isExisting(error)) {
      return null
    }
    throw new CompanyError(
      'COMPANY_IO_FAILED',
      `Coffer could not write a backup to ${directoryPath}. Choose another folder.`,
      { cause: error },
    )
  }
}

/** Local time, to the minute: what a person means by "the one I took this morning". */
function localStamp(when: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `-${pad(when.getHours())}${pad(when.getMinutes())}`
  )
}

function baseName(filePath: string): string {
  const separator = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return separator === -1 ? filePath : filePath.slice(separator + 1)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function isExisting(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  )
}
