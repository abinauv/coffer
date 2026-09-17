/*
 * Tax returns, against a real company with real issued documents.
 *
 * ONLY THE SAVE DIALOG IS FAKED. The vault, the database, the regime, the mapper and the
 * builders are all real, so what is asserted is the return a user would see: which table a
 * real invoice lands in, what the file says about itself, and whether the Overview is told.
 *
 * The regime's own tables are tested to the paisa inside `regimes/in-gst/returns`; this
 * file tests the seam — that a document stored by `DocumentsService` reaches those builders
 * whole, and that nothing on the way drops it.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { aprilToMarch } from '@main/domain/time'
import type { DocumentLineInput } from '@shared/dto'

import { CompanyProfileService } from '../company-profile/service'
import { CompanyService } from '../companies/service'
import { createQueryBuilder } from '../db/kysely'
import { createSeries } from '../db/repos/numbering'
import { generateFiscalYear } from '../db/repos/periods'
import { DocumentsService } from '../documents/service'
import { PartiesService } from '../parties/service'
import { type Argon2Params, MIN_MEMORY_COST } from '../security'
import {
  TaxReturnsService,
  fileNameOf,
  periodLabel,
  previousMonth,
  requirePeriod,
  type ReturnFileSaver,
} from './service'

const FAST: Argon2Params = {
  algorithm: 'argon2id',
  memoryCost: MIN_MEMORY_COST,
  timeCost: 1,
  parallelism: 1,
}

const PASSPHRASE = 'a quiet ledger keeps its own counsel'
/* Tamil Nadu is 33, Karnataka 29. The company sits in Tamil Nadu throughout. */
const TAMIL_NADU_GSTIN = '33AABCC1234D1ZI'
const KARNATAKA_GSTIN = '29AAAAA0000A1ZY'
const AUGUST = { from: '2026-08-01', to: '2026-08-31' }

const directories: string[] = []
const services: CompanyService[] = []

interface Saved {
  name: string
  contents: string
}

async function fixture(options: { cancelSave?: boolean } = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'coffer-returns-registry-'))
  const companyDirectory = await mkdtemp(join(tmpdir(), 'coffer-returns-books-'))
  directories.push(dataDirectory, companyDirectory)

  const companies = new CompanyService({
    dataDirectory,
    kdf: { passphrase: FAST, recovery: FAST },
  })
  services.push(companies)
  await companies.create({
    displayName: 'Acme Traders',
    directoryPath: companyDirectory,
    passphrase: PASSPHRASE,
  })
  await new CompanyProfileService(companies).save({
    legalName: 'Acme Traders Private Limited',
    countryCode: 'in',
    registrationNumber: TAMIL_NADU_GSTIN,
  })

  const parties = new PartiesService(companies)
  const local = await parties.create({
    name: 'Bharat Steel',
    countryCode: 'in',
    isCustomer: true,
    jurisdictionCode: '33',
  })
  const registered = await parties.create({
    name: 'Mysore Metals',
    countryCode: 'in',
    isCustomer: true,
    registrationNumber: KARNATAKA_GSTIN,
  })

  const db = createQueryBuilder(companies.currentDatabase()!)
  await generateFiscalYear(db, { rule: aprilToMarch, startYear: 2026 }).catch(() => undefined)
  await createSeries(db, {
    kind: 'sales-invoice',
    label: 'Domestic',
    prefix: 'INV',
    separator: '/',
    includeFiscalYear: true,
    width: 4,
    resetOn: 'fiscal-year',
  })

  const saved: Saved[] = []
  const saver: ReturnFileSaver = {
    save: vi.fn(async (name: string, contents: string) => {
      if (options.cancelSave === true) return null
      saved.push({ name, contents })
      return `/tmp/${name}`
    }),
  }

  return {
    companies,
    documents: new DocumentsService(companies),
    returns: new TaxReturnsService(companies, saver, { appName: 'Coffer', appVersion: '0.0.0' }),
    saved,
    local: local.id,
    registered: registered.id,
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

const line = (over: Partial<DocumentLineInput> = {}): DocumentLineInput => ({
  description: 'Ball bearing 6203',
  quantity: '2.000',
  unitPrice: '500.00',
  ratePct: '18',
  classificationCode: '8482',
  ...over,
})

async function issue(parts: Fixture, partyId: string, date: string): Promise<string> {
  const draft = await parts.documents.create({
    kind: 'sales-invoice',
    partyId,
    date,
    lines: [line()],
  })
  return (await parts.documents.issue({ id: draft.id })).id
}

afterEach(async () => {
  for (const service of services.splice(0)) await service.close().catch(() => undefined)
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
  }
})

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : `unexpected: ${String(error)}`
  }
  return 'no error thrown'
}

