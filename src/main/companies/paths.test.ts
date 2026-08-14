import { describe, expect, it } from 'vitest'

import { CompanyError } from './errors'
import {
  COMPANY_FILE_SUFFIX,
  companyFileName,
  displayNameFromFilePath,
  fileNameSlug,
  requireDirectoryPath,
  requireFilePath,
  sidecarPathsFor,
  vaultPathFor,
} from './paths'

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof CompanyError ? error.code : `unexpected error: ${String(error)}`
  }
  return 'did not throw'
}

describe('vaultPathFor', () => {
  it('puts the vault beside the database, named after it', () => {
    expect(vaultPathFor('/books/Acme.coffer')).toBe('/books/Acme.coffer.vault')
  })

  it('names the journal files SQLite keeps beside an open database', () => {
    expect(sidecarPathsFor('/books/Acme.coffer')).toEqual([
      '/books/Acme.coffer-wal',
      '/books/Acme.coffer-shm',
      '/books/Acme.coffer-journal',
    ])
  })
})

describe('companyFileName', () => {
  it('uses the product file extension', () => {
    expect(companyFileName('Acme Traders')).toBe(`Acme-Traders${COMPANY_FILE_SUFFIX}`)
  })
})

describe('fileNameSlug', () => {
  it('keeps letters, digits and case, and hyphenates the rest', () => {
    expect(fileNameSlug('Acme Traders')).toBe('Acme-Traders')
    expect(fileNameSlug('Acme & Sons, Pvt Ltd')).toBe('Acme-&-Sons,-Pvt-Ltd')
    expect(fileNameSlug('Acme 2026')).toBe('Acme-2026')
  })

  it('removes everything that is a path or that Windows forbids', () => {
    expect(fileNameSlug('Acme / Traders')).toBe('Acme-Traders')
    expect(fileNameSlug('C:\\books\\Acme')).toBe('C-books-Acme')
    expect(fileNameSlug('Acme <2026>: "the good year"?')).toBe('Acme-2026-the-good-year')
  })

  it('never ends in a dot or a space, which Windows would strip behind our back', () => {
    expect(fileNameSlug('Acme Traders.')).toBe('Acme-Traders')
    expect(fileNameSlug('  Acme Traders  ')).toBe('Acme-Traders')
  })

  it('falls back to the default name when nothing usable is left', () => {
    expect(fileNameSlug('///')).toBe('books')
    expect(fileNameSlug('🙂')).toBe('🙂')
    expect(fileNameSlug('   ')).toBe('books')
  })

  it('sidesteps the Windows device names', () => {
    expect(fileNameSlug('CON')).toBe('CON-company')
    expect(fileNameSlug('lpt1')).toBe('lpt1-company')
    expect(fileNameSlug('Console')).toBe('Console')
  })

  it('caps the length so a long name is still a legal path', () => {
    expect(fileNameSlug('A'.repeat(300)).length).toBeLessThanOrEqual(60)
  })
})

describe('displayNameFromFilePath', () => {
  it('reads a name back out of a file name', () => {
    expect(displayNameFromFilePath('/books/Acme-Traders.coffer')).toBe('Acme Traders')
    expect(displayNameFromFilePath('/books/Acme_Traders.coffer')).toBe('Acme Traders')
    expect(displayNameFromFilePath('/books/ledger.db')).toBe('ledger.db')
  })
})

describe('path arguments', () => {
  it('refuses an empty directory rather than resolving it to wherever the app started', () => {
    expect(codeOf(() => requireDirectoryPath('', 'to keep this in'))).toBe(
      'COMPANY_DIRECTORY_REQUIRED',
    )
    expect(codeOf(() => requireDirectoryPath('   ', 'to keep this in'))).toBe(
      'COMPANY_DIRECTORY_REQUIRED',
    )
    expect(requireDirectoryPath(process.cwd(), 'to keep this in')).toBe(process.cwd())
  })

  it('refuses an empty file path', () => {
    expect(codeOf(() => requireFilePath('', 'a company file'))).toBe('COMPANY_DIRECTORY_REQUIRED')
  })
})
