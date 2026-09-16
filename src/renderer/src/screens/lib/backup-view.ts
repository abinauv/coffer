/*
 * What the screens say about backups.
 *
 * A backup is one file holding the database and its vault, written where the user chose.
 * Coffer cannot check that it is still there — the folder may be a USB stick that is in a
 * drawer, or a synced drive that has since been tidied — so every sentence here is about
 * WHAT WAS WRITTEN AND WHEN, never about what is on disk now. Saying "your books are
 * backed up" would be a claim this application is in no position to make.
 *
 * THE AGE IS COUNTED IN WHOLE DAYS, on the local calendar, the way the ledger's ageing is:
 * a backup taken last night and one taken this morning are both "today", because that is
 * what the person asking means. Nothing here is money, so this is arithmetic the renderer
 * may do (CONVENTIONS §1.7 is about figures from the books).
 */

import type { CompanyBackup, CompanySummary } from '@shared/dto'
import { describeFileSize } from './dates'

/**
 * How stale a backup has to be before the Overview says so.
 *
 * A week: long enough that a business which backs up on Fridays is never nagged, short
 * enough that the reminder arrives while the work it would lose is still a few days old.
 * The toggle's own label says this number, so it is written once and read twice.
 */
export const BACKUP_REMINDER_DAYS = 7

/** Whole days between two instants, on the local calendar. Negative clamps to zero. */
export function daysSince(at: string, now: Date = new Date()): number {
  const then = new Date(at)
  if (Number.isNaN(then.getTime())) return 0
  const startOfDay = (date: Date): number =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000)
  return days > 0 ? days : 0
}

/** "today", "yesterday", "6 days ago". */
export function whenBackedUp(at: string, now: Date = new Date()): string {
  const days = daysSince(at, now)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${String(days)} days ago`
}

/**
 * The line under "Last backup", wherever it is shown.
 *
 * Never merely "3 days ago": the size and the path are what tell somebody the file they
 * are looking at is the one this says was written.
 */
export function lastBackupLine(backup: CompanyBackup | null, now: Date = new Date()): string {
  if (backup === null) return 'No backup has been written from this machine'
  return `Written ${whenBackedUp(backup.at, now)} · ${describeFileSize(backup.sizeBytes)}`
}

/** The short form, for the rail's footer where there is one line and no room. */
export function railBackupLine(backup: CompanyBackup | null, now: Date = new Date()): string {
  return backup === null ? 'No backup yet' : `Backed up ${whenBackedUp(backup.at, now)}`
}

/**
 * Whether the Overview should say something about it.
 *
 * Only when the company asked to be reminded. A company that has never been backed up is
 * overdue from the day it is a week old and not before: a set of books made this morning
 * has nothing in it worth an alarm, and a reminder on day one is one nobody reads.
 */
export function isBackupOverdue(company: CompanySummary, now: Date = new Date()): boolean {
  if (!company.remindsAboutBackups) return false
  const since = company.lastBackup?.at ?? company.createdAt
  return daysSince(since, now) >= BACKUP_REMINDER_DAYS
}

/** What the Overview's attention panel says about it. Null when there is nothing to say. */
export function backupAttention(
  company: CompanySummary | null,
  now: Date = new Date(),
): { title: string; note: string } | null {
  if (company === null || !isBackupOverdue(company, now)) return null

  const days = daysSince(company.lastBackup?.at ?? company.createdAt, now)
  return company.lastBackup === null
    ? {
        title: 'These books have never been backed up',
        note: `They were made ${String(days)} days ago. A backup is one file holding the books and their keys — keep a copy somewhere other than this machine.`,
      }
    : {
        title: `No backup for ${String(days)} days`,
        note: `The last one was written ${whenBackedUp(company.lastBackup.at, now)}. Everything entered since then exists only on this machine.`,
      }
}
