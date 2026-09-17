/*
 * The lifecycle, against real files in real temporary directories.
 *
 * Nothing here is mocked: real Argon2id, real SQLCipher, real vaults on disk. The whole
 * value of this module is what happens to files, and a test that stubs the filesystem
 * would assert that the code calls the functions it calls.
 *
 * Argon2 runs at the cheapest parameters the security module accepts. Two paths still
 * pay the production profile whatever the tests ask for — `setPassphrase` upgrades a weak
 * slot on purpose — so the tests that change a passphrase or redeem a recovery code carry
 * a longer timeout.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { DbError } from '../db/errors'
import { createQueryBuilder } from '../db/kysely'
import { listAccounts } from '../db/repos/accounts'
import { trialBalance } from '../db/repos/balances'
import { createItem } from '../db/repos/items'
import { postManualEntry } from '../db/repos/journal'
import { recordMovement, setItemStockTracking } from '../db/repos/stock'
import { listUnits } from '../db/repos/units'
import { type Argon2Params, MIN_MEMORY_COST, SecurityError } from '../security'
import { readBackup } from './backup'
import { CompanyError } from './errors'
import { METADATA_KEYS, readMetadata, writeMetadata } from './metadata'
import { CompanyService } from './service'

/** Real Argon2id at the floor. What is under test is the ordering, not the derivation. */
const FAST: Argon2Params = {
  algorithm: 'argon2id',
  memoryCost: MIN_MEMORY_COST,
  timeCost: 1,
  parallelism: 1,
}

const PASSPHRASE = 'a quiet ledger keeps its own counsel'
const NEW_PASSPHRASE = 'nine invoices and a cup of tea'
const DISPLAY_NAME = 'Acme Traders'

/** Long enough for the two paths that pay the production KDF on purpose. */
const SLOW_TEST_MS = 120_000

const MARKER_KEY = 'test.marker'

const directories: string[] = []
const services: CompanyService[] = []

interface Fixture {
  service: CompanyService
  dataDirectory: string
  companyDirectory: string
}

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `coffer-${prefix}-`))
  directories.push(directory)
  return directory
}

async function fixture(): Promise<Fixture> {
  const dataDirectory = await tempDirectory('registry')
  const companyDirectory = await tempDirectory('books')
  const service = new CompanyService({
    dataDirectory,
    kdf: { passphrase: FAST, recovery: FAST },
  })
  services.push(service)
  return { service, dataDirectory, companyDirectory }
}

async function createCompany(
  now: Fixture,
  displayName = DISPLAY_NAME,
  passphrase = PASSPHRASE,
): ReturnType<CompanyService['create']> {
  return now.service.create({
    displayName,
    directoryPath: now.companyDirectory,
    passphrase,
  })
}

/** The stable code of whatever was thrown, or a description of why that question failed. */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (
      error instanceof CompanyError ||
      error instanceof SecurityError ||
      error instanceof DbError
    ) {
      return error.code
    }
    return `unexpected error: ${String(error)}`
  }
  return 'did not throw'
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath)
    return true
  } catch {
    return false
  }
}

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex')
}

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.close().catch(() => undefined)
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
  }
})

