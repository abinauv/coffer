/*
 * The numbering service, against a real company created by the real company service.
 *
 * WHY A REAL COMPANY AND NOT A FIXTURE. `seedDefaults` is a repair of the SHIPPED opening
 * state, and a test that built its own series could not notice the shipped table being
 * wrong — which is exactly how the missing series went unseen twice. Migration 0012 was
 * written after somebody built a company file the way the app builds one and asked it what
 * series it had; every test passed throughout, because a test that issues something creates
 * its own series first. So this file asks the file the application actually creates, and
 * pins the nine kinds and the nine prefixes it comes with.
 *
 * WHAT IS BEING REPAIRED. `seedDefaultSeries` runs from `setUpBooks`, which runs once, when
 * a company file is created. A file made before 0012 therefore has no series at all and
 * cannot issue anything; a file made before 0015 has seven of the nine and can record no
 * refund in either direction. Neither had an in-app repair until this method — and the
 * repository's own header records the second of those as owed for three batches running.
 * The tests below build both of those files by deleting series from a complete one, which
 * is the only way to have them: a migration cannot un-run.
 *
 * The counter is what a careless repair would damage, so it is moved before the repair and
 * read afterwards. A repair that recreated a series rather than skipping it would restart
 * its numbering at 1 and reissue numbers that are already on documents, and nothing about
 * the series row itself would look wrong.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CompanyService } from '../companies/service'
import { CompanyError } from '../companies/errors'
import { createQueryBuilder } from '../db/kysely'
import { allocateNumber } from '../db/repos/numbering'
import { NUMBERED_KINDS } from '../domain/documents'
import { type Argon2Params, MIN_MEMORY_COST } from '../security'
import { NumberingService } from './service'

const FAST: Argon2Params = {
  algorithm: 'argon2id',
  memoryCost: MIN_MEMORY_COST,
  timeCost: 1,
  parallelism: 1,
}

const PASSPHRASE = 'a quiet ledger keeps its own counsel'

/** Any label will do — the regime spells it, and nothing in numbering parses it. */
const FY = '2026-27'

/**
 * What `setUpBooks` actually lays down, kind by kind.
 *
 * Written out rather than derived, on purpose: this is the assertion about the SHIPPED
 * data, so deriving it from the same table the seeding reads would make it agree with
 * itself no matter what either said.
 */
const SHIPPED: readonly (readonly [kind: string, prefix: string])[] = [
  ['sales-invoice', 'INV'],
  ['quotation', 'QTN'],
  ['credit-note', 'CRN'],
  ['purchase-bill', 'BILL'],
  ['debit-note', 'DBN'],
  ['receipt', 'RCT'],
  ['payment', 'PAY'],
  ['refund', 'REF'],
  ['refund-received', 'RRV'],
]

const directories: string[] = []
const services: CompanyService[] = []

interface Fixture {
  companies: CompanyService
  numbering: NumberingService
}

async function fixture(): Promise<Fixture> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'coffer-numbering-registry-'))
  const companyDirectory = await mkdtemp(join(tmpdir(), 'coffer-numbering-books-'))
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

  return { companies, numbering: new NumberingService(companies) }
}

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.close().catch(() => undefined)
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
  }
})

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof CompanyError) return error.code
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : `unexpected: ${String(error)}`
  }
  return 'no error thrown'
}

/**
 * Spend a number from a series, the way issuing a document does.
 *
 * Through the repository because there is no contract method that spends one and there
 * must not be — see the `numbering` group in src/shared/ipc.ts. What it buys here is a
 * counter that is not at 1, so a repair that quietly restarted one would be visible.
 */
async function spendOne(
  companies: CompanyService,
  seriesId: string,
  fiscalYearLabel: string | null,
): Promise<string> {
  const connection = companies.currentDatabase()
  if (connection === null) throw new Error('no company is open')
  return allocateNumber(createQueryBuilder(connection), seriesId, fiscalYearLabel)
}

/** The one live default series for a kind, counted rather than found. */
async function defaultsFor(numbering: NumberingService, kind: string) {
  return (await numbering.list()).filter((series) => series.kind === kind && series.isDefault)
}

