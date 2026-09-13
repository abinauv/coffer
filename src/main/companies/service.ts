/*
 * The company lifecycle.
 *
 * One method per method in the `companies` group of src/shared/ipc.ts, taking and
 * returning the DTOs in src/shared/dto.ts. Handlers should be a line each: validate,
 * call, wrap in the Result envelope.
 *
 * ---------------------------------------------------------------------------
 *  WHAT THIS MODULE HOLDS
 * ---------------------------------------------------------------------------
 *
 * Exactly one company is open at a time. There is no company id on any other DTO and
 * `close()` takes no argument, because a company is a whole database file rather than a
 * tenant row (ARCHITECTURE §6.3) — "which company" is answered once, at open, and never
 * again by a query.
 *
 * The open session holds a keyed SQLite handle and nothing else. The DEK is zeroed the
 * moment the handle is keyed: SQLCipher has copied it into its own memory by then, and a
 * key sitting in a long-lived JavaScript object is a key in every heap dump for the rest
 * of the session. Closing the handle is what releases SQLCipher's copy.
 *
 * ---------------------------------------------------------------------------
 *  THE ORDERING RULES THAT MATTER
 * ---------------------------------------------------------------------------
 *
 *   create      vault first, then the database, then the registry. Every step records
 *               what it made, and a failure at any point removes all of it. A half-made
 *               company — a vault with no books, or books with no keys — is worse than
 *               no company at all.
 *
 *   recover     the security module persists the spent vault BEFORE it returns the DEK
 *               (see unlockVaultFileWithRecoveryCode). That ordering is the reason a code
 *               that was accepted but not recorded cannot be used twice, so recovery goes
 *               through that function and never re-implements it.
 *
 *   change      re-wraps one key slot. The database is not opened, not rewritten and not
 *   passphrase  re-encrypted; the open session stays valid because the DEK is unchanged.
 *
 *   forget      removes a row from the registry. It never touches a file. The user's
 *               books are theirs, and a list is not a container.
 */