describe('create', () => {
  it('writes the database and its vault side by side, and leaves the company open', async () => {
    const now = await fixture()
    const result = await createCompany(now)

    expect(result.company.displayName).toBe(DISPLAY_NAME)
    expect(result.company.filePath).toBe(join(now.companyDirectory, 'Acme-Traders.coffer'))
    expect(result.company.vaultPath).toBe(`${result.company.filePath}.vault`)
    expect(result.company.availability).toBe('ok')
    expect(await exists(result.company.filePath)).toBe(true)
    expect(await exists(result.company.vaultPath)).toBe(true)
    expect(now.service.currentCompany()?.id).toBe(result.company.id)
  })

  it('returns five recovery codes, and never returns them again', async () => {
    const now = await fixture()
    const created = await createCompany(now)

    expect(created.recoveryCodes).toHaveLength(5)
    expect(new Set(created.recoveryCodes).size).toBe(5)
    expect(created.recoveryCodesRemaining).toBe(5)

    await now.service.close()
    const reopened = await now.service.open({ id: created.company.id, passphrase: PASSPHRASE })
    expect(reopened.recoveryCodes).toBeUndefined()
    expect(reopened.recoveryCodesRemaining).toBe(5)
  })

  it('brings the database up to the head of the migration list', async () => {
    const now = await fixture()
    await createCompany(now)
    const database = now.service.requireDatabase()

    const tables = database
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all()
      .map((row) => row.name)

    expect(tables).toContain('schema_migrations')
    expect(tables).toContain('app_metadata')
    expect(readMetadata(database, METADATA_KEYS.format)).toBe('coffer.company')
    expect(readMetadata(database, METADATA_KEYS.displayName)).toBe(DISPLAY_NAME)
  })

  it('accepts a passphrase the strength meter hates — nothing here may block', async () => {
    const now = await fixture()
    const weak = '1234'

    expect(now.service.checkPassphrase(weak).isWeak).toBe(true)
    const created = await createCompany(now, 'Weak Passphrase Co', weak)
    expect(created.company.availability).toBe('ok')
  })

  it('refuses an empty passphrase and an empty name', async () => {
    const now = await fixture()

    expect(await codeOf(() => createCompany(now, DISPLAY_NAME, '   '))).toBe('PASSPHRASE_REQUIRED')
    expect(await codeOf(() => createCompany(now, '  ', PASSPHRASE))).toBe('COMPANY_NAME_REQUIRED')
    expect(await now.service.list()).toEqual([])
  })

  it('refuses to write over an existing company', async () => {
    const now = await fixture()
    await createCompany(now)

    expect(await codeOf(() => createCompany(now))).toBe('COMPANY_FILE_EXISTS')
    expect(await now.service.list()).toHaveLength(1)
  })

  it('leaves nothing half-made when a step fails', async () => {
    const now = await fixture()
    /* A directory where the database file has to go: the vault is written, the database
     * cannot be, and the vault must not survive that. */
    const filePath = join(now.companyDirectory, 'Acme-Traders.coffer')
    await mkdir(filePath)

    const code = await codeOf(() => createCompany(now))

    expect(code).toBe('DB_OPEN_FAILED')
    expect(await exists(`${filePath}.vault`)).toBe(false)
    expect(await now.service.list()).toEqual([])
    expect(now.service.currentCompany()).toBeNull()
  })
})

/*
 * A new company opens to usable books, not to an empty database. Batch 1.1A deliberately
 * left this unwired until the periods existed too, because a chart of accounts with
 * nowhere to post to looks finished and refuses everything.
 */