describe('which company is open', () => {
  it('refuses every method when none is', async () => {
    const numbering = new NumberingService({ currentDatabase: () => null })

    expect(await codeOf(() => numbering.list())).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => numbering.get('s1'))).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => numbering.create({ kind: 'sales-invoice', label: 'Main' }))).toBe(
      'NO_COMPANY_OPEN',
    )
    expect(await codeOf(() => numbering.update({ id: 's1', label: 'Main' }))).toBe(
      'NO_COMPANY_OPEN',
    )
    expect(await codeOf(() => numbering.archive({ id: 's1', archived: true }))).toBe(
      'NO_COMPANY_OPEN',
    )
    expect(await codeOf(() => numbering.delete('s1'))).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => numbering.preview({ seriesId: 's1', fiscalYearLabel: FY }))).toBe(
      'NO_COMPANY_OPEN',
    )
    expect(await codeOf(() => numbering.seedDefaults())).toBe('NO_COMPANY_OPEN')
  })

  it('reads the company that is open, and stops when it closes', async () => {
    const { companies, numbering } = await fixture()

    expect(await numbering.list()).toHaveLength(SHIPPED.length)

    await companies.close()
    expect(await codeOf(() => numbering.list())).toBe('NO_COMPANY_OPEN')
  })
})

describe('what a new company is shipped with', () => {
  /*
   * Nine, one per numbered kind, and the count is asserted against the domain's own table
   * as well as against the list below — so a tenth kind added without a series in the seed
   * table fails here rather than at the moment somebody tries to issue one.
   */
  it('has one series for every kind that can be numbered', async () => {
    const { numbering } = await fixture()

    const kinds = (await numbering.list()).map((series) => series.kind).sort()

    expect(kinds).toEqual(NUMBERED_KINDS.map((definition) => definition.kind).sort())
    expect(kinds).toHaveLength(9)
  })

  it('gives each kind the prefix it ships with', async () => {
    const { numbering } = await fixture()
    const byKind = new Map((await numbering.list()).map((series) => [series.kind, series]))

    for (const [kind, prefix] of SHIPPED) {
      expect(byKind.get(kind)?.prefix, kind).toBe(prefix)
      expect(byKind.get(kind)?.label, kind).toBe('Main')
      expect(byKind.get(kind)?.separator, kind).toBe('/')
    }
  })

  /*
   * An invoice number carries the financial year and restarts each April; a quotation's
   * runs on, because nothing has been supplied and rule 46(b) has nothing to say about it.
   * Asserted as a PAIR, because either alone is satisfied by a table that gives everything
   * the same answer.
   */
  it('numbers an invoice by the year and lets a quotation run on', async () => {
    const { numbering } = await fixture()
    const byKind = new Map((await numbering.list()).map((series) => [series.kind, series]))

    expect(byKind.get('sales-invoice')?.includeFiscalYear).toBe(true)
    expect(byKind.get('sales-invoice')?.resetOn).toBe('fiscal-year')
    expect(byKind.get('quotation')?.includeFiscalYear).toBe(false)
    expect(byKind.get('quotation')?.resetOn).toBe('never')
  })

  /*
   * `filter` and a count, not `.find`. "The series a new invoice takes" is a rule saying
   * there is exactly one, and `.find` would report the first of two as though it were the
   * only one — which is how table order silently becomes the rule (CONVENTIONS §1.9).
   */
  it('gives each kind exactly one default, not merely a first one', async () => {
    const { numbering } = await fixture()

    for (const [kind] of SHIPPED) {
      expect(await defaultsFor(numbering, kind), kind).toHaveLength(1)
    }
  })

  it('ships nothing archived and nothing already used', async () => {
    const { numbering } = await fixture()

    for (const series of await numbering.list({ includeArchived: true })) {
      expect(series.isArchived, series.kind).toBe(false)
      expect(series.hasIssued, series.kind).toBe(false)
    }
  })
})