describe('a return prepared from the books', () => {
  /*
   * THE SEAM, IN ONE TEST. Two real invoices, one to an unregistered customer at home and
   * one to a registered customer in another state, land in two different tables — which
   * only happens if the party, the place of supply and the stored tax all reached the
   * builders intact.
   */
  it('puts each real invoice in the table it belongs in', async () => {
    const parts = await fixture()
    await issue(parts, parts.local, '2026-08-05')
    await issue(parts, parts.registered, '2026-08-20')

    const prepared = await parts.returns.taxReturn({ formId: 'gstr-1', ...AUGUST })

    const row = (id: string) => prepared.rows.find((candidate) => candidate.id === id)
    expect(row('b2b')).toMatchObject({ documentCount: 1, taxableValue: '1000.00', tax: '180.00' })
    expect(row('b2cs')).toMatchObject({ documentCount: 1, taxableValue: '1000.00', tax: '180.00' })
    expect(prepared.total).toMatchObject({
      documentCount: 2,
      taxableValue: '2000.00',
      tax: '360.00',
    })
    expect(prepared.period).toEqual({ ...AUGUST, label: 'August 2026' })
  })

  it('says it is provisional, and carries the notice that explains why', async () => {
    const parts = await fixture()
    await issue(parts, parts.local, '2026-08-05')

    const prepared = await parts.returns.taxReturn({ formId: 'gstr-1', ...AUGUST })

    expect(prepared.isProvisional).toBe(true)
    expect(prepared.notice).toMatch(/has not been checked against the portal/)
    /* Stated once, as status — not again among the problems a user could fix. */
    expect(prepared.issues.map((issue) => issue.code)).not.toContain('SCHEMA_UNVERIFIED')
  })

  it('leaves out what is outside the period, and what is still a draft', async () => {
    const parts = await fixture()
    await issue(parts, parts.local, '2026-08-31')
    await issue(parts, parts.local, '2026-09-01')
    await parts.documents.create({
      kind: 'sales-invoice',
      partyId: parts.local,
      date: '2026-08-15',
      lines: [line()],
    })

    const prepared = await parts.returns.taxReturn({ formId: 'gstr-1', ...AUGUST })

    expect(prepared.total.documentCount).toBe(1)
  })

  it('prepares the summary return from the same documents', async () => {
    const parts = await fixture()
    await issue(parts, parts.local, '2026-08-05')

    const prepared = await parts.returns.taxReturn({ formId: 'gstr-3b', ...AUGUST })

    expect(prepared.rows.find((row) => row.id === '3.1a')).toMatchObject({
      taxableValue: '1000.00',
      tax: '180.00',
    })
    expect(prepared.total).toMatchObject({ label: 'Cash payable', tax: '180.00' })
  })

  it('refuses a form the regime does not prepare, and a period that ends before it starts', async () => {
    const parts = await fixture()

    expect(await codeOf(() => parts.returns.taxReturn({ formId: 'gstr-9', ...AUGUST }))).toBe(
      'RETURN_FORM_UNKNOWN',
    )
    expect(
      await codeOf(() =>
        parts.returns.taxReturn({ formId: 'gstr-1', from: '2026-08-31', to: '2026-08-01' }),
      ),
    ).toBe('RETURN_PERIOD_INVALID')
  })
})

