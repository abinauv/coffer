import { describe, expect, it } from 'vitest'
import type { CompanySummary } from '@shared/dto'
import {
  BACKUP_REMINDER_DAYS,
  backupAttention,
  daysSince,
  isBackupOverdue,
  lastBackupLine,
  railBackupLine,
  whenBackedUp,
} from './backup-view'

const NOW = new Date(2026, 8, 16, 11, 30)
const at = (day: number, hour = 9): string => new Date(2026, 8, day, hour).toISOString()

function company(over: Partial<CompanySummary> = {}): CompanySummary {
  return {
    id: 'acme',
    displayName: 'Acme Traders',
    filePath: '/books/acme.coffer',
    vaultPath: '/books/acme.coffer.vault',
    lastOpenedAt: null,
    createdAt: at(1),
    availability: 'ok',
    lastBackup: null,
    remindsAboutBackups: true,
    ...over,
  }
}

describe('daysSince', () => {
  /* Whole days on the calendar: last night and this morning are both "today". */
  it('counts calendar days rather than hours', () => {
    expect(daysSince(at(16, 1), NOW)).toBe(0)
    expect(daysSince(at(15, 23), NOW)).toBe(1)
    expect(daysSince(at(9), NOW)).toBe(7)
  })

  it('reads a time in the future as today rather than as a negative age', () => {
    expect(daysSince(at(20), NOW)).toBe(0)
  })

  it('reads an unreadable timestamp as today rather than as NaN', () => {
    expect(daysSince('whenever', NOW)).toBe(0)
  })
})

describe('whenBackedUp', () => {
  it('says it in the words a person would', () => {
    expect(whenBackedUp(at(16), NOW)).toBe('today')
    expect(whenBackedUp(at(15), NOW)).toBe('yesterday')
    expect(whenBackedUp(at(10), NOW)).toBe('6 days ago')
  })
})

describe('lastBackupLine', () => {
  it('carries the size, so the file on screen can be told from the one on disk', () => {
    expect(lastBackupLine({ at: at(15), path: '/x.zip', sizeBytes: 2_400_000 }, NOW)).toBe(
      'Written yesterday · 2.3 MB',
    )
  })

  /* Never "you have no backup" — this says what Coffer knows, which is what it wrote. */
  it('says nothing has been written from this machine', () => {
    expect(lastBackupLine(null, NOW)).toBe('No backup has been written from this machine')
  })
})

describe('railBackupLine', () => {
  it('is short enough for the rail', () => {
    expect(railBackupLine({ at: at(14), path: '/x.zip', sizeBytes: 10 }, NOW)).toBe(
      'Backed up 2 days ago',
    )
    expect(railBackupLine(null, NOW)).toBe('No backup yet')
  })
})

describe('isBackupOverdue', () => {
  it('is quiet until a week has passed', () => {
    const six = { at: at(10), path: '/x.zip', sizeBytes: 1 }
    const seven = { at: at(9), path: '/x.zip', sizeBytes: 1 }
    expect(isBackupOverdue(company({ lastBackup: six }), NOW)).toBe(false)
    expect(isBackupOverdue(company({ lastBackup: seven }), NOW)).toBe(true)
  })

  /* A company made this morning has nothing in it worth an alarm. */
  it('counts a company that has never been backed up from the day it was made', () => {
    expect(isBackupOverdue(company({ createdAt: at(15) }), NOW)).toBe(false)
    expect(isBackupOverdue(company({ createdAt: at(1) }), NOW)).toBe(true)
  })

  it('says nothing at all when the company asked not to be reminded', () => {
    expect(isBackupOverdue(company({ createdAt: at(1), remindsAboutBackups: false }), NOW)).toBe(
      false,
    )
  })

  it('uses the same number of days the toggle names', () => {
    expect(BACKUP_REMINDER_DAYS).toBe(7)
  })
})

describe('backupAttention', () => {
  it('says how long it has been, and what that means', () => {
    const item = backupAttention(
      company({ lastBackup: { at: at(2), path: '/x', sizeBytes: 1 } }),
      NOW,
    )
    expect(item?.title).toBe('No backup for 14 days')
    expect(item?.note).toContain('only on this machine')
  })

  it('has different words for books that have never been backed up', () => {
    expect(backupAttention(company({ createdAt: at(1) }), NOW)?.title).toBe(
      'These books have never been backed up',
    )
  })

  it('says nothing when there is nothing to say', () => {
    expect(backupAttention(company({ createdAt: at(15) }), NOW)).toBeNull()
    expect(backupAttention(null, NOW)).toBeNull()
  })
})
