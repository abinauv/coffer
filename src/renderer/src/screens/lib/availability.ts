/*
 * What the picker says about a company it cannot open.
 *
 * Three states, three genuinely different situations, three different things to do
 * (src/shared/dto.ts, `CompanyAvailability`):
 *
 *   ok                open it.
 *   database-missing   the file is not where the list says. Usually a drive that is not
 *                      connected, or a file that moved. The books are probably fine.
 *   vault-missing      the keys are gone. Nothing anyone does — including Coffer, and
 *                      including us — decrypts that database without them. This is the
 *                      one the user must not misread as "try again later", which is why
 *                      it never shares its wording with the case above.
 *
 * ARCHITECTURE §6.3 is the reason there are two failure states rather than one: the
 * vault is a sidecar, and the honest consequence of a sidecar is that it can be lost on
 * its own.
 */

import type { BadgeTone } from '@renderer/components/atoms'
import type { CompanyAvailability, CompanySummary } from '@shared/dto'
import type { ErrorAction } from './messages'

export interface AvailabilityNotice {
  /** The pill on the row. Null when the company is ready to open. */
  badge: { label: string; tone: BadgeTone } | null
  /** What is wrong and what it means. Null when nothing is wrong. */
  headline: string | null
  /** What to do about it. Null when nothing is wrong. */
  body: string | null
  /** The action worth putting a button on. */
  action: ErrorAction | null
  canOpen: boolean
}

const READY: AvailabilityNotice = {
  badge: null,
  headline: null,
  body: null,
  action: null,
  canOpen: false,
}

/**
 * The notice for one company, filled in with its own paths.
 *
 * The paths are in the copy on purpose: "the vault is missing" is a sentence about a
 * file, and a user cannot act on it without being told which file and where.
 */
export function describeAvailability(company: CompanySummary): AvailabilityNotice {
  switch (company.availability) {
    case 'ok':
      return { ...READY, canOpen: true }

    case 'database-missing':
      return {
        badge: { label: 'File not found', tone: 'warning' },
        headline: 'Coffer cannot find this file.',
        body:
          `There is nothing at ${company.filePath}. If it is on a drive or a share that ` +
          'is not connected, connect it and refresh. If it moved, add it again from its ' +
          'new location — the list is only a list, and nothing has been lost.',
        action: 'add-existing',
        canOpen: false,
      }

    case 'vault-missing':
      return {
        badge: { label: 'Keys missing', tone: 'negative' },
        headline: 'The keys for this company are missing.',
        body:
          `The database is here, but there is no ${company.vaultPath} beside it. The keys ` +
          'live in that vault file, so without it these books cannot be decrypted by ' +
          'anyone — not you, and not Coffer. Restore from a backup, which holds the ' +
          'database and its vault together.',
        action: 'restore',
        canOpen: false,
      }
  }
}

/** Short enough for a toast or a button title. */
export function availabilityLabel(availability: CompanyAvailability): string {
  switch (availability) {
    case 'ok':
      return 'Ready'
    case 'database-missing':
      return 'File not found'
    case 'vault-missing':
      return 'Keys missing'
  }
}

/** Sorted for the picker: most recently opened first, never-opened last, then by name. */
export function sortCompanies(companies: readonly CompanySummary[]): CompanySummary[] {
  return [...companies].sort((a, b) => {
    if (a.lastOpenedAt !== b.lastOpenedAt) {
      if (a.lastOpenedAt === null) return 1
      if (b.lastOpenedAt === null) return -1
      return a.lastOpenedAt < b.lastOpenedAt ? 1 : -1
    }
    return a.displayName.localeCompare(b.displayName)
  })
}