describe('create sets up the books', () => {
  /** Read straight from the created file, so the assertion is about what is on disk. */
  const countRows = (service: CompanyService, table: string): number =>
    service
      .requireDatabase()
      .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)
      .get()!.c

  it('writes a chart of accounts and two fiscal years of periods', async () => {
    const now = await fixture()
    await createCompany(now)

    expect(countRows(now.service, 'accounts')).toBeGreaterThan(30)
    expect(countRows(now.service, 'account_roles')).toBeGreaterThan(0)
    expect(countRows(now.service, 'accounting_periods')).toBe(24)
  })

  /*
   * The deferral from batch 1.1A, closed. `Duties and Taxes` and `Taxes Recoverable`
   * shipped as empty groups because `TaxRegime` could not yet say what it levied; now it
   * can, and a new company gets an account per component without anyone adding one.
   */
  it('gives the books an account for every tax the regime levies', async () => {
    const now = await fixture()
    await createCompany(now)
    const db = createQueryBuilder(now.service.requireDatabase())

    const accounts = await listAccounts(db)
    const roleOf = (role: string) => accounts.find((account) => account.roles.includes(role))

    for (const component of ['cgst', 'sgst', 'utgst', 'igst']) {
      const output = roleOf(`tax-output-${component}`)
      const input = roleOf(`tax-input-${component}`)

      expect(output, `no output account for ${component}`).toBeDefined()
      expect(input, `no input account for ${component}`).toBeDefined()

      /* Opposite sides of the balance sheet, and never the same account: tax charged is
       * owed, tax paid is reclaimable, and the return asks for each separately. */
      expect(output?.type).toBe('liability')
      expect(input?.type).toBe('asset')
      expect(output?.id).not.toBe(input?.id)
    }
  })

  it('files the tax accounts under the groups that were waiting for them', async () => {
    const now = await fixture()
    await createCompany(now)
    const db = createQueryBuilder(now.service.requireDatabase())

    const accounts = await listAccounts(db)
    const byCode = (code: string) => accounts.find((account) => account.code === code)
    const roleOf = (role: string) => accounts.find((account) => account.roles.includes(role))

    expect(roleOf('tax-output-cgst')?.parentId).toBe(byCode('2200')?.id)
    expect(roleOf('tax-input-cgst')?.parentId).toBe(byCode('1500')?.id)
  })

  it('leaves a company that can post immediately', async () => {
    const now = await fixture()
    await createCompany(now)
    const db = createQueryBuilder(now.service.requireDatabase())

    const accounts = await listAccounts(db)
    const idOf = (code: string) => accounts.find((account) => account.code === code)!.id
    const today = new Date().toISOString().slice(0, 10)

    await postManualEntry(db, {
      date: today,
      narration: 'Owner introduces capital',
      lines: [
        { accountId: idOf('1210'), debit: '100000.00', credit: '0.00' },
        { accountId: idOf('3100'), debit: '0.00', credit: '100000.00' },
      ],
    })

    expect((await trialBalance(db)).balanced).toBe(true)
  })

  /*
   * THE TEST THAT WOULD HAVE CAUGHT THE 0012 BUG, WRITTEN FOR THE TWO THAT FOLLOWED IT.
   *
   * `stock_ledger.warehouse_id` is NOT NULL and nothing called `seedDefaultWarehouse`, so
   * no file the application had ever made could record a single stock movement — the
   * `SERIES_NOT_CONFIGURED` failure exactly, one table over. Nothing in the suite could
   * see it, because every test in `stock.test.ts` creates its own warehouse first, in the
   * same way every issuing test creates its own series first.
   *
   * SO IT GOES THROUGH THE APPLICATION AND NOT THROUGH A FIXTURE, end to end: a real
   * company file made by `create`, an item measured in a unit NOBODY IN THIS TEST
   * CREATED, and a movement that names NO WAREHOUSE. Both of those absences are the
   * assertion. `unitCode` reaches `requireActiveUnit`, which refuses a code these books
   * do not have; the missing `warehouseId` reaches `defaultWarehouseId`, which refuses
   * books with nowhere to keep stock. Either seed missing and this fails by name.
   */
  it('leaves a company that can record a stock movement, which needs a warehouse and a unit', async () => {
    const now = await fixture()
    await createCompany(now)
    const db = createQueryBuilder(now.service.requireDatabase())

    const item = await createItem(db, {
      name: 'Ball bearing 6203',
      kind: 'goods',
      unitCode: 'NOS',
      isPurchased: true,
    })
    expect(item.unitCode).toBe('NOS')

    await setItemStockTracking(db, { itemId: item.id, isStockTracked: true })

    const movement = await recordMovement(db, {
      itemId: item.id,
      kind: 'receipt',
      date: new Date().toISOString().slice(0, 10),
      quantity: '10.000',
      cost: '2500.00',
      sourceType: 'stock-adjustment',
    })

    /* The figures, not merely that it did not throw: a movement that recorded nothing
     * would satisfy an assertion about the absence of an error. */
    expect(movement.after).toMatchObject({ quantity: '10.000', value: '2500.00' })
    expect(movement.closing.unitCost).toBe('250.000000')
  })

  /*
   * And the units on their own, because the movement above would still pass if `NOS` were
   * the only unit seeded. A business's first invoice line has to have something to be
   * measured in, and there is no screen that would have told them the list was empty.
   */
  it('leaves a company with units to measure things in', async () => {
    const now = await fixture()
    await createCompany(now)
    const db = createQueryBuilder(now.service.requireDatabase())

    const units = await listUnits(db)
    expect(units.map((unit) => unit.code)).toContain('KGS')
    expect(units.length).toBeGreaterThan(1)
  })

  it('records which regime the books were set up under', async () => {
    const now = await fixture()
    await createCompany(now)

    expect(readMetadata(now.service.requireDatabase(), METADATA_KEYS.regimeId)).toBe('in')
  })

  it('uses the regime the caller asked for', async () => {
    const now = await fixture()
    await now.service.create({
      displayName: DISPLAY_NAME,
      directoryPath: now.companyDirectory,
      passphrase: PASSPHRASE,
      regimeId: 'in',
    })

    expect(readMetadata(now.service.requireDatabase(), METADATA_KEYS.regimeId)).toBe('in')
  })

  /*
   * Refused rather than quietly defaulted. Falling back would set the company up on the
   * wrong fiscal year, and the periods generated from it are on disk before anyone looks.
   */
  it('refuses a regime this build does not have, and leaves nothing behind', async () => {
    const now = await fixture()
    const code = await codeOf(() =>
      now.service.create({
        displayName: DISPLAY_NAME,
        directoryPath: now.companyDirectory,
        passphrase: PASSPHRASE,
        regimeId: 'atlantis',
      }),
    )

    expect(code).toBe('COMPANY_REGIME_UNKNOWN')
    expect(await exists(join(now.companyDirectory, 'Acme-Traders.coffer'))).toBe(false)
    expect(await now.service.list()).toEqual([])
  })
})

/*
 * The GSTIN box on the create screen asks before any books exist, so this answers from the
 * regime alone and touches no file. It decides nothing: the profile service checks again.
 */