describe('the exported file', () => {
  it('states that it is provisional in its own body, before anything else', async () => {
    const parts = await fixture()
    await issue(parts, parts.local, '2026-08-05')

    const result = await parts.returns.exportTaxReturn({ formId: 'gstr-1', ...AUGUST })

    expect(result.path).toBe('/tmp/gstr-1-2026-08.json')
    const file = JSON.parse(parts.saved[0]?.contents ?? '{}') as Record<string, unknown>
    expect(Object.keys(file).slice(0, 2)).toEqual(['provisional', 'notice'])
    expect(file['provisional']).toBe(true)
    expect(file['preparedBy']).toBe('Coffer 0.0.0')
    expect(file['return']).toMatchObject({ reported: { documentCount: 1 } })
  })

  it('reports a cancelled save dialog as a cancellation', async () => {
    const parts = await fixture({ cancelSave: true })

    await expect(parts.returns.exportTaxReturn({ formId: 'gstr-1', ...AUGUST })).resolves.toEqual({
      path: null,
    })
  })
})

describe('what the Overview is told', () => {
  it('names a finished month with documents that nobody has looked at', async () => {
    const parts = await fixture()
    await issue(parts, parts.local, '2026-08-05')

    const due = await parts.returns.taxReturnsDue({ asAtDate: '2026-09-17' })

    expect(due.map((entry) => entry.form.id)).toEqual(['gstr-1', 'gstr-3b'])
    expect(due[0]).toMatchObject({ period: { ...AUGUST, label: 'August 2026' }, documentCount: 1 })
  })

  it('stops naming a form once it has been looked at', async () => {
    const parts = await fixture()
    await issue(parts, parts.local, '2026-08-05')

    await parts.returns.markTaxReturnSeen({ formId: 'gstr-1', ...AUGUST })

    const due = await parts.returns.taxReturnsDue({ asAtDate: '2026-09-17' })
    expect(due.map((entry) => entry.form.id)).toEqual(['gstr-3b'])
  })

  /* Opening March after August must not make August look unread again. */
  it('never moves "looked at" backwards', async () => {
    const parts = await fixture()
    await issue(parts, parts.local, '2026-08-05')

    await parts.returns.markTaxReturnSeen({ formId: 'gstr-1', ...AUGUST })
    await parts.returns.markTaxReturnSeen({
      formId: 'gstr-1',
      from: '2026-04-01',
      to: '2026-04-30',
    })

    const due = await parts.returns.taxReturnsDue({ asAtDate: '2026-09-17' })
    expect(due.map((entry) => entry.form.id)).toEqual(['gstr-3b'])
  })

  /* A month with nothing in it has nothing worth opening, and a new company has no
   * business being told about last month. */
  it('says nothing about a month with no documents in it', async () => {
    const parts = await fixture()
    await issue(parts, parts.local, '2026-09-02')

    await expect(parts.returns.taxReturnsDue({ asAtDate: '2026-09-17' })).resolves.toEqual([])
  })
})

describe('periods and file names', () => {
  it('names a whole month by the month, and anything else by its dates', () => {
    expect(periodLabel('2026-08-01', '2026-08-31')).toBe('August 2026')
    expect(periodLabel('2024-02-01', '2024-02-29')).toBe('February 2024')
    /* A return labelled 'August 2026' that covered half of it would be believed. */
    expect(periodLabel('2026-08-01', '2026-08-15')).toBe('2026-08-01 to 2026-08-15')
    expect(periodLabel('2026-07-01', '2026-09-30')).toBe('2026-07-01 to 2026-09-30')
  })

  it('finds the month before, across a year end', () => {
    expect(previousMonth('2026-09-17')).toEqual({ ...AUGUST, label: 'August 2026' })
    expect(previousMonth('2027-01-03')).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
      label: 'December 2026',
    })
  })

  it('refuses a period that ends before it starts', () => {
    expect(() => requirePeriod({ from: '2026-09-01', to: '2026-08-31' })).toThrow(/cannot end/)
  })

  it('names the file after the form and the month', () => {
    expect(fileNameOf({ form: { id: 'gstr-3b' }, period: { ...AUGUST, label: '' } })).toBe(
      'gstr-3b-2026-08.json',
    )
    expect(
      fileNameOf({
        form: { id: 'gstr-1' },
        period: { from: '2026-08-01', to: '2026-08-15', label: '' },
      }),
    ).toBe('gstr-1-2026-08-01-to-2026-08-15.json')
  })
})
