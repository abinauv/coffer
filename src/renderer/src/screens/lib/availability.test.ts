import { describe, expect, it } from 'vitest'
import type { CompanyAvailability, CompanySummary } from '@shared/dto'
import { availabilityLabel, describeAvailability, sortCompanies } from './availability'

function company(
  availability: CompanyAvailability,
  overrides: Partial<CompanySummary> = {},
): CompanySummary {
  return {
    id: 'company-1',
    displayName: 'Acme Traders',
    filePath: 'D:\\books\\Acme-Traders.coffer',
    vaultPath: 'D:\\books\\Acme-Traders.coffer.vault',
    lastOpenedAt: '2026-08-13T09:30:00.000Z',
    createdAt: '2026-01-04T09:30:00.000Z',
    availability,
    lastBackup: null,
    remindsAboutBackups: true,
    ...overrides,
  }
}

describe('describeAvailability', () => {
  it('gets out of the way when the company can be opened', () => {
    const notice = describeAvailability(company('ok'))
    expect(notice.canOpen).toBe(true)
    expect(notice.badge).toBeNull()
    expect(notice.headline).toBeNull()
  })

  it('gives the three states three different messages', () => {
    const messages = (['ok', 'database-missing', 'vault-missing'] as const).map(
      (availability) => describeAvailability(company(availability)).headline,
    )
    expect(new Set(messages).size).toBe(3)
  })

  it('says the keys are missing, and to restore a backup holding them', () => {
    const notice = describeAvailability(company('vault-missing'))
    expect(notice.headline).toBe('The keys for this company are missing.')
    expect(notice.body).toContain('D:\\books\\Acme-Traders.coffer.vault')
    expect(notice.body).toContain('Restore from a backup')
    expect(notice.body).toContain('not Coffer')
    expect(notice.action).toBe('restore')
    expect(notice.canOpen).toBe(false)
  })

  it('never calls a missing vault a generic failure', () => {
    const notice = describeAvailability(company('vault-missing'))
    const text = `${notice.headline} ${notice.body}`.toLowerCase()
    expect(text).not.toContain('could not')
    expect(text).not.toContain('failed')
    expect(text).not.toContain('try again')
  })

  it('treats a missing file as something to reconnect or re-add', () => {
    const notice = describeAvailability(company('database-missing'))
    expect(notice.body).toContain('D:\\books\\Acme-Traders.coffer')
    expect(notice.body).toContain('connect it')
    expect(notice.action).toBe('add-existing')
    expect(notice.canOpen).toBe(false)
  })

  it('names the state on the badge as well as in the colour', () => {
    expect(describeAvailability(company('vault-missing')).badge).toEqual({
      label: 'Keys missing',
      tone: 'negative',
    })
    expect(describeAvailability(company('database-missing')).badge?.tone).toBe('warning')
  })
})

describe('availabilityLabel', () => {
  it('has a word for each state', () => {
    expect(availabilityLabel('ok')).toBe('Ready')
    expect(availabilityLabel('database-missing')).toBe('File not found')
    expect(availabilityLabel('vault-missing')).toBe('Keys missing')
  })
})

describe('sortCompanies', () => {
  it('puts the most recently opened first and the never-opened last', () => {
    const sorted = sortCompanies([
      company('ok', { id: 'old', lastOpenedAt: '2026-01-01T00:00:00.000Z' }),
      company('ok', { id: 'never', lastOpenedAt: null }),
      company('ok', { id: 'recent', lastOpenedAt: '2026-08-01T00:00:00.000Z' }),
    ])
    expect(sorted.map((entry) => entry.id)).toEqual(['recent', 'old', 'never'])
  })

  it('falls back to the name, and leaves the input alone', () => {
    const input = [
      company('ok', { id: 'b', displayName: 'Beta', lastOpenedAt: null }),
      company('ok', { id: 'a', displayName: 'Alpha', lastOpenedAt: null }),
    ]
    expect(sortCompanies(input).map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(input.map((entry) => entry.id)).toEqual(['b', 'a'])
  })
})