describe('checkRegistration', () => {
  it('names the number the regime’s way for a blank box, and checks nothing', async () => {
    const now = await fixture()

    expect(now.service.checkRegistration({ registrationNumber: '   ' })).toEqual({
      label: 'GSTIN / UIN',
      status: 'blank',
      normalised: null,
      jurisdictionCode: null,
      jurisdictionName: null,
      message: null,
    })
  })

  it('spells a valid number the regime’s way and names the state it encodes', async () => {
    const now = await fixture()

    expect(now.service.checkRegistration({ registrationNumber: ' 33aabcc1234d1zi ' })).toEqual({
      label: 'GSTIN / UIN',
      status: 'valid',
      normalised: '33AABCC1234D1ZI',
      jurisdictionCode: '33',
      jurisdictionName: 'Tamil Nadu',
      message: null,
    })
  })

  it('says why an invalid number is invalid', async () => {
    const now = await fixture()
    const check = now.service.checkRegistration({ registrationNumber: '33AABCC1234D1ZX' })

    expect(check.status).toBe('invalid')
    expect(check.message).not.toBeNull()
    expect(check.normalised).toBeNull()
  })

  it('refuses a regime it does not have, as create does', async () => {
    const now = await fixture()

    expect(
      await codeOf(async () =>
        now.service.checkRegistration({ registrationNumber: '', regimeId: 'xx' }),
      ),
    ).toBe('COMPANY_REGIME_UNKNOWN')
    expect(await now.service.list()).toEqual([])
  })
})

describe('open', () => {
  it('reopens a company and finds what was written to it', async () => {
    const now = await fixture()
    const created = await createCompany(now)
    writeMetadata(now.service.requireDatabase(), MARKER_KEY, 'seventeen invoices')
    await now.service.close()

    expect(now.service.currentDatabase()).toBeNull()

    const reopened = await now.service.open({ id: created.company.id, passphrase: PASSPHRASE })
    expect(reopened.company.id).toBe(created.company.id)
    expect(readMetadata(now.service.requireDatabase(), MARKER_KEY)).toBe('seventeen invoices')
    expect(reopened.company.lastOpenedAt).not.toBeNull()
  })

  it('rejects the wrong passphrase', async () => {
    const now = await fixture()
    const created = await createCompany(now)
    await now.service.close()

    expect(
      await codeOf(() => now.service.open({ id: created.company.id, passphrase: 'not it' })),
    ).toBe('PASSPHRASE_INVALID')
    expect(now.service.currentCompany()).toBeNull()
  })

  it('reports a missing vault as missing keys, never as a decryption failure', async () => {
    const now = await fixture()
    const created = await createCompany(now)
    await now.service.close()
    await rm(created.company.vaultPath)

    const [listed] = await now.service.list()
    expect(listed?.availability).toBe('vault-missing')

    const code = await codeOf(() =>
      now.service.open({ id: created.company.id, passphrase: PASSPHRASE }),
    )
    expect(code).toBe('COMPANY_VAULT_MISSING')

    /* The message has to send the user to a backup, because nothing else can help. */
    await expect(
      now.service.open({ id: created.company.id, passphrase: PASSPHRASE }),
    ).rejects.toThrow(/backup/i)
  })

  it('reports a missing database as a missing file', async () => {
    const now = await fixture()
    const created = await createCompany(now)
    await now.service.close()
    await rm(created.company.filePath)

    const [listed] = await now.service.list()
    expect(listed?.availability).toBe('database-missing')
    expect(
      await codeOf(() => now.service.open({ id: created.company.id, passphrase: PASSPHRASE })),
    ).toBe('COMPANY_DATABASE_MISSING')
  })

  it('reports an unknown company rather than throwing something anonymous', async () => {
    const now = await fixture()
    expect(await codeOf(() => now.service.open({ id: 'nobody', passphrase: PASSPHRASE }))).toBe(
      'COMPANY_NOT_FOUND',
    )
  })

  it('says so when the vault beside a database belongs to another company', async () => {
    const now = await fixture()
    const first = await createCompany(now, 'First Company')
    await now.service.close()
    const second = await createCompany(now, 'Second Company')
    await now.service.close()

    /* The classic way to lose books: copy one company's vault next to another's file. */
    await writeFile(first.company.vaultPath, await readFile(second.company.vaultPath))

    expect(
      await codeOf(() => now.service.open({ id: first.company.id, passphrase: PASSPHRASE })),
    ).toBe('COMPANY_KEYS_MISMATCHED')
  })
})

