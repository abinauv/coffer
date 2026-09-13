/*
 * The Zoho importer, end to end, against a golden export held as JSON.
 *
 * The whole file is written against one claim: an import is a PROPOSAL that can be looked
 * at, argued with, and re-run. So the assertions are about ROWS — every line of every
 * document, in order, with the file rows each came from — and not about counts and totals.
 * A total that balances cannot see a dropped row, and a count cannot see two rows swapped
 * (CONVENTIONS §1.10).
 *
 * The fixture's own header says how it is ordered and why. In short: the invoice file
 * introduces the later, higher-numbered document first and interleaves its three rows with
 * another document's two, so an importer that assumed rows were contiguous, or that sorted
 * anything on the way through, disagrees with the expected output rather than passing by
 * luck.
 */

import { describe, expect, it } from 'vitest'

import { ImportError, ledgerEntryFor, readinessOf, remapLedgers, summariseBatch } from '../model'
import type { BatchIssue, ChartAccountRef, ImportBatch, LedgerResolution } from '../model'
import {
  importZohoBooks,
  zohoColumnMap,
  zohoEntityDefinition,
  type ZohoEntity,
  type ZohoFile,
} from './index'

import fixtureJson from './__fixtures__/zoho-export.json'

interface FileFixture {
  entity: string
  csv: string
  why: string
}

interface CaseFixture {
  why: string
  entity: string
  name: string
  csv: string
}

const fixture = fixtureJson as unknown as {
  why: string
  export: Record<string, FileFixture>
  chart: ChartAccountRef[]
  expected: Record<string, unknown[]>
  cases: Record<string, CaseFixture>
}

const files: ZohoFile[] = Object.entries(fixture.export).map(([name, file]) => ({
  name,
  entity: file.entity as ZohoEntity,
  text: file.csv,
}))

const expected = (what: string): unknown[] => {
  const found = fixture.expected[what]
  if (found === undefined) {
    throw new Error(`No expectation called ${what}`)
  }
  return found
}

const one = (name: string): CaseFixture => {
  const found = fixture.cases[name]
  if (found === undefined) {
    throw new Error(`No fixture case called ${name}`)
  }
  return found
}

const caseBatch = (
  name: string,
  options: Parameters<typeof importZohoBooks>[1] = {},
): ImportBatch => {
  const fix = one(name)
  return importZohoBooks(
    [{ name: fix.name, entity: fix.entity as ZohoEntity, text: fix.csv }],
    options,
  )
}

const codes = (issues: readonly BatchIssue[]): string[] => issues.map((issue) => issue.code)

const withCode = (issues: readonly BatchIssue[], code: string): readonly BatchIssue[] =>
  issues.filter((issue) => issue.code === code)

/** What a resolution points at, flattened so a fixture can state it in one field. */
const targetOf = (resolution: LedgerResolution): string | null => {
  switch (resolution.kind) {
    case 'role':
      return resolution.role
    case 'code':
      return resolution.code
    case 'new':
      return resolution.accountSourceId
    default:
      return null
  }
}

const withoutFingerprint = <T extends { fingerprint: string }>(rows: readonly T[]): unknown[] =>
  rows.map(({ fingerprint: _fingerprint, ...rest }) => rest)

const batch = importZohoBooks(files, {
  openingBalanceDate: '2027-04-01',
  ledgers: { chart: fixture.chart },
})

