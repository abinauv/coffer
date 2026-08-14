/*
 * The companies module's public surface.
 *
 * A company is an encrypted SQLite database plus a sidecar vault holding its wrapped
 * keys (ARCHITECTURE §6.3). This module owns the pair: where they live, how they are
 * made, opened, backed up and forgotten, and the small registry that lists them.
 *
 * It builds on two finished modules and reimplements neither: `src/main/security` for
 * every key operation, `src/main/db` for every file operation. There is no key handling
 * here beyond passing a DEK from one to the other and zeroing it.
 *
 * ---------------------------------------------------------------------------
 *  FOR THE IPC LAYER
 * ---------------------------------------------------------------------------
 *
 * `companies` is a ready-made service on the default application data directory. Each
 * method matches one method of the `companies` group in src/shared/ipc.ts and takes and
 * returns the DTOs from src/shared/dto.ts, so a handler is:
 *
 *     ipcMain.handle('companies:open', async (_event, input: OpenCompanyInput) => {
 *       try {
 *         return { ok: true, data: await companies.open(input) }
 *       } catch (error) {
 *         log.error(error)
 *         return { ok: false, error: describeError(error) }
 *       }
 *     })
 *
 * `describeError` maps `CompanyError`, `SecurityError` and `DbError` onto the `AppError`
 * envelope, keeping their stable codes and their already-user-facing messages, and
 * replacing anything else with a message that names no internals. Use it or map the
 * codes yourself — every error this module throws carries one.
 *
 * The app layer owns two things this module deliberately does not:
 *
 *   - calling `companies.close()` before quit, so the write-ahead log is folded back in;
 *   - logging `registryStatus()` at startup, which is where a corrupt registry explains
 *     itself. `list()` degrades to an empty list rather than failing the launch screen.
 *
 * `checkPassphrase` is advisory and gates nothing, here or anywhere (ARCHITECTURE
 * §6.3.1). Show the warning; let the passphrase through.
 */

// ---- The service ----
export { CompanyService, createCompanyService } from './service'
export type { CompanyServiceOptions } from './service'

// ---- Errors ----
export { CompanyError, describeError, isCompanyError } from './errors'
export type { CompanyErrorCode } from './errors'

// ---- The registry ----
export {
  CompanyRegistry,
  REGISTRY_FORMAT,
  REGISTRY_VERSION,
  availabilityOf,
  describeCompany,
  toSummary,
} from './registry'
export type { CompanyRecord, RegistryStatus } from './registry'

// ---- Paths ----
export {
  COMPANY_FILE_SUFFIX,
  REGISTRY_FILE_NAME,
  VAULT_FILE_SUFFIX,
  companyFileName,
  defaultDataDirectory,
  displayNameFromFilePath,
  fileNameSlug,
  vaultPathFor,
} from './paths'

// ---- Backup ----
export {
  BACKUP_FILE_SUFFIX,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  readBackup,
  writeBackup,
} from './backup'
export type { BackupManifest, OpenedBackup } from './backup'

// ---- Company database metadata ----
export { COMPANY_FORMAT, METADATA_KEYS, isCompanyDatabase, readMetadata } from './metadata'

// ---- Migrations a company file is brought up to ----
export { COMPANY_MIGRATIONS } from './migrations'

// ---- Passphrase strength, advisory only ----
export { scorePassphrase } from './passphrase'

import { createCompanyService } from './service'

/**
 * The application's company service, on the default data directory.
 *
 * Constructing it touches nothing: the data directory is resolved on the first call that
 * needs it, so importing this module in a test or before `app.whenReady()` is safe.
 */
export const companies = createCompanyService()