describe('recover', () => {
  it(
    'spends exactly one code, sets the new passphrase, and refuses the code afterwards',
    async () => {
      const now = await fixture()
      const created = await createCompany(now)
      writeMetadata(now.service.requireDatabase(), MARKER_KEY, 'still here')
      await now.service.close()

      const codes = created.recoveryCodes ?? []
      const [firstCode, secondCode] = codes
      expect(firstCode).toBeDefined()
      expect(secondCode).toBeDefined()

      const recovered = await now.service.recover({
        id: created.company.id,
        recoveryCode: firstCode ?? '',
        newPassphrase: NEW_PASSPHRASE,
      })

      expect(recovered.recoveryCodesRemaining).toBe(4)
      expect(recovered.recoveryCodes).toBeUndefined()
      expect(readMetadata(now.service.requireDatabase(), MARKER_KEY)).toBe('still here')

      /* The spend is on disk, not merely in memory: exactly one slot is burnt. */
      const vault = JSON.parse(await readFile(created.company.vaultPath, 'utf8')) as {
        slots: Array<{ kind: string; wrapped: unknown; usedAt: string | null }>
      }
      const recoverySlots = vault.slots.filter((slot) => slot.kind === 'recovery')
      expect(recoverySlots.filter((slot) => slot.wrapped === null)).toHaveLength(1)
      expect(recoverySlots.filter((slot) => slot.usedAt !== null)).toHaveLength(1)

      await now.service.close()
      expect(
        await codeOf(() =>
          now.service.recover({
            id: created.company.id,
            recoveryCode: firstCode ?? '',
            newPassphrase: 'another one entirely',
          }),
        ),
      ).toBe('RECOVERY_CODE_ALREADY_USED')

      /* The old passphrase is gone and the new one works. */
      expect(
        await codeOf(() => now.service.open({ id: created.company.id, passphrase: PASSPHRASE })),
      ).toBe('PASSPHRASE_INVALID')
      const reopened = await now.service.open({
        id: created.company.id,
        passphrase: NEW_PASSPHRASE,
      })
      expect(reopened.recoveryCodesRemaining).toBe(4)
    },
    SLOW_TEST_MS,
  )

  it(
    'leaves the other four codes working',
    async () => {
      const now = await fixture()
      const created = await createCompany(now)
      await now.service.close()
      const codes = created.recoveryCodes ?? []

      await now.service.recover({
        id: created.company.id,
        recoveryCode: codes[0] ?? '',
        newPassphrase: NEW_PASSPHRASE,
      })
      await now.service.close()

      const second = await now.service.recover({
        id: created.company.id,
        recoveryCode: codes[4] ?? '',
        newPassphrase: 'a third passphrase for the books',
      })
      expect(second.recoveryCodesRemaining).toBe(3)
    },
    SLOW_TEST_MS,
  )

  it('rejects a code that is not a code, and one from another company', async () => {
    const now = await fixture()
    const created = await createCompany(now)
    const other = await now.service.create({
      displayName: 'Other Company',
      directoryPath: now.companyDirectory,
      passphrase: PASSPHRASE,
    })
    await now.service.close()

    expect(
      await codeOf(() =>
        now.service.recover({
          id: created.company.id,
          recoveryCode: 'not-a-code',
          newPassphrase: NEW_PASSPHRASE,
        }),
      ),
    ).toBe('RECOVERY_CODE_MALFORMED')

    expect(
      await codeOf(() =>
        now.service.recover({
          id: created.company.id,
          recoveryCode: other.recoveryCodes?.[0] ?? '',
          newPassphrase: NEW_PASSPHRASE,
        }),
      ),
    ).toBe('RECOVERY_CODE_INVALID')
  })
})

describe('changePassphrase', () => {
  it(
    're-wraps the key without rewriting a single database page',
    async () => {
      const now = await fixture()
      const created = await createCompany(now)
      writeMetadata(now.service.requireDatabase(), MARKER_KEY, 'untouched')
      /* Fold the write-ahead log in, so the comparison is against a settled file. */
      await now.service.backup({ directoryPath: await tempDirectory('backups') })

      const before = await sha256(created.company.filePath)
      await now.service.changePassphrase({
        currentPassphrase: PASSPHRASE,
        newPassphrase: NEW_PASSPHRASE,
      })
      expect(await sha256(created.company.filePath)).toBe(before)

      /* The session survives: the DEK never changed. */
      expect(readMetadata(now.service.requireDatabase(), MARKER_KEY)).toBe('untouched')

      await now.service.close()
      expect(
        await codeOf(() => now.service.open({ id: created.company.id, passphrase: PASSPHRASE })),
      ).toBe('PASSPHRASE_INVALID')

      await now.service.open({ id: created.company.id, passphrase: NEW_PASSPHRASE })
      expect(readMetadata(now.service.requireDatabase(), MARKER_KEY)).toBe('untouched')
    },
    SLOW_TEST_MS,
  )

  it('needs an open company, and the current passphrase', async () => {
    const now = await fixture()
    expect(
      await codeOf(() =>
        now.service.changePassphrase({
          currentPassphrase: PASSPHRASE,
          newPassphrase: NEW_PASSPHRASE,
        }),
      ),
    ).toBe('NO_COMPANY_OPEN')

    await createCompany(now)
    expect(
      await codeOf(() =>
        now.service.changePassphrase({
          currentPassphrase: 'wrong',
          newPassphrase: NEW_PASSPHRASE,
        }),
      ),
    ).toBe('PASSPHRASE_INVALID')
  })
})