describe('the whole export', () => {
  it('produces the documents in first-appearance order, with every line and every row', () => {
    expect(withoutFingerprint(batch.documents)).toEqual(expected('documents'))
  })

  it('is asserted against an order that disagrees with date order and with number order', () => {
    /* Without this, the assertion above would pass just as happily against an importer
     * that sorted, and nothing would say which property was being tested. */
    const dates = batch.documents.map((document) => document.date)
    const numbers = batch.documents.map((document) => document.number)
    expect(dates).not.toEqual([...dates].sort())
    expect(numbers).not.toEqual([...numbers].sort())
  })

  it('assembles a three-line invoice out of rows 1, 3 and 5 of the file', () => {
    /* The rows are interleaved with another document's, so an importer that accumulated
     * until the number changed would produce two INV-2027-014s and lose the first. */
    const invoice = batch.documents[0]
    expect(invoice?.number).toBe('INV-2027-014')
    expect(invoice?.provenance.map((row) => row.rowNumber)).toEqual([1, 3, 5])
    expect(invoice?.lines.map((line) => line.lineNumber)).toEqual([1, 2, 3])
    expect(invoice?.lines.map((line) => line.provenance[0]?.rowNumber)).toEqual([1, 3, 5])
  })

  it('numbers the lines 1..n in file order, not by the row they came from', () => {
    expect(batch.documents[1]?.provenance.map((row) => row.rowNumber)).toEqual([2, 4])
    expect(batch.documents[1]?.lines.map((line) => line.lineNumber)).toEqual([1, 2])
  })

  it('produces the vouchers, with a two-invoice payment split across non-adjacent rows', () => {
    expect(withoutFingerprint(batch.receipts)).toEqual(expected('receipts'))
  })

  it('produces the parties, joining a firm’s two contact-person rows into one', () => {
    expect(batch.parties).toEqual(expected('parties'))
  })

  it('produces the items, the accounts, the units and the opening balances', () => {
    expect(batch.items).toEqual(expected('items'))
    expect(batch.accounts).toEqual(expected('accounts'))
    expect(batch.units).toEqual(expected('units'))
    expect(batch.openingBalances).toEqual(expected('openingBalances'))
  })

  it('records what it read from each file, headings included', () => {
    expect(
      batch.source.files.map((file) => [
        file.name,
        file.rowsRead,
        file.rowsStaged,
        file.dateFormat,
      ]),
    ).toEqual([
      ['Invoice.csv', 5, 5, 'DD/MM/YYYY'],
      ['Contacts.csv', 5, 5, null],
      ['Item.csv', 2, 2, null],
      ['Chart_of_Accounts.csv', 3, 3, null],
      ['Bill.csv', 2, 2, 'DD/MM/YYYY'],
      ['Customer_Payment.csv', 4, 4, 'DD/MM/YYYY'],
    ])
  })

  it('keeps the headings AS WRITTEN, which is how a wrong column guess is diagnosed', () => {
    const invoice = batch.source.files[0]
    expect(invoice?.headings).toContain('Item Tax %')
    expect(invoice?.headings).toContain('Exchange Rate')
  })

  it('counts what it staged', () => {
    expect(summariseBatch(batch)).toMatchObject({
      units: 3,
      accounts: 2,
      parties: 3,
      items: 2,
      openingBalances: 1,
      documents: 3,
      documentLines: 7,
      receipts: 3,
      allocations: 4,
      ledgers: 8,
    })
  })
})