describe('seedDefaults', () => {
  it('creates nothing on books that are already complete', async () => {
    const { numbering } = await fixture()

    expect(await numbering.seedDefaults()).toBe(0)
    expect(await numbering.list()).toHaveLength(SHIPPED.length)
  })

  /*
   * A FILE MADE BEFORE 0015, built the only way it can be: by taking the two refund series
   * off a complete one. Such a file can raise invoices and take receipts and cannot record
   * a refund in either direction, and before this method there was no way to fix it from
   * inside the application.
   */
  it('supplies the two kinds a file made before 0015 is missing', async () => {
    const { numbering } = await fixture()
    const byKind = new Map((await numbering.list()).map((series) => [series.kind, series]))

    for (const kind of ['refund', 'refund-received']) {
      const series = byKind.get(kind)
      if (series === undefined) throw new Error(`no shipped series for ${kind}`)
      await numbering.delete(series.id)
    }
    expect(await numbering.list()).toHaveLength(7)

    expect(await numbering.seedDefaults()).toBe(2)

    const repaired = new Map((await numbering.list()).map((series) => [series.kind, series]))
    expect(repaired.get('refund')?.prefix).toBe('REF')
    expect(repaired.get('refund-received')?.prefix).toBe('RRV')
    expect(await defaultsFor(numbering, 'refund')).toHaveLength(1)
    expect(await defaultsFor(numbering, 'refund-received')).toHaveLength(1)
  })

  /*
   * A FILE MADE BEFORE 0012, which has no series at all and cannot issue anything. One
   * call gives it the whole set.
   */
  it('supplies every kind to a file that has none', async () => {
    const { numbering } = await fixture()

    for (const series of await numbering.list()) {
      await numbering.delete(series.id)
    }
    expect(await numbering.list()).toEqual([])

    expect(await numbering.seedDefaults()).toBe(SHIPPED.length)
    expect((await numbering.list()).map((series) => series.kind).sort()).toEqual(
      SHIPPED.map(([kind]) => kind).sort(),
    )
  })

  /*
   * IDEMPOTENT, AND IT MUST NOT RENUMBER ANYTHING. The invoice series has already handed
   * out INV/2026-27/0001 before the repair runs, so its counter sits at 2 — and a repair
   * that recreated a series instead of skipping it would put a fresh row in its place, and
   * the next invoice raised would carry a number an earlier one already has. Nothing about
   * the row would look wrong; the counter is the only thing that shows it.
   *
   * The series id is asserted alongside, because a recreated series is a different row
   * even when every visible field matches.
   */
  it('runs twice over a repaired file, creating nothing and moving no counter', async () => {
    const { companies, numbering } = await fixture()
    const byKind = new Map((await numbering.list()).map((series) => [series.kind, series]))

    const invoices = byKind.get('sales-invoice')
    const refund = byKind.get('refund')
    if (invoices === undefined || refund === undefined) throw new Error('shipped series missing')

    expect(await spendOne(companies, invoices.id, FY)).toBe('INV/2026-27/0001')
    await numbering.delete(refund.id)

    expect(await numbering.seedDefaults()).toBe(1)
    expect(await numbering.seedDefaults()).toBe(0)
    expect(await numbering.seedDefaults()).toBe(0)

    const after = await numbering.get(invoices.id)
    expect(after?.id).toBe(invoices.id)
    expect(after?.hasIssued).toBe(true)

    const preview = await numbering.preview({ seriesId: invoices.id, fiscalYearLabel: FY })
    expect(preview.nextSequence).toBe(2)
    expect(preview.preview).toBe('INV/2026-27/0002')
    expect(await numbering.list()).toHaveLength(SHIPPED.length)
  })

  /*
   * A series somebody made themselves is not replaced, and the kind it belongs to is not
   * given a second one. This is the difference between "every kind has a series" and
   * "every kind has the series we shipped", and only the first is what the repair claims.
   */
  it('leaves a series the business made itself alone', async () => {
    const { numbering } = await fixture()
    const byKind = new Map((await numbering.list()).map((series) => [series.kind, series]))

    const shipped = byKind.get('sales-invoice')
    if (shipped === undefined) throw new Error('shipped series missing')
    await numbering.delete(shipped.id)

    const own = await numbering.create({
      kind: 'sales-invoice',
      label: 'Export',
      prefix: 'EXP',
      separator: '-',
      width: 5,
    })

    expect(await numbering.seedDefaults()).toBe(0)

    const invoices = (await numbering.list()).filter((series) => series.kind === 'sales-invoice')
    expect(invoices).toHaveLength(1)
    expect(invoices[0]?.id).toBe(own.id)
    expect(invoices[0]?.prefix).toBe('EXP')
  })
})