describe('replaceRecoveryCodes', () => {
  /*
   * THE SECURITY PROPERTY, IN ONE TEST. Five new codes exist, none of the old five works
   * any more, and the database was not touched on the way through.
   */
  it(
    'issues five that work and kills five that did',
    async () => {
      const now = await fixture()
      const created = await createCompany(now)
      writeMetadata(now.service.requireDatabase(), MARKER_KEY, 'untouched')
      const old = created.recoveryCodes ?? []
      expect(old).toHaveLength(5)

      const issued = await now.service.replaceRecoveryCodes({ passphrase: PASSPHRASE })

      expect(issued.recoveryCodes).toHaveLength(5)
      expect(issued.recoveryCodesRemaining).toBe(5)
      /* Not one of them is a code that was on the old sheet. */
      expect(issued.recoveryCodes.filter((code) => old.includes(code))).toEqual([])
      /* The books are the books: no page was rewritten, and the session still holds. */
      expect(readMetadata(now.service.requireDatabase(), MARKER_KEY)).toBe('untouched')

      await now.service.close()
      expect(
        await codeOf(() =>
          now.service.recover({
            id: created.company.id,
            recoveryCode: old[0] ?? '',
            newPassphrase: NEW_PASSPHRASE,
          }),
        ),
      ).toBe('RECOVERY_CODE_INVALID')

      /* And a new one opens the books, which is the other half of the claim. */
      const recovered = await now.service.recover({
        id: created.company.id,
        recoveryCode: issued.recoveryCodes[2] ?? '',
        newPassphrase: NEW_PASSPHRASE,
      })
      expect(recovered.recoveryCodesRemaining).toBe(4)
    },
    SLOW_TEST_MS,
  )

  /*
   * A WRONG PASSPHRASE ISSUES NOTHING. Not a partial set, not a vault with the old codes
   * removed — the old sheet is exactly as good after a failed attempt as before it.
   */
  it(
    'issues nothing on a wrong passphrase, and leaves the old codes working',
    async () => {
      const now = await fixture()
      const created = await createCompany(now)
      const old = created.recoveryCodes ?? []
      const before = await sha256(created.company.vaultPath)

      expect(
        await codeOf(() => now.service.replaceRecoveryCodes({ passphrase: 'not the passphrase' })),
      ).toBe('PASSPHRASE_INVALID')
      expect(await sha256(created.company.vaultPath)).toBe(before)

      await now.service.close()
      const recovered = await now.service.recover({
        id: created.company.id,
        recoveryCode: old[0] ?? '',
        newPassphrase: NEW_PASSPHRASE,
      })
      expect(recovered.recoveryCodesRemaining).toBe(4)
    },
    SLOW_TEST_MS,
  )

  it('refuses an empty passphrase, and refuses when no company is open', async () => {
    const now = await fixture()
    expect(await codeOf(() => now.service.replaceRecoveryCodes({ passphrase: PASSPHRASE }))).toBe(
      'NO_COMPANY_OPEN',
    )

    await createCompany(now)
    expect(await codeOf(() => now.service.replaceRecoveryCodes({ passphrase: '' }))).toBe(
      'PASSPHRASE_REQUIRED',
    )
  })

  /*
   * ISSUED ONCE. The codes are in the answer and nowhere else: not in the vault (which
   * keeps one-way verifiers), and not in anything the service will hand out later.
   */
  it('keeps no readable copy of what it issued', async () => {
    const now = await fixture()
    const created = await createCompany(now)

    const issued = await now.service.replaceRecoveryCodes({ passphrase: PASSPHRASE })

    const vaultText = await readFile(created.company.vaultPath, 'utf8')
    for (const code of issued.recoveryCodes) {
      expect(vaultText).not.toContain(code)
      expect(vaultText).not.toContain(code.replaceAll('-', ''))
    }
    const reopened = await now.service.list()
    expect(JSON.stringify(reopened)).not.toContain(issued.recoveryCodes[0] ?? 'nothing')
  })
})