describe('the date format is surveyed, not assumed', () => {
  it('settles the invoice file on DD/MM/YYYY because one day is the 19th', () => {
    expect(batch.documents[0]?.date).toBe('2027-07-19')
    expect(batch.documents[0]?.dueDate).toBe('2027-08-18')
  })

  it('refuses a file whose two readings disagree, and reads no row of it', () => {
    const refused = caseBatch('datesDisagree')
    expect(refused.documents).toEqual([])
    const reported = withCode(refused.issues, 'DATE_FORMAT_AMBIGUOUS')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.severity).toBe('error')
    expect(reported[0]?.message).toContain('DD/MM/YYYY')
    expect(reported[0]?.message).toContain('MM/DD/YYYY')
    /* And NO row errors. Without this the assertion above cannot tell "refused" from
     * "read with a format that happened to fail on every row" — both leave `documents`
     * empty, and only one of them is one sentence rather than eight hundred. */
    expect(withCode(refused.issues, 'INVALID_DATE')).toEqual([])
    expect(refused.source.files[0]?.rowsStaged).toBe(0)
  })

  it('reads a file whose two readings AGREE, and says the file could not prove itself', () => {
    const read = caseBatch('datesAgree')
    expect(read.documents.map((document) => document.date)).toEqual(['2027-05-05', '2027-06-06'])
    const reported = withCode(read.issues, 'DATE_FORMAT_AMBIGUOUS')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.severity).toBe('warning')
  })

  it('refuses a file no format reads, in one sentence rather than one per row', () => {
    const refused = caseBatch('datesUnreadable')
    expect(refused.documents).toEqual([])
    expect(withCode(refused.issues, 'DATE_FORMAT_UNREADABLE')).toHaveLength(1)
    expect(withCode(refused.issues, 'INVALID_DATE')).toEqual([])
  })

  it('takes the caller’s word when they name a format', () => {
    const stated = caseBatch('datesDisagree', { dateFormat: 'MM/DD/YYYY' })
    expect(stated.documents.map((document) => document.date)).toEqual(['2027-05-06', '2027-07-08'])
    expect(withCode(stated.issues, 'DATE_FORMAT_AMBIGUOUS')).toEqual([])
  })
})

describe('the chart of accounts, which is the hard part', () => {
  const entry = (ledger: string) => ledgerEntryFor(batch.ledgers, ledger)

  it('maps every ledger the import mentions, in the order it met them', () => {
    expect(
      batch.ledgers.map((row) => ({
        ledger: row.ledger,
        key: row.key,
        usageCount: row.usageCount,
        kind: row.resolution.kind,
        target: targetOf(row.resolution),
      })),
    ).toEqual(expected('ledgers'))
  })

  it('reads the Indian-accounting names onto roles', () => {
    expect(entry('Sales Accounts')?.resolution).toMatchObject({ kind: 'role', role: 'sales' })
    expect(entry('Purchase Accounts')?.resolution).toMatchObject({
      kind: 'role',
      role: 'purchases',
    })
  })

  it('reaches an account the company already has, by name', () => {
    expect(entry('Printing and Stationery')?.resolution).toMatchObject({
      kind: 'code',
      code: '6650',
    })
  })

  it('reaches an account the export itself brings', () => {
    expect(entry('Consultancy Income')?.resolution).toMatchObject({
      kind: 'new',
      accountSourceId: '4150',
    })
  })

  it('counts a ledger used by an item and by a document line once, with both usages', () => {
    expect(entry('Sales')?.usageCount).toBe(3)
  })
})

describe('an account type Coffer does not know', () => {
  it('does not create the account, and says so', () => {
    expect(batch.accounts.map((account) => account.name)).not.toContain('Delivery Charges')
    const reported = withCode(batch.issues, 'UNKNOWN_ACCOUNT_TYPE')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.message).toContain('Shipping Revenue')
    expect(reported[0]?.file).toBe('Chart_of_Accounts.csv')
    /* A warning, not an error: an account nobody references is not a reason to stop an
     * import. What blocks is the LEDGER that named it, in the next test. */
    expect(reported[0]?.severity).toBe('warning')
  })

  it('leaves the ledger that named it UNPLACED, which is the whole chain', () => {
    expect(ledgerEntryFor(batch.ledgers, 'Delivery Charges')?.resolution.kind).toBe('unmapped')
  })

  it('blocks the write and names what to fix, without losing the other 800 rows', () => {
    const readiness = readinessOf(batch)
    expect(readiness.isReadyToWrite).toBe(false)
    expect(readiness.unmappedLedgers).toEqual(['Delivery Charges'])
    /* The rest of the import is intact — which is the property that matters. */
    expect(batch.documents).toHaveLength(3)
    expect(batch.documents[0]?.lines).toHaveLength(3)
  })

  it('is fixed by one override, without re-reading a single file', () => {
    const fixed = remapLedgers(batch, {
      chart: fixture.chart,
      newAccounts: batch.accounts,
      overrides: { 'Delivery Charges': { kind: 'role', role: 'sales' } },
    })
    expect(readinessOf(fixed).isReadyToWrite).toBe(true)
    expect(fixed.documents).toEqual(batch.documents)
  })
})