describe('preview', () => {
  it('says what the series would produce and spends nothing', async () => {
    const { numbering } = await fixture()
    const invoices = (await numbering.list()).filter(
      (series) => series.kind === 'sales-invoice' && series.isDefault,
    )
    const seriesId = invoices[0]?.id
    if (seriesId === undefined) throw new Error('no default invoice series')

    const first = await numbering.preview({ seriesId, fiscalYearLabel: FY })
    expect(first.preview).toBe('INV/2026-27/0001')
    expect(first.nextSequence).toBe(1)
    expect(first.fiscalYearLabel).toBe(FY)

    /* Twice. A preview that moved the counter would answer 0002 the second time, which is
     * the only way to tell a preview from an allocation from the outside. */
    const second = await numbering.preview({ seriesId, fiscalYearLabel: FY })
    expect(second.preview).toBe('INV/2026-27/0001')
    expect((await numbering.get(seriesId))?.hasIssued).toBe(false)
  })

  /*
   * A quotation series neither prints the year nor resets on it, so its counter has no
   * scope and the preview says so with a null rather than echoing the label back. The pair
   * (`fiscalYearLabel`, `nextSequence`) identifies one counter row, and for this series
   * there is only ever one.
   */
  it('reports no scope for a series that runs on across years', async () => {
    const { numbering } = await fixture()
    const quotations = (await numbering.list()).filter((series) => series.kind === 'quotation')
    const seriesId = quotations[0]?.id
    if (seriesId === undefined) throw new Error('no quotation series')

    const preview = await numbering.preview({ seriesId, fiscalYearLabel: null })
    expect(preview.fiscalYearLabel).toBeNull()
    expect(preview.preview).toBe('QTN/0001')
  })

  /*
   * The refusal that stops a number colliding with last year's. It is answered BEFORE
   * anything is written, which is the point of the repository asking it rather than
   * leaving it to `formatDocumentNumber` — by the time the formatting runs on a real
   * allocation the counter has already moved.
   */
  it('refuses a series that needs a year and was given none', async () => {
    const { numbering } = await fixture()
    const invoices = (await numbering.list()).filter((series) => series.kind === 'sales-invoice')
    const seriesId = invoices[0]?.id
    if (seriesId === undefined) throw new Error('no invoice series')

    expect(await codeOf(() => numbering.preview({ seriesId, fiscalYearLabel: null }))).toBe(
      'FISCAL_YEAR_REQUIRED',
    )
  })

  it('refuses a series that is not there', async () => {
    const { numbering } = await fixture()

    expect(
      await codeOf(() => numbering.preview({ seriesId: 'nothing', fiscalYearLabel: FY })),
    ).toBe('SERIES_NOT_FOUND')
  })
})

describe('the rest of the group', () => {
  it('creates, reads back, archives and deletes', async () => {
    const { numbering } = await fixture()

    const series = await numbering.create({
      kind: 'sales-invoice',
      label: 'Export',
      prefix: 'EXP',
      isDefault: false,
    })

    expect((await numbering.get(series.id))?.label).toBe('Export')

    const archived = await numbering.archive({ id: series.id, archived: true })
    expect(archived.isArchived).toBe(true)
    expect((await numbering.list()).map((s) => s.id)).not.toContain(series.id)
    expect((await numbering.list({ includeArchived: true })).map((s) => s.id)).toContain(series.id)

    await numbering.archive({ id: series.id, archived: false })
    await numbering.delete(series.id)
    expect(await numbering.get(series.id)).toBeNull()
  })

  /* Archiving takes a series out of the running for the default, and coming back does not
   * put it in again — the business has been numbering off the other one since. */
  it('moves the default and does not hand it back on un-archiving', async () => {
    const { numbering } = await fixture()
    const shipped = (await numbering.list()).filter((s) => s.kind === 'sales-invoice')[0]
    if (shipped === undefined) throw new Error('no invoice series')

    const second = await numbering.create({
      kind: 'sales-invoice',
      label: 'Export',
      prefix: 'EXP',
      isDefault: true,
    })

    expect((await defaultsFor(numbering, 'sales-invoice')).map((s) => s.id)).toEqual([second.id])

    await numbering.archive({ id: second.id, archived: true })
    expect(await defaultsFor(numbering, 'sales-invoice')).toHaveLength(0)

    await numbering.update({ id: shipped.id, isDefault: true })
    const restored = await numbering.archive({ id: second.id, archived: false })

    expect(restored.isDefault).toBe(false)
    expect((await defaultsFor(numbering, 'sales-invoice')).map((s) => s.id)).toEqual([shipped.id])
  })

  it('filters a list by kind', async () => {
    const { numbering } = await fixture()

    const receipts = await numbering.list({ kind: 'receipt' })
    expect(receipts.map((series) => series.prefix)).toEqual(['RCT'])
  })

  /* A series that has numbered something is archived, never deleted: deleting it throws
   * away how far it had got, and the next series in its place starts at 1. */
  it('will not delete a series that has handed out a number', async () => {
    const { companies, numbering } = await fixture()
    const invoices = (await numbering.list()).filter((s) => s.kind === 'sales-invoice')[0]
    if (invoices === undefined) throw new Error('no invoice series')

    await spendOne(companies, invoices.id, FY)

    expect(await codeOf(() => numbering.delete(invoices.id))).toBe('SERIES_IN_USE')
    expect(await codeOf(() => numbering.update({ id: invoices.id, prefix: 'INVOICE' }))).toBe(
      'SERIES_IN_USE',
    )

    /* The label is still editable, which is the half of the rule that makes the other half
     * usable — a series whose shape is frozen is not one nobody may rename. */
    expect((await numbering.update({ id: invoices.id, label: 'Domestic' })).label).toBe('Domestic')
  })
})