describe('what the registry remembers about backups', () => {
  /*
   * WHY THE REGISTRY AND NOT THE COMPANY FILE. A backup is written FROM the database, so
   * a record kept inside it would say "backed up" in the copy as well as the original,
   * and could not be read at all while the company is locked — which is exactly when a
   * reminder is worth showing.
   */
  it('remembers the archive it just wrote, and hands the company back with it', async () => {
    const now = await fixture()
    await createCompany(now)

    const backupDirectory = await tempDirectory('backups')
    const result = await now.service.backup({ directoryPath: backupDirectory })

    expect(result.company.lastBackup).toEqual({
      at: result.createdAt,
      path: result.archivePath,
      sizeBytes: result.sizeBytes,
    })

    /* And it is in the list, so a screen drawn after a restart says the same thing. */
    const listed = await now.service.list()
    expect(listed[0]?.lastBackup?.path).toBe(result.archivePath)
  })

  it('replaces the record rather than keeping the oldest', async () => {
    const now = await fixture()
    await createCompany(now)
    const backupDirectory = await tempDirectory('backups')

    const first = await now.service.backup({ directoryPath: backupDirectory })
    const second = await now.service.backup({ directoryPath: backupDirectory })

    expect(first.archivePath).not.toBe(second.archivePath)
    expect((await now.service.list())[0]?.lastBackup?.path).toBe(second.archivePath)
  })

  it('says a new company has never been backed up, and reminds by default', async () => {
    const now = await fixture()
    const created = await createCompany(now)

    expect(created.company.lastBackup).toBeNull()
    /* On for a company nobody has been asked about: the answer somebody who has not
     * thought about backups yet needs. */
    expect(created.company.remindsAboutBackups).toBe(true)
  })

  it('turns the reminder off and on, and remembers which', async () => {
    const now = await fixture()
    const created = await createCompany(now)
    const id = created.company.id

    expect((await now.service.setBackupReminder({ id, isOn: false })).remindsAboutBackups).toBe(
      false,
    )
    expect((await now.service.list())[0]?.remindsAboutBackups).toBe(false)

    expect((await now.service.setBackupReminder({ id, isOn: true })).remindsAboutBackups).toBe(true)
  })

  it('refuses a company it has never heard of', async () => {
    const now = await fixture()
    expect(await codeOf(() => now.service.setBackupReminder({ id: 'nobody', isOn: false }))).toBe(
      'COMPANY_NOT_FOUND',
    )
  })
})

describe('backup and restore', () => {
  it('writes one archive holding both files, and restores it to a working company', async () => {
    const now = await fixture()
    const created = await createCompany(now)
    writeMetadata(now.service.requireDatabase(), MARKER_KEY, 'the books survived')

    const backupDirectory = await tempDirectory('backups')
    const result = await now.service.backup({ directoryPath: backupDirectory })

    expect(result.archivePath.endsWith('.coffer-backup.zip')).toBe(true)
    expect(result.sizeBytes).toBeGreaterThan(0)
    expect(await readdir(backupDirectory)).toHaveLength(1)

    const archive = await readBackup(result.archivePath)
    expect(archive.manifest.displayName).toBe(DISPLAY_NAME)
    expect(archive.manifest.database.fileName).toBe('Acme-Traders.coffer')
    expect(archive.manifest.vault.fileName).toBe('Acme-Traders.coffer.vault')

    await now.service.close()
    const restoreDirectory = await tempDirectory('restored')
    const restored = await now.service.restore({
      archivePath: result.archivePath,
      directoryPath: restoreDirectory,
    })

    expect(restored.availability).toBe('ok')
    expect(restored.filePath).toBe(join(restoreDirectory, 'Acme-Traders.coffer'))
    expect(restored.id).not.toBe(created.company.id)

    await now.service.open({ id: restored.id, passphrase: PASSPHRASE })
    expect(readMetadata(now.service.requireDatabase(), MARKER_KEY)).toBe('the books survived')
  })

  it('never overwrites a company that is already there', async () => {
    const now = await fixture()
    await createCompany(now)
    const backupDirectory = await tempDirectory('backups')
    const result = await now.service.backup({ directoryPath: backupDirectory })

    expect(
      await codeOf(() =>
        now.service.restore({
          archivePath: result.archivePath,
          directoryPath: now.companyDirectory,
        }),
      ),
    ).toBe('COMPANY_FILE_EXISTS')
  })

  it('never writes two backups to the same name', async () => {
    const now = await fixture()
    await createCompany(now)
    const backupDirectory = await tempDirectory('backups')

    const first = await now.service.backup({ directoryPath: backupDirectory })
    const second = await now.service.backup({ directoryPath: backupDirectory })

    expect(second.archivePath).not.toBe(first.archivePath)
    expect(await readdir(backupDirectory)).toHaveLength(2)
  })

  it('refuses a damaged archive before writing anything', async () => {
    const now = await fixture()
    await createCompany(now)
    const backupDirectory = await tempDirectory('backups')
    const result = await now.service.backup({ directoryPath: backupDirectory })

    /* Flip a byte in the middle of the archive: the manifest hashes catch it. */
    const bytes = await readFile(result.archivePath)
    const middle = Math.floor(bytes.length / 2)
    bytes[middle] = (bytes[middle] ?? 0) ^ 0xff
    await writeFile(result.archivePath, bytes)

    const restoreDirectory = await tempDirectory('restored')
    expect(
      await codeOf(() =>
        now.service.restore({
          archivePath: result.archivePath,
          directoryPath: restoreDirectory,
        }),
      ),
    ).toBe('BACKUP_ARCHIVE_INVALID')
    expect(await readdir(restoreDirectory)).toEqual([])
  })

  it('needs an open company to back one up', async () => {
    const now = await fixture()
    expect(await codeOf(() => now.service.backup({ directoryPath: now.companyDirectory }))).toBe(
      'NO_COMPANY_OPEN',
    )
  })
})