describe('parties', () => {
  it('joins two contact-person rows into one party, non-contiguously', () => {
    const bharat = batch.parties[1]
    expect(bharat?.name).toBe('Bharat Metals Pvt Ltd')
    expect(bharat?.provenance.map((row) => row.rowNumber)).toEqual([2, 4])
  })

  it('leaves a field the two rows disagree about EMPTY, and reports it', () => {
    const nilgiri = batch.parties[2]
    expect(nilgiri?.name).toBe('Nilgiri Traders')
    expect(nilgiri?.email).toBeUndefined()
    const reported = withCode(batch.issues, 'CONFLICTING_HEADER')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.severity).toBe('warning')
    expect(reported[0]?.message).toContain('priya@nilgiri.example')
    expect(reported[0]?.message).toContain('ravi@nilgiri.example')
  })

  it('works out from the transactions what the contacts file did not say', () => {
    expect(batch.parties[2]?.isCustomer).toBe(true)
    expect(withCode(batch.issues, 'UNKNOWN_PARTY_ROLE')).toHaveLength(1)
  })

  it('reads a payment-terms value that is not a number of days as no terms at all', () => {
    expect(batch.parties[0]?.paymentTermsDays).toBeUndefined()
    const reported = withCode(batch.issues, 'INVALID_NUMBER')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.message).toContain('Due on Receipt')
  })

  it('stages a party a transaction names and the contacts file does not', () => {
    const orphan = importZohoBooks([
      { name: 'Invoice.csv', entity: 'invoices', text: one('datesAgree').csv },
    ])
    expect(orphan.parties.map((party) => [party.name, party.isCustomer, party.isVendor])).toEqual([
      ['Bharat Metals Pvt Ltd', true, false],
      ['Nilgiri Traders', true, false],
    ])
    expect(codes(withCode(orphan.issues, 'PARTY_NOT_FOUND'))).toHaveLength(2)
  })
})

describe('opening balances', () => {
  it('are their own collection, against a ROLE, and never a document', () => {
    expect(batch.openingBalances[0]?.ledger).toEqual({
      kind: 'role',
      role: 'accounts-payable',
    })
    expect(batch.documents.map((document) => document.number)).not.toContain(
      'opening:4207000000098009',
    )
  })

  it('take the date from the caller, because the export carries none', () => {
    expect(batch.openingBalanceDate).toBe('2027-04-01')
  })

  it('refuse to be written with no date, rather than choosing one', () => {
    const undated = importZohoBooks(files, { ledgers: { chart: fixture.chart } })
    expect(undated.openingBalances).toHaveLength(1)
    const reported = undated.issues.filter(
      (issue) => issue.code === 'MISSING_VALUE' && issue.message.includes('opening balances'),
    )
    expect(reported).toHaveLength(1)
    expect(reported[0]?.severity).toBe('error')
  })

  it('are not staged for a zero balance, nor for an absent one', () => {
    /* Two halves of one condition, each with the row that only it excludes. */
    const openings = caseBatch('zeroOpeningBalance', { openingBalanceDate: '2027-04-01' })
    expect(openings.parties.map((party) => party.name)).toEqual([
      'Zero Balance Traders',
      'No Balance Traders',
      'Real Balance Traders',
    ])
    expect(openings.openingBalances.map((opening) => [opening.partyName, opening.amount])).toEqual([
      ['Real Balance Traders', '1200.00'],
    ])
  })
})

describe('items', () => {
  it('reports a product type it does not know and still brings the item in', () => {
    const reported = withCode(batch.issues, 'UNKNOWN_ITEM_KIND')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.message).toContain('digital-service')
    expect(batch.items[1]?.name).toBe('Consulting')
    expect(batch.items[1]?.kind).toBe('goods')
  })

  it('decides which side an item is offered on, one row per branch', () => {
    const sides = caseBatch('itemSides')
    expect(sides.items.map((item) => [item.name, item.isSold, item.isPurchased])).toEqual([
      ['Purchase Only', false, true],
      ['Neither Side', true, true],
      ['Sale Only', true, false],
    ])
  })
})