import type {
  BackupInput,
  BackupResult,
  ChangePassphraseInput,
  CompanySummary,
  CreateCompanyInput,
  OpenCompanyInput,
  OpenCompanyResult,
  PassphraseStrength,
  RecoverCompanyInput,
  RestoreInput,
} from '@shared/dto'
import { randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { mkdir, open as openFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { type SqliteDatabase, checkpoint, closeDatabase, openDatabase } from '../db/connection'
import { isDbError } from '../db/errors'
import { createQueryBuilder } from '../db/kysely'
import { runMigrations } from '../db/migrate'
import { taxAccountsFor } from '../db/repos/tax-accounts'
import { setUpBooks } from '../db/repos/bootstrap'
import { DEFAULT_REGIME_ID, findRegime, type TaxRegime } from '../regimes'
import {
  type Argon2Params,
  changeVaultFilePassphrase,
  createVaultFile,
  readVaultFile,
  remainingRecoveryCodes,
  setPassphrase,
  unlockVaultFileWithRecoveryCode,
  unlockWithPassphrase,
  writeVaultFile,
  zeroize,
} from '../security'
import { readBackup, writeBackup } from './backup'
import { CompanyError } from './errors'
import { METADATA_KEYS, writeMetadata } from './metadata'
import { COMPANY_MIGRATIONS } from './migrations'
import { scorePassphrase } from './passphrase'
import {
  REGISTRY_FILE_NAME,
  companyFileName,
  defaultDataDirectory,
  displayNameFromFilePath,
  requireDirectoryPath,
  requireFilePath,
  sidecarPathsFor,
  vaultPathFor,
} from './paths'
import {
  type CompanyRecord,
  CompanyRegistry,
  type RegistryStatus,
  availabilityOf,
  describeCompany,
  fileExists,
  toSummary,
} from './registry'

/** Longest display name kept. Long enough for any real company, short enough to render. */
const MAX_DISPLAY_NAME_LENGTH = 120

export interface CompanyServiceOptions {
  /**
   * Where the registry lives. Defaults to the application data directory, resolved
   * lazily so that constructing a service touches neither Electron nor the disk.
   */
  readonly dataDirectory?: string
  /**
   * Argon2 profiles for new key slots. Production never passes this; tests do, because
   * the real profile costs a quarter of a second per slot by design (see security/argon2.ts).
   */
  readonly kdf?: {
    readonly passphrase?: Argon2Params
    readonly recovery?: Argon2Params
  }
}

interface Session {
  readonly record: CompanyRecord
  readonly database: SqliteDatabase
}

export class CompanyService {
  private readonly options: CompanyServiceOptions

  private registryPromise: Promise<CompanyRegistry> | null = null

  private session: Session | null = null

  /**
   * Operations run one at a time.
   *
   * IPC calls arrive whenever the renderer makes them, and two of these interleaving —
   * a create half way through while a close runs, say — would mean two handles on one
   * file and a registry read that misses a write. The work here is measured in
   * milliseconds apart from the deliberate cost of Argon2, so a queue costs nothing that
   * matters.
   */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: CompanyServiceOptions = {}) {
    this.options = options
  }

  // ---- The IPC surface ----------------------------------------------------

  /** Every company on file, with what the filesystem currently says about each. */
  async list(): Promise<CompanySummary[]> {
    return this.exclusive(async () => {
      const registry = await this.registry()
      const records = await registry.read()
      return Promise.all(records.map((record) => describeCompany(record)))
    })
  }

  /**
   * Create a company: a new DEK, a vault around it, an encrypted database, migrations,
   * and a registry entry. The company is left open.
   *
   * The recovery codes come back here and nowhere else, ever. Show them once.
   */
  async create(input: CreateCompanyInput): Promise<OpenCompanyResult> {
    return this.exclusive(async () => {
      const displayName = requireDisplayName(input.displayName)
      requirePassphrase(input.passphrase, 'Choose a passphrase for this company.')
      const regime = requireRegime(input.regimeId)
      const directoryPath = requireDirectoryPath(input.directoryPath, 'to keep this company in')
      const filePath = join(directoryPath, companyFileName(displayName))
      const vaultPath = vaultPathFor(filePath)

      try {
        await mkdir(directoryPath, { recursive: true })
      } catch (error) {
        throw new CompanyError(
          'COMPANY_IO_FAILED',
          `Coffer could not create the folder ${directoryPath}. Choose another one.`,
          { cause: error },
        )
      }

      if ((await fileExists(filePath)) || (await fileExists(vaultPath))) {
        throw new CompanyError(
          'COMPANY_FILE_EXISTS',
          `There is already a company file called ${companyFileName(displayName)} in that ` +
            'folder. Choose a different name, or a different folder.',
        )
      }

      await this.closeCurrent()

      const created: string[] = []
      let dek: Buffer | null = null
      let database: SqliteDatabase | null = null
      try {
        /* The vault is written first and refuses to overwrite: losing a vault loses the
         * books, so the file that must never be clobbered is created before anything
         * else exists to be confused with it. */
        const vault = await createVaultFile(vaultPath, input.passphrase, { kdf: this.options.kdf })
        created.push(vaultPath)
        dek = vault.dek

        /* Recorded before the open, not after: an open that fails part way can still have
         * left a file behind, and nothing at these paths existed a moment ago. */
        created.push(filePath, ...sidecarPathsFor(filePath))
        database = openDatabase({ filePath, key: dek })
        zeroize(dek)
        dek = null

        runMigrations(database, COMPANY_MIGRATIONS)
        const createdAt = new Date().toISOString()
        writeMetadata(database, METADATA_KEYS.displayName, displayName)
        writeMetadata(database, METADATA_KEYS.createdAt, createdAt)
        writeMetadata(database, METADATA_KEYS.regimeId, regime.id)

        /*
         * The books, in one transaction: the chart of accounts, the first fiscal periods,
         * a numbering series per kind, the starter units and somewhere to keep stock. A
         * company with accounts and no periods refuses every posting with `NO_PERIOD`
         * while looking perfectly finished, and the three seeds after it are the same
         * failure in three other tables — see setUpBooks.
         *
         * BEFORE THE REGISTRY ENTRY, AND THAT ORDER IS THE POINT. Everything after
         * `registry.add` below is assignment and return, so nothing can fail once the
         * company is listed — which is what makes the catch block sufficient without
         * also having to un-list it. Move this call after the add and that stops being
         * true: a company would appear in the list, its files would be deleted by the
         * cleanup, and the user would be left with an entry that cannot be opened.
         *
         * No test covers the reordering, because the ordering is what makes the failure
         * unreachable. It is recorded here instead.
         */
        await setUpBooks(createQueryBuilder(database), {
          rule: regime.fiscalYear,
          /* The chart's tax accounts, one pair per component the regime levies. This
           * is the only place a regime and a chart of accounts meet, and neither knows
           * about the other — the regime says what it levies, `taxAccountsFor` turns
           * that into rows, and nothing in between names a tax. */
          extraAccounts: taxAccountsFor(regime.taxComponents()),
        })

        const registry = await this.registry()
        const record = await registry.add({
          id: randomUUID(),
          displayName,
          filePath,
          vaultPath,
          createdAt,
          lastOpenedAt: createdAt,
        })

        this.session = { record, database }
        return {
          company: toSummary(record, 'ok'),
          recoveryCodes: [...vault.recoveryCodes],
          recoveryCodesRemaining: vault.recoveryCodes.length,
        }
      } catch (error) {
        zeroize(dek)
        if (database !== null) {
          closeQuietly(database)
        }
        await removeQuietly(created)
        throw error
      }
    })
  }

  /**
   * Open a company with its passphrase.
   *
   * Missing files are reported as what they are before any decryption is attempted —
   * `CompanyAvailability` exists so that "your keys are gone, restore a backup" never
   * reaches the user as "wrong passphrase".
   */
  async open(input: OpenCompanyInput): Promise<OpenCompanyResult> {
    return this.exclusive(async () => {
      requirePassphrase(input.passphrase)
      const record = await this.requireRecord(input.id)
      await assertOpenable(record)
      await this.closeCurrent()

      const vault = await readVaultFile(record.vaultPath)
      const dek = await unlockWithPassphrase(vault, input.passphrase)
      let database: SqliteDatabase
      try {
        database = this.openHandle(record, dek)
      } finally {
        zeroize(dek)
      }

      const updated = await this.adopt(record, database)
      return {
        company: toSummary(updated, 'ok'),
        recoveryCodesRemaining: remainingRecoveryCodes(vault),
      }
    })
  }

  /**
   * Open with a recovery code, spending it, and set the passphrase the user will use
   * from now on.
   *
   * A fresh set of codes is NOT issued here: exactly one code is spent and the other four
   * keep working. Re-issuing would invalidate the four codes on the sheet the user is
   * holding, at the one moment they have proved they need it. Offer that as its own
   * deliberate action instead — `replaceVaultFileRecoveryCodes` in the security module.
   */
  async recover(input: RecoverCompanyInput): Promise<OpenCompanyResult> {
    return this.exclusive(async () => {
      requirePassphrase(
        input.newPassphrase,
        'Choose the passphrase you will use from now on. Recovery always sets a new one.',
      )
      const record = await this.requireRecord(input.id)
      await assertOpenable(record)
      await this.closeCurrent()

      /* This spends the code and writes the vault before it returns the DEK. Doing the
       * two steps here instead would open a window in which a code had been accepted and
       * not recorded — a code that works twice. */
      const dek = await unlockVaultFileWithRecoveryCode(record.vaultPath, input.recoveryCode)
      try {
        const spent = await readVaultFile(record.vaultPath)
        const rewrapped = await setPassphrase(spent, dek, input.newPassphrase)
        await writeVaultFile(record.vaultPath, rewrapped)

        const database = this.openHandle(record, dek)
        const updated = await this.adopt(record, database)
        return {
          company: toSummary(updated, 'ok'),
          recoveryCodesRemaining: remainingRecoveryCodes(rewrapped),
        }
      } finally {
        zeroize(dek)
      }
    })
  }

  /** Close the open company. Safe to call when none is open. */
  async close(): Promise<void> {
    return this.exclusive(async () => {
      await this.closeCurrent()
    })
  }

  /**
   * Re-wrap the DEK under a new passphrase.
   *
   * The database is untouched — not re-encrypted, not even opened. Every recovery code
   * still works, and the open session stays valid.
   */
  async changePassphrase(input: ChangePassphraseInput): Promise<void> {
    return this.exclusive(async () => {
      const session = this.requireSession()
      requirePassphrase(input.currentPassphrase, 'Enter your current passphrase.')
      requirePassphrase(input.newPassphrase, 'Choose a new passphrase.')
      await changeVaultFilePassphrase(
        session.record.vaultPath,
        input.currentPassphrase,
        input.newPassphrase,
      )
    })
  }

  /** Write one archive holding the open company's database and its vault. */
  async backup(input: BackupInput): Promise<BackupResult> {
    return this.exclusive(async () => {
      const session = this.requireSession()
      const directoryPath = requireDirectoryPath(input.directoryPath, 'to write the backup into')

      /* In WAL mode the newest committed rows may still be in the sidecar, which is not
       * part of the backup. Fold them into the file first. */
      checkpoint(session.database)

      return writeBackup({
        databaseFilePath: session.record.filePath,
        vaultFilePath: session.record.vaultPath,
        displayName: session.record.displayName,
        directoryPath,
      })
    })
  }

  /**
   * Restore a backup into a directory and add it to the registry.
   *
   * The archive is read and verified in full before a byte is written, and nothing
   * existing is ever overwritten. The company is not opened: restoring proves nothing
   * about who is holding the passphrase.
   */
  async restore(input: RestoreInput): Promise<CompanySummary> {
    return this.exclusive(async () => {
      const archivePath = requireFilePath(input.archivePath, 'a backup archive')
      const directoryPath = requireDirectoryPath(input.directoryPath, 'to restore this company to')
      const backup = await readBackup(archivePath)

      const filePath = join(directoryPath, backup.manifest.database.fileName)
      const vaultPath = vaultPathFor(filePath)
      try {
        await mkdir(directoryPath, { recursive: true })
      } catch (error) {
        throw new CompanyError(
          'COMPANY_IO_FAILED',
          `Coffer could not create the folder ${directoryPath}. Choose another one.`,
          { cause: error },
        )
      }
      if ((await fileExists(filePath)) || (await fileExists(vaultPath))) {
        throw new CompanyError(
          'COMPANY_FILE_EXISTS',
          `${backup.manifest.database.fileName} is already in that folder. Restore into an ` +
            'empty folder — overwriting a company would destroy the books that are there.',
        )
      }

      const written: string[] = []
      try {
        await writeNewFile(filePath, backup.database)
        written.push(filePath)
        await writeNewFile(vaultPath, backup.vault)
        written.push(vaultPath)
      } catch (error) {
        await removeQuietly(written)
        throw error
      }

      const registry = await this.registry()
      const existing = await registry.findByFilePath(filePath)
      const record =
        existing ??
        (await registry.add({
          id: randomUUID(),
          displayName: backup.manifest.displayName,
          filePath,
          vaultPath,
          /* The best date the archive knows. The moment the company was first created is
           * inside the database, which cannot be read without the passphrase. */
          createdAt: backup.manifest.createdAt,
          lastOpenedAt: null,
        }))
      return describeCompany(record)
    })
  }

  /**
   * Add a company file that is already on disk to the registry.
   *
   * A file whose vault is missing is still added, so that the list can say what is wrong
   * with it. Adding the same file twice returns the entry that is already there.
   */
  async addExisting(filePath: string): Promise<CompanySummary> {
    return this.exclusive(async () => {
      const resolved = requireFilePath(filePath, 'a company file')
      if (!(await fileExists(resolved))) {
        throw new CompanyError(
          'COMPANY_DATABASE_MISSING',
          `There is no file at ${resolved}. If it is on a drive that is not connected, ` +
            'connect it and try again.',
        )
      }

      const registry = await this.registry()
      const existing = await registry.findByFilePath(resolved)
      if (existing !== null) {
        return describeCompany(existing)
      }

      const record = await registry.add({
        id: randomUUID(),
        displayName: displayNameFromFilePath(resolved),
        filePath: resolved,
        vaultPath: vaultPathFor(resolved),
        createdAt: await fileCreatedAt(resolved),
        lastOpenedAt: null,
      })
      return describeCompany(record)
    })
  }

  /**
   * Remove a company from the list.
   *
   * THIS DELETES NOTHING. The database and its vault stay exactly where they are; the
   * company can be added back with `addExisting`. Deleting a user's books is not an
   * action this application performs.
   */
  async forget(id: string): Promise<void> {
    return this.exclusive(async () => {
      const registry = await this.registry()
      const record = await registry.find(id)
      if (record === null) {
        throw notFound()
      }
      if (this.session?.record.id === id) {
        await this.closeCurrent()
      }
      await registry.remove(id)
    })
  }

  /**
   * Change the name shown in the list.
   *
   * The file on disk keeps the name it was created with. Renaming an open database is a
   * good way to lose one, and the name in the list is the one the user reads.
   */
  async rename(id: string, displayName: string): Promise<CompanySummary> {
    return this.exclusive(async () => {
      const name = requireDisplayName(displayName)
      const registry = await this.registry()
      const updated = await registry.patch(id, { displayName: name })
      const session = this.session
      if (session !== null && session.record.id === id) {
        this.session = { record: updated, database: session.database }
        writeMetadata(session.database, METADATA_KEYS.displayName, name)
      }
      return describeCompany(updated)
    })
  }

  /**
   * Advisory strength for the passphrase field.
   *
   * Synchronous, cheap, and consulted by nothing in this module. `create` and
   * `changePassphrase` never look at it — see ARCHITECTURE §6.3.1 for why refusing a
   * passphrase is not on the table.
   */
  checkPassphrase(passphrase: string): PassphraseStrength {
    return scorePassphrase(passphrase)
  }

  // ---- Beyond the IPC contract, for the rest of the main process ----------

  /** The open company, or null. */
  currentCompany(): CompanySummary | null {
    return this.session === null ? null : toSummary(this.session.record, 'ok')
  }

  /** The open company's database handle, or null. Repositories take this. */
  currentDatabase(): SqliteDatabase | null {
    return this.session?.database ?? null
  }

  /**
   * The open company's database handle.
   *
   * @throws CompanyError `NO_COMPANY_OPEN`
   */
  requireDatabase(): SqliteDatabase {
    return this.requireSession().database
  }

  /**
   * What the last read of the registry found.
   *
   * A registry that cannot be read degrades to an empty list rather than an exception,
   * so this is where the reason lives. Worth logging at startup, and worth showing on
   * the company-picker screen.
   */
  async registryStatus(): Promise<RegistryStatus> {
    const registry = await this.registry()
    await registry.read()
    return registry.status()
  }

  /** Where the registry file is. Resolves the application data directory if it must. */
  async registryFilePath(): Promise<string> {
    return (await this.registry()).filePath
  }

  // ---- Internals ----------------------------------------------------------

  private async registry(): Promise<CompanyRegistry> {
    if (this.registryPromise === null) {
      this.registryPromise = this.resolveRegistry().catch((error: unknown) => {
        /* A failure to resolve the data directory must not be cached: the next call
         * should try again rather than inherit a permanently rejected promise. */
        this.registryPromise = null
        throw error
      })
    }
    return this.registryPromise
  }

  private async resolveRegistry(): Promise<CompanyRegistry> {
    const directory = this.options.dataDirectory ?? (await defaultDataDirectory())
    return new CompanyRegistry(join(directory, REGISTRY_FILE_NAME))
  }

  /** Open the database with a DEK the caller owns and zeroes, and bring it up to date. */
  private openHandle(record: CompanyRecord, dek: Buffer): SqliteDatabase {
    let database: SqliteDatabase
    try {
      database = openDatabase({ filePath: record.filePath, key: dek, mustExist: true })
    } catch (error) {
      if (isDbError(error) && error.code === 'DB_WRONG_KEY') {
        /* The vault opened, so the passphrase was right; the key it holds does not fit
         * this database. The two files beside each other belong to different companies. */
        throw new CompanyError(
          'COMPANY_KEYS_MISMATCHED',
          `The keys beside ${record.filePath} do not open it. The database and the .vault ` +
            'file next to it are from different companies — restore a backup holding both.',
          { cause: error },
        )
      }
      throw error
    }

    try {
      runMigrations(database, COMPANY_MIGRATIONS)
    } catch (error) {
      closeQuietly(database)
      throw error
    }
    return database
  }

  /** Record the open, take ownership of the handle, and hand back the updated record. */
  private async adopt(record: CompanyRecord, database: SqliteDatabase): Promise<CompanyRecord> {
    try {
      const registry = await this.registry()
      const updated = await registry.patch(record.id, { lastOpenedAt: new Date().toISOString() })
      this.session = { record: updated, database }
      return updated
    } catch (error) {
      closeQuietly(database)
      throw error
    }
  }

  private async requireRecord(id: string): Promise<CompanyRecord> {
    const registry = await this.registry()
    const record = await registry.find(id)
    if (record === null) {
      throw notFound()
    }
    return record
  }

  private requireSession(): Session {
    if (this.session === null) {
      throw new CompanyError('NO_COMPANY_OPEN', 'Open a company first.')
    }
    return this.session
  }

  /**
   * Close the handle and forget the session.
   *
   * The session is cleared first, so a handle that refuses to close still leaves the
   * service in a state where another company can be opened. A clean close checkpoints
   * the write-ahead log and releases SQLCipher's copy of the key.
   */
  private async closeCurrent(): Promise<void> {
    const session = this.session
    this.session = null
    if (session === null) {
      return
    }
    try {
      closeDatabase(session.database)
    } catch (error) {
      throw new CompanyError(
        'COMPANY_IO_FAILED',
        `Coffer could not close ${session.record.displayName} cleanly. Nothing was lost, but ` +
          'close any other program using the file before opening it again.',
        { cause: error },
      )
    }
  }

  /** Run operations one at a time, whatever the previous one did. */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

/** A service using the default application data directory. */
export function createCompanyService(options: CompanyServiceOptions = {}): CompanyService {
  return new CompanyService(options)
}

// ---- Free functions -------------------------------------------------------

/**
 * Why a company cannot be opened, as an error the user can act on.
 *
 * @throws CompanyError `COMPANY_DATABASE_MISSING` | `COMPANY_VAULT_MISSING`
 */
async function assertOpenable(record: CompanyRecord): Promise<void> {
  const availability = await availabilityOf(record)
  if (availability === 'database-missing') {
    throw new CompanyError(
      'COMPANY_DATABASE_MISSING',
      `Coffer cannot find ${record.filePath}. If the file moved, add it again with "Add an ` +
        'existing company"; if it is on a drive that is not connected, connect it.',
    )
  }
  if (availability === 'vault-missing') {
    throw new CompanyError(
      'COMPANY_VAULT_MISSING',
      `The keys for this company are missing: there is no ${record.vaultPath} beside the ` +
        'database. Without them the books cannot be decrypted by anyone, including Coffer. ' +
        'Restore a backup, which holds both files.',
    )
  }
}

function requireDisplayName(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CompanyError('COMPANY_NAME_REQUIRED', 'Give this company a name.')
  }
  return value.trim().slice(0, MAX_DISPLAY_NAME_LENGTH)
}

/**
 * The regime these books will follow.
 *
 * Refused rather than defaulted when the id is unknown. Silently falling back would set
 * a company up on the wrong fiscal year, and the periods generated from it are on disk
 * before anybody notices.
 */
function requireRegime(id: string | undefined): TaxRegime {
  const regime = findRegime(id ?? DEFAULT_REGIME_ID)
  if (regime === undefined) {
    throw new CompanyError(
      'COMPANY_REGIME_UNKNOWN',
      `Coffer has no tax regime called ${JSON.stringify(id)}. This build may be older than ` +
        'the one that company was made with.',
    )
  }
  return regime
}

/**
 * A passphrase must contain something. That is the only rule — strength is advisory and
 * lives in ./passphrase.ts.
 */
function requirePassphrase(
  value: string,
  message = 'Enter the passphrase for this company.',
): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CompanyError('PASSPHRASE_REQUIRED', message)
  }
}

