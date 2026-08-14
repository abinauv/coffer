/*
 * Where a company's two files live, and what they are called.
 *
 * A company is a database and a sidecar vault (ARCHITECTURE §6.3):
 *
 *     MyCompany/
 *       Acme-Traders.coffer          the SQLCipher database
 *       Acme-Traders.coffer.vault    wrapped DEK, salts, KDF parameters, recovery slots
 *
 * The vault path is always the database path with `.vault` appended — not a name derived
 * separately. That is what lets `addExisting` find the keys for a file the user points at
 * without asking a second question, and what makes "these two travel together" a rule the
 * filesystem itself expresses.
 *
 * Every name that reaches the filesystem passes through `companyFileName`. Display names
 * are free text: a user may call a company `Acme / Traders (2026)`, and `/` is a path
 * separator, `:` is invalid on Windows, and `CON` is a device. None of those may reach a
 * path, and none of them are the user's problem — the registry keeps the display name
 * exactly as it was typed.
 */

import type { App } from 'electron'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

import { BRAND } from '../../branding'
import { CompanyError } from './errors'

/** Extension of a company database, with the leading dot. */
export const COMPANY_FILE_SUFFIX = `.${BRAND.companyFileExtension}`

/** Appended to a database path to name its vault. */
export const VAULT_FILE_SUFFIX = '.vault'

/** The registry file, inside the application data directory. */
export const REGISTRY_FILE_NAME = 'companies.json'

/** Longest slug a display name may produce, before the extension. */
const MAX_SLUG_LENGTH = 60

/*
 * Everything that must not reach a file name: both path separators, the five characters
 * Windows forbids outright, and the Unicode "other" category — control, format and
 * unassigned code points, which `\p{C}` covers without a single control literal in the
 * source. Each run becomes one hyphen.
 */
const UNSAFE_FILE_NAME_CHARACTERS = /[<>:"/\\|?*\p{C}]+/gu

/*
 * Windows treats these as devices in every directory, with or without an extension:
 * `CON.coffer` is not a file, it is the console. Matched case-insensitively.
 */
const WINDOWS_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 10 }, (_unused, index) => `com${index}`),
  ...Array.from({ length: 10 }, (_unused, index) => `lpt${index}`),
])

/** The vault that belongs beside `databaseFilePath`. */
export function vaultPathFor(databaseFilePath: string): string {
  return `${databaseFilePath}${VAULT_FILE_SUFFIX}`
}

/** The journal files SQLite keeps beside an open database. */
export function sidecarPathsFor(databaseFilePath: string): string[] {
  return [`${databaseFilePath}-wal`, `${databaseFilePath}-shm`, `${databaseFilePath}-journal`]
}

/**
 * A file name for a company, derived from its display name.
 *
 * `CreateCompanyInput.directoryPath` is the directory and the file name comes from the
 * display name (see src/shared/dto.ts), so this is the only place that decision is made.
 */
export function companyFileName(displayName: string): string {
  return `${fileNameSlug(displayName)}${COMPANY_FILE_SUFFIX}`
}

/**
 * Reduce free text to something safe on all three platforms: letters, digits, and single
 * hyphens where anything else was. Case is kept — `Acme-Traders.coffer` is friendlier in
 * a file manager than `acme-traders.coffer`, and no supported filesystem cares.
 */
export function fileNameSlug(displayName: string): string {
  const slug = displayName
    .normalize('NFC')
    .replace(UNSAFE_FILE_NAME_CHARACTERS, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    /* Windows silently strips trailing dots and spaces, which would leave the name on
     * disk different from the name we believe we wrote. */
    .replace(/^[-.\s]+/, '')
    .replace(/[-.\s]+$/, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/[-.\s]+$/, '')

  if (slug === '') {
    return BRAND.defaultCompanyFileName
  }
  if (WINDOWS_DEVICE_NAMES.has(slug.toLowerCase())) {
    return `${slug}-company`
  }
  return slug
}

/**
 * A display name for a company file that arrived without one — `addExisting`, or a
 * restored archive whose manifest came from a future version.
 */
export function displayNameFromFilePath(databaseFilePath: string): string {
  const name = basename(databaseFilePath)
  const stem = name.toLowerCase().endsWith(COMPANY_FILE_SUFFIX)
    ? name.slice(0, -COMPANY_FILE_SUFFIX.length)
    : name
  const display = stem.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  return display === '' ? 'Company' : display
}

/**
 * Turn a caller-supplied directory into an absolute path, refusing the empty string.
 *
 * `resolve('')` quietly returns the process working directory, which for an Electron app
 * is wherever the user happened to launch it from. A company file created there is a
 * company file nobody will find again.
 */
export function requireDirectoryPath(directoryPath: string, what: string): string {
  if (typeof directoryPath !== 'string' || directoryPath.trim() === '') {
    throw new CompanyError('COMPANY_DIRECTORY_REQUIRED', `Choose a folder ${what}.`)
  }
  return resolve(directoryPath)
}

/** Turn a caller-supplied file path into an absolute one, refusing empty and root paths. */
export function requireFilePath(filePath: string, what: string): string {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new CompanyError('COMPANY_DIRECTORY_REQUIRED', `Choose ${what}.`)
  }
  const resolved = resolve(filePath)
  if (!isAbsolute(resolved) || dirname(resolved) === resolved) {
    throw new CompanyError('COMPANY_DIRECTORY_REQUIRED', `Choose ${what}.`)
  }
  return resolved
}

/**
 * The application data directory: where the registry lives, and nothing else.
 *
 * Electron is imported dynamically rather than at the top of the file. This module is
 * reachable from tests, and `import { app } from 'electron'` outside an Electron process
 * resolves to the path of the binary — a confusing failure, at import time, in files that
 * never asked for it. Nothing here touches Electron until a caller actually wants the
 * default location; tests pass their own directory instead.
 */
export async function defaultDataDirectory(): Promise<string> {
  const app = await electronApp()

  /*
   * `userData` is already per-application, but its last segment follows the Electron app
   * name — the package name in development, the product name in a packaged build.
   * Appending the brand directory pins the registry to one predictable folder in both,
   * without producing `Coffer/Coffer` when the two already agree.
   */
  const root = app.getPath('userData')
  return basename(root).toLowerCase() === BRAND.dataDirName.toLowerCase()
    ? root
    : resolve(root, BRAND.dataDirName)
}

async function electronApp(): Promise<App> {
  let candidate: unknown
  try {
    candidate = await import('electron')
  } catch (error) {
    throw new CompanyError(
      'REGISTRY_IO_FAILED',
      'Coffer could not work out where to keep its list of companies.',
      { cause: error },
    )
  }

  /* Depending on how the module is loaded, the namespace is either the Electron module
   * itself or a CommonJS interop wrapper around it. */
  const namespace = candidate as { app?: App; default?: { app?: App } }
  const app = namespace.app ?? namespace.default?.app
  if (app === undefined || typeof app.getPath !== 'function') {
    throw new CompanyError(
      'REGISTRY_IO_FAILED',
      'Coffer could not work out where to keep its list of companies.',
    )
  }
  return app
}