describe('rows that cannot be placed do not abort the file', () => {
  it('drops one document whose rows disagree about its date, and keeps the other', () => {
    const conflicted = caseBatch('conflictingDate')
    expect(conflicted.documents.map((document) => document.number)).toEqual(['INV-G'])
    const reported = withCode(conflicted.issues, 'CONFLICTING_HEADER')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.severity).toBe('error')
    expect(reported[0]?.message).toContain('2027-09-13')
    expect(reported[0]?.message).toContain('2027-09-15')
  })

  it('keeps a payment whose rows say how much was applied but not to what', () => {
    const orphans = caseBatch('orphanAllocation')
    const payment = orphans.receipts[0]
    expect(payment?.number).toBe('CP-00031')
    expect(payment?.amount).toBe('900.00')
    expect(payment?.allocations).toEqual([
      {
        documentNumber: 'INV-2027-003',
        amount: '500.00',
        provenance: [{ file: 'Orphans.csv', line: 4, rowNumber: 3 }],
      },
    ])
    expect(codes(orphans.issues)).toContain('ROW_NOT_GROUPED')
    expect(
      orphans.issues.filter((issue) => issue.code === 'MISSING_VALUE' && issue.rowNumber === 2),
    ).toHaveLength(1)
  })

  it('stages a line with no name and no description, and says which line', () => {
    const nameless = caseBatch('missingDescription')
    expect(nameless.documents[0]?.lines).toEqual([
      {
        lineNumber: 1,
        description: '',
        quantity: '3.000',
        unitPrice: '50.00',
        discount: '0.00',
        ledger: 'Sales',
        provenance: [{ file: 'NoDescription.csv', line: 2, rowNumber: 1 }],
      },
    ])
    expect(codes(withCode(nameless.issues, 'MISSING_VALUE'))).toHaveLength(1)
  })

  it('reads a row that carries a total and no line as header values only', () => {
    const headerRow = caseBatch('headerOnlyRow')
    const invoice = headerRow.documents[0]
    expect(invoice?.statedTotal).toBe('1000.00')
    expect(invoice?.provenance.map((row) => row.rowNumber)).toEqual([1, 2])
    expect(invoice?.lines.map((line) => [line.lineNumber, line.description])).toEqual([
      [1, 'Widget'],
    ])
  })

  it('warns that a payment settles a document this export does not contain', () => {
    const reported = withCode(batch.issues, 'ALLOCATION_TARGET_MISSING')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.severity).toBe('warning')
    expect(reported[0]?.value).toBe('INV-2026-900')
    /* The receipt itself survives with its allocation intact — the invoice may already be
     * in Coffer, or be from before the cutover. */
    expect(batch.receipts[2]?.allocations).toHaveLength(1)
  })
})

