/*
 * Single source of truth for product identity.
 *
 * Every user-visible name, filesystem path segment, URL and identifier resolves here.
 * Nothing else in the codebase may hard-code the product name. A name scattered across
 * dozens of files is a rename nobody can finish, which is precisely the situation this
 * module exists to prevent.
 *
 * Renaming the product should be a change to this file and nothing else.
 */

export const BRAND = {
  /** Product name, title case. Window titles, headings, About. */
  name: 'Coffer',

  /** Lower-case identifier. Package name, protocol scheme, CLI. */
  id: 'coffer',

  /** One-line description. Installer, About, package metadata. */
  tagline: 'Your books, in your own safe.',

  /** Longer description. Installer body, store listings, docs landing. */
  description:
    'A local-first, double-entry ERP for small businesses. Invoicing, purchases, ' +
    'inventory, a real general ledger and GST compliance — running entirely on your ' +
    'own machine, in one encrypted file you own.',

  /** Reverse-DNS application identifier. macOS bundle id, Windows AppUserModelID. */
  appId: 'com.coffer.app',

  /** Directory name under the OS application-data path. Holds the company registry. */
  dataDirName: 'Coffer',

  /** File extension for a company database, without the leading dot. */
  companyFileExtension: 'coffer',

  /** Default file name offered when creating a company. */
  defaultCompanyFileName: 'books',

  /** Custom protocol scheme, for deep links. */
  protocol: 'coffer',

  /** Copyright holder shown in About and the licence notice. */
  copyrightHolder: 'The Coffer contributors',

  /** SPDX licence identifier. */
  license: 'AGPL-3.0-or-later',

  /** Canonical URLs. */
  urls: {
    homepage: 'https://github.com/abinauv/coffer',
    repository: 'https://github.com/abinauv/coffer',
    issues: 'https://github.com/abinauv/coffer/issues',
    security: 'https://github.com/abinauv/coffer/security/advisories/new',
    docs: 'https://github.com/abinauv/coffer/tree/main/docs',
  },
} as const

export type Brand = typeof BRAND