describe('the list', () => {
  it('forgets a company without deleting anything', async () => {
    const now = await fixture()
    const created = await createCompany(now)

    await now.service.forget(created.company.id)

    expect(await now.service.list()).toEqual([])
    expect(now.service.currentCompany()).toBeNull()
    expect(await exists(created.company.filePath)).toBe(true)
    expect(await exists(created.company.vaultPath)).toBe(true)
  })

  it('adds an existing file back, and does not add it twice', async () => {
    const now = await fixture()
    const created = await createCompany(now)
    await now.service.forget(created.company.id)

    const added = await now.service.addExisting(created.company.filePath)
    expect(added.filePath).toBe(created.company.filePath)
    expect(added.availability).toBe('ok')
    expect(added.displayName).toBe('Acme Traders')

    const again = await now.service.addExisting(created.company.filePath)
    expect(again.id).toBe(added.id)
    expect(await now.service.list()).toHaveLength(1)

    /* And it opens, which is the point of adding it. */
    await now.service.open({ id: added.id, passphrase: PASSPHRASE })
    expect(now.service.currentCompany()?.id).toBe(added.id)
  })

  it('adds a file whose vault is missing, so the list can say what is wrong', async () => {
    const now = await fixture()
    const created = await createCompany(now)
    await now.service.close()
    await now.service.forget(created.company.id)
    await rm(created.company.vaultPath)

    const added = await now.service.addExisting(created.company.filePath)
    expect(added.availability).toBe('vault-missing')
  })

  it('refuses to add a file that is not there', async () => {
    const now = await fixture()
    expect(
      await codeOf(() => now.service.addExisting(join(now.companyDirectory, 'nothing.coffer'))),
    ).toBe('COMPANY_DATABASE_MISSING')
  })

  it('renames in the list and in the file, but not on disk', async () => {
    const now = await fixture()
    const created = await createCompany(now)

    const renamed = await now.service.rename(created.company.id, '  Acme Trading Company  ')

    expect(renamed.displayName).toBe('Acme Trading Company')
    expect(renamed.filePath).toBe(created.company.filePath)
    expect(readMetadata(now.service.requireDatabase(), METADATA_KEYS.displayName)).toBe(
      'Acme Trading Company',
    )
    expect(await codeOf(() => now.service.rename('nobody', 'Something'))).toBe('COMPANY_NOT_FOUND')
  })

  it('closes cleanly, twice, and when nothing is open', async () => {
    const now = await fixture()
    await now.service.close()
    await createCompany(now)
    await now.service.close()
    await now.service.close()
    expect(now.service.currentDatabase()).toBeNull()
    expect(await codeOf(async () => now.service.requireDatabase())).toBe('NO_COMPANY_OPEN')
  })
})

describe('a damaged registry', () => {
  it('degrades to an empty list rather than failing to start', async () => {
    const now = await fixture()
    await createCompany(now)
    await now.service.close()

    const registryPath = await now.service.registryFilePath()
    await writeFile(registryPath, '{ this is not json', 'utf8')

    expect(await now.service.list()).toEqual([])
    const status = await now.service.registryStatus()
    expect(status.isHealthy).toBe(false)
    expect(status.problem).toMatch(/companies/i)
  })

  it('sets the damaged file aside instead of overwriting it', async () => {
    const now = await fixture()
    const registryPath = await now.service.registryFilePath()
    await mkdir(now.dataDirectory, { recursive: true })
    await writeFile(registryPath, 'nonsense', 'utf8')

    expect(await now.service.list()).toEqual([])
    await createCompany(now)

    const names = await readdir(now.dataDirectory)
    expect(names.some((name) => name.includes('.corrupt-'))).toBe(true)
    expect(await now.service.list()).toHaveLength(1)
  })

  it('keeps the entries it can read and drops the ones it cannot', async () => {
    const now = await fixture()
    const created = await createCompany(now)
    await now.service.close()

    const registryPath = await now.service.registryFilePath()
    const document = JSON.parse(await readFile(registryPath, 'utf8')) as {
      companies: unknown[]
    }
    document.companies.push({ id: '', filePath: 42 })
    await writeFile(registryPath, JSON.stringify(document), 'utf8')

    const listed = await now.service.list()
    expect(listed.map((company) => company.id)).toEqual([created.company.id])
    expect((await now.service.registryStatus()).droppedEntries).toBe(1)
  })
})