describe('the column mapping is declarative and correctable', () => {
  it('refuses a file that lacks the one column it cannot do without, naming the column', () => {
    const renamed = caseBatch('renamedNumberColumn')
    expect(renamed.documents).toEqual([])
    const reported = withCode(renamed.issues, 'MISSING_COLUMN')
    const named = reported.filter((issue) => issue.field === 'number')
    expect(named).toHaveLength(1)
    expect(named[0]?.severity).toBe('error')
    expect(named[0]?.message).toContain('Invoice Number')
  })

  it('refuses a payment file with no number column either, naming that column', () => {
    /* The voucher half of the same rule. Without it, making the voucher number optional
     * changes no result any test can see: every payment fixture has the column. */
    const unnumbered = caseBatch('voucherWithoutNumberColumn')
    expect(unnumbered.receipts).toEqual([])
    const named = withCode(unnumbered.issues, 'MISSING_COLUMN').filter(
      (issue) => issue.field === 'number',
    )
    expect(named).toHaveLength(1)
    expect(named[0]?.severity).toBe('error')
    expect(named[0]?.message).toContain('Payment Number')
  })

  it('reads the same file once the caller corrects the heading', () => {
    const corrected = caseBatch('renamedNumberColumn', {
      columns: { invoices: { number: ['Invoice #'] } },
    })
    expect(corrected.documents.map((document) => document.number)).toEqual(['INV-H'])
  })

  it('reports a column no field claims rather than dropping it in silence', () => {
    const reported = withCode(batch.issues, 'UNMAPPED_COLUMN').filter(
      (issue) => issue.file === 'Invoice.csv',
    )
    expect(reported.map((issue) => issue.heading)).toEqual(['Exchange Rate'])
  })

  it('reports two headings that could both be one field, and reads neither', () => {
    const twoPrices = caseBatch('ambiguousPriceColumn')
    const reported = withCode(twoPrices.issues, 'AMBIGUOUS_COLUMN')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.field).toBe('unitPrice')
    /* Read, not refused: the price is optional, so the bill still arrives and the user is
     * told which column to remove. */
    expect(twoPrices.documents[0]?.lines[0]?.unitPrice).toBe('0.00')
  })

  it('throws when a correction names a field the entity does not have', () => {
    expect(() => zohoColumnMap('invoices', 'YYYY-MM-DD', { invoices: { invioce: ['X'] } })).toThrow(
      ImportError,
    )
  })

  it('refuses an entity it has no reader for, rather than returning nothing', () => {
    /* Reachable only from a cast, which is exactly what an entity arriving over IPC or out
     * of a saved mapping is. A test has to supply it, or the guard is a line nothing can
     * exercise (CONVENTIONS §6). */
    try {
      zohoEntityDefinition('ledgers' as ZohoEntity)
      expect.unreachable('an unknown entity must be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(ImportError)
      expect((error as ImportError).code).toBe('IMPORT_ENTITY_UNKNOWN')
    }
  })

  it('throws when a correction names no columns at all', () => {
    expect(() => zohoColumnMap('invoices', 'YYYY-MM-DD', { invoices: { number: [] } })).toThrow(
      ImportError,
    )
  })
})

describe('re-running an import', () => {
  it('produces the same batch, fingerprints and all', () => {
    const again = importZohoBooks(files, {
      openingBalanceDate: '2027-04-01',
      ledgers: { chart: fixture.chart },
    })
    expect(again.documents.map((document) => document.fingerprint)).toEqual(
      batch.documents.map((document) => document.fingerprint),
    )
    expect(again).toEqual(batch)
  })

  it('does not collapse two genuinely identical payments into one', () => {
    const twins = caseBatch('identicalPayments')
    expect(twins.receipts.map((receipt) => receipt.number)).toEqual(['CP-00041', 'CP-00042'])
    expect(twins.receipts[0]?.fingerprint).toBe(twins.receipts[1]?.fingerprint)
    const reported = withCode(twins.issues, 'REPEATED_TRANSACTION')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.severity).toBe('warning')
    expect(reported[0]?.message).toContain('two real payments')
  })

  it('keeps the golden export’s two identical payments, and names both of them', () => {
    /* CP-00021 and CP-00022 are the same customer, the same day, the same amount and no
     * bank reference — so they fingerprint identically and are still two payments. */
    expect(batch.receipts.map((receipt) => receipt.number)).toEqual([
      'CP-00021',
      'CP-00022',
      'CP-00023',
    ])
    const reported = withCode(batch.issues, 'REPEATED_TRANSACTION')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.message).toContain('4207000000400021, 4207000000400022')
  })

  it('says nothing about a file whose transactions genuinely differ', () => {
    /* The negative control. Without it, a check that fired on every import would pass the
     * test above and be reported as working. */
    expect(withCode(caseBatch('conflictingDate').issues, 'REPEATED_TRANSACTION')).toEqual([])
  })
})