/** Write a file that must not already exist, and flush it. */
async function writeNewFile(filePath: string, data: Buffer): Promise<void> {
  const handle = await createNewFile(filePath)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } catch (error) {
    throw new CompanyError(
      'COMPANY_IO_FAILED',
      `Coffer could not finish writing ${filePath}. The disk may be full.`,
      { cause: error },
    )
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function createNewFile(filePath: string): Promise<FileHandle> {
  try {
    return await openFile(filePath, 'wx', 0o600)
  } catch (error) {
    throw new CompanyError('COMPANY_IO_FAILED', `Coffer could not write ${filePath}.`, {
      cause: error,
    })
  }
}

async function fileCreatedAt(filePath: string): Promise<string> {
  try {
    const stats = await stat(filePath)
    const created = stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs
    return new Date(created).toISOString()
  } catch {
    return new Date().toISOString()
  }
}

async function removeQuietly(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    await rm(path, { force: true, maxRetries: 3 }).catch(() => undefined)
  }
}

function closeQuietly(database: SqliteDatabase): void {
  try {
    closeDatabase(database)
  } catch {
    /* Already unwinding; a close failure would only replace the real error. */
  }
}

function notFound(): CompanyError {
  return new CompanyError(
    'COMPANY_NOT_FOUND',
    'That company is not in the list any more. Add it again with "Add an existing company".',
  )
}
