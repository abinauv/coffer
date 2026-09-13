/*
 * The Tally importer, end to end, against a golden export held as JSON.
 *
 * The whole file is written against one claim: an import is a PROPOSAL that can be looked
 * at, argued with, and re-run. So the assertions are about ROWS — every line of every
 * document, in order, with the file rows each came from — and not about counts and totals.
 * A total that balances cannot see a dropped row, and a count cannot see two rows swapped
 * (CONVENTIONS §1.10).
 *
 * The fixture's own header says how it is ordered and why. In short, three separate orders
 * disagree with the answers: the VOUCHERS file comes before the MASTERS file, so every
 * ledger is introduced after the voucher that names it; inside the masters file a group is
 * written after the ledger that hangs under it; and the vouchers are in neither date order
 * nor number order. An importer that resolved anything during its walk, or that sorted on
 * the way through, fails rather than passing by luck.
 *
 * WHAT THE CASE FIXTURES ARE FOR. Each one is a file built so that exactly one condition
 * can produce its result. `noParty` and `namedPartyWithNoEntry` are two halves of one
 * compound rule and each excludes a row the other cannot; `documentWithoutNumber` carries
 * both a document and a voucher with no number, because the rule is that they are treated
 * DIFFERENTLY and a fixture with only one of them cannot see that (CONVENTIONS §6).
 */

import { describe, expect, it } from 'vitest'

import {
  ImportError,
  ledgerEntryFor,
  ledgerIssues,
  readinessOf,
  remapLedgers,
  summariseBatch,
  type BatchIssue,
  type ChartAccountRef,
  type ImportBatch,
  type LedgerResolution,
} from '../model'
import { D } from '@main/domain/money'
import { RECEIPT_KINDS, type ReceiptKindDefinition } from '@shared/receipts'

import {
  TALLY_GROUPS,
  TALLY_VOUCHER_TYPES,
  balanceOf,
  classifyTallyLedger,
  elementKey,
  importTallyXml,
  openingAmountFor,
  openingBalanceOf,
  parseTallyCount,
  parseTallyDate,
  parseTallyDays,
  parseTallyFlag,
  tallyBillTreatment,
  tallyChildren,
  tallyElementSpec,
  tallyElements,
  tallyEntrySide,
  tallyReceiptKind,
  tallyValue,
  tallyVoucherTarget,
  type TallyFile,
  type TallyGroupRule,
  type TallyImportOptions,
  type TallyVoucherTypeRule,
} from './index'
import { parseXml } from '../xml'

import fixtureJson from './__fixtures__/tally-export.json'

interface FileFixture {
  why: string
  xml: string
}

interface CaseFixture {
  why: string
  files: Record<string, string>
}

const fixture = fixtureJson as unknown as {
  why: string
  export: Record<string, FileFixture>
  chart: ChartAccountRef[]
  openingBalanceDate: string
  expected: Record<string, unknown[]>
  cases: Record<string, CaseFixture>
}

const files: TallyFile[] = Object.entries(fixture.export).map(([name, file]) => ({
  name,
  text: file.xml,
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

const caseFiles = (name: string): TallyFile[] =>
  Object.entries(one(name).files).map(([fileName, text]) => ({ name: fileName, text }))

const caseBatch = (name: string, options: TallyImportOptions = {}): ImportBatch =>
  importTallyXml(caseFiles(name), { openingBalanceDate: '2027-04-01', ...options })

const codes = (issues: readonly BatchIssue[]): string[] => issues.map((issue) => issue.code)

const withCode = (issues: readonly BatchIssue[], code: string): readonly BatchIssue[] =>
  issues.filter((issue) => issue.code === code)

const withField = (issues: readonly BatchIssue[], field: string): readonly BatchIssue[] =>
  issues.filter((issue) => issue.field === field)

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

const batch = importTallyXml(files, {
  openingBalanceDate: fixture.openingBalanceDate,
  ledgers: { chart: fixture.chart },
})

/** The one element of a case fixture's file, so a unit test can be handed a real element. */
const elementOf = (name: string, file: string, tag: string) => {
  const text = one(name).files[file]
  if (text === undefined) {
    throw new Error(`No file called ${file} in case ${name}`)
  }
  const found = parseXml(text)
  const stack = [found.root]
  while (stack.length > 0) {
    const next = stack.pop()
    if (next === undefined) {
      break
    }
    if (next.name === tag) {
      return next
    }
    for (const child of next.children) {
      if (child.kind === 'element') {
        stack.push(child)
      }
    }
  }
  throw new Error(`No <${tag}> in ${file}`)
}

describe('the whole export', () => {
  it('produces the documents in first-appearance order, with every line and every row', () => {
    expect(withoutFingerprint(batch.documents)).toEqual(expected('documents'))
  })

  it('is asserted against an order that disagrees with date order and with number order', () => {
    /* Without this, the assertion above would pass just as happily against an importer that
     * sorted, and nothing would say which property was being tested. */
    const dates = batch.documents.map((document) => document.date)
    const numbers = batch.documents.map((document) => document.number)
    expect(dates).not.toEqual([...dates].sort())
    expect(numbers).not.toEqual([...numbers].sort())
  })

  it('classifies a ledger the file introduces AFTER the voucher that uses it', () => {
    /* Vouchers.xml is read first and names Bharat Metals five times; nothing in that file
     * says whether it is a customer. An importer that resolved during its walk would have
     * staged the first voucher against a party it had never heard of. */
    expect(files[0]?.name).toBe('Vouchers.xml')
    expect(files[1]?.name).toBe('Masters.xml')
    expect(batch.documents[0]?.partyName).toBe('Bharat Metals Pvt Ltd')
    expect(batch.parties[0]?.isCustomer).toBe(true)
  })

  it('walks a parent chain two groups long, through a group written after the ledger', () => {
    /* Bharat Metals is under Karnataka Customers, which is under Sundry Debtors. A one-hop
     * lookup of the ledger's own PARENT reaches a group Coffer has never heard of. */
    expect(batch.parties[0]?.sourceId).toBe('tly-led-bharat')
    expect(batch.accounts.map((account) => account.name)).not.toContain('Bharat Metals Pvt Ltd')
  })

  it('produces the vouchers, the parties, the accounts, the items and the units', () => {
    expect(withoutFingerprint(batch.receipts)).toEqual(expected('receipts'))
    expect(batch.parties).toEqual(expected('parties'))
    expect(batch.accounts).toEqual(expected('accounts'))
    expect(batch.items).toEqual(expected('items'))
    expect(batch.units).toEqual(expected('units'))
    expect(batch.openingBalances).toEqual(expected('openingBalances'))
  })

  it('records what it read from each file', () => {
    expect(
      batch.source.files.map((file) => [file.name, file.entity, file.rowsRead, file.rowsStaged]),
    ).toEqual([
      ['Vouchers.xml', 'tally-xml', 13, 11],
      ['Masters.xml', 'tally-xml', 19, 19],
    ])
  })

  it('names no date format, because eight digits have only one reading', () => {
    expect(batch.source.files.map((file) => file.dateFormat)).toEqual([null, null])
  })

  it('records every element name the file used, which is how a wrong guess is diagnosed', () => {
    const vouchers = batch.source.files[0]?.headings ?? []
    expect(vouchers).toContain('ALLLEDGERENTRIES.LIST')
    expect(vouchers).toContain('LEDGERENTRIES.LIST')
    /* The mixed-case spelling is recorded AS WRITTEN, distinct from the upper-case one, so
     * the list says what the file says rather than what the reader made of it. */
    expect(vouchers).toContain('Amount')
    expect(vouchers).toContain('AMOUNT')
    expect(batch.source.files[1]?.headings).toContain('GSTTYPEOFSUPPLY')
  })

  it('counts what it staged', () => {
    expect(summariseBatch(batch)).toMatchObject({
      units: 3,
      accounts: 9,
      parties: 3,
      items: 3,
      openingBalances: 3,
      documents: 4,
      documentLines: 5,
      receipts: 3,
      allocations: 2,
      ledgers: 6,
    })
  })
})

describe('reading a voucher', () => {
  it('reads the entries under either of the two names one list has', () => {
    /* SI-2027-041 writes ALLLEDGERENTRIES.LIST and PB-2027-018 writes LEDGERENTRIES.LIST.
     * Both produce a document, so neither spelling is the one that happens to be listed
     * first in elements.ts. */
    expect(batch.documents[0]?.lines).toHaveLength(1)
    expect(batch.documents[1]?.lines).toHaveLength(1)
    expect(batch.documents[1]?.statedTotal).toBe('29500.00')
  })

  it('reads an amount with a currency symbol and Indian grouping through csv/amounts', () => {
    expect(batch.documents[1]?.statedTotal).toBe('29500.00')
  })

  it('reads a voucher that is not inside a TALLYMESSAGE at all', () => {
    /* PB-2027-019 sits directly under REQUESTDATA. A predicate keyed on the documented path
     * would read nothing from it and say only that it found no vouchers. */
    expect(batch.documents[3]?.number).toBe('PB-2027-019')
  })

  it('collapses a padded ledger name and leaves a narration exactly as it was written', () => {
    /* The file writes the ledger name across two lines with leading spaces, and the
     * narration with a run of two spaces and a real line break the user typed. */
    expect(batch.documents[0]?.lines[0]?.ledger).toBe('Sales - Fabrication')
    expect(batch.documents[0]?.narration).toBe('Fabrication  work\n        for the Hosur site.')
  })

  it('normalises the file’s CRLF endings inside that narration', () => {
    expect(batch.documents[0]?.narration).not.toContain('\r')
    expect(fixture.export['Vouchers.xml']?.xml).toContain('\r\n')
  })

  it('takes the voucher type from the attribute and the element when they agree', () => {
    expect(batch.documents[0]?.kind).toBe('sales-invoice')
  })

  it('reads a file whose every tag is in mixed case', () => {
    const mixed = caseBatch('mixedCaseElements')
    expect(mixed.documents.map((document) => document.number)).toEqual(['SI-MC-1'])
    expect(mixed.documents[0]?.statedTotal).toBe('100.00')
  })
})

describe('signs, and the flag that argues with them', () => {
  it('reads a negative amount as a debit and a positive one as a credit', () => {
    expect(tallyEntrySide(D('-11800.00'), null)).toEqual({
      side: 'debit',
      statedPositive: null,
      contradicts: false,
      fromFlag: false,
    })
    expect(tallyEntrySide(D('11800.00'), null)).toEqual({
      side: 'credit',
      statedPositive: null,
      contradicts: false,
      fromFlag: false,
    })
  })

  it('says a flag agreeing with the sign is not a contradiction', () => {
    /* The negative control. Without it, a check that reported EVERY entry would pass the
     * test below and be reported as working. */
    expect(tallyEntrySide(D('-1.00'), true).contradicts).toBe(false)
    expect(tallyEntrySide(D('1.00'), false).contradicts).toBe(false)
  })

  it('goes with the sign when the flag disagrees, and reports it', () => {
    expect(tallyEntrySide(D('-5000.00'), false)).toEqual({
      side: 'debit',
      statedPositive: false,
      contradicts: true,
      fromFlag: false,
    })
    const reported = withCode(batch.issues, 'CONFLICTING_HEADER')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.severity).toBe('warning')
    expect(reported[0]?.message).toContain('HDFC Bank - 4021')
    expect(reported[0]?.message).toContain('the amount is what gets posted')
    /* And the voucher still arrives, with the amount the sign named. */
    expect(batch.receipts[2]?.amount).toBe('5000.00')
    expect(batch.receipts[2]?.ledger).toBe('HDFC Bank - 4021')
  })

  it('lets the flag decide a ZERO entry, where the sign says nothing', () => {
    expect(tallyEntrySide(D('0.00'), true)).toEqual({
      side: 'debit',
      statedPositive: true,
      contradicts: false,
      fromFlag: true,
    })
    expect(tallyEntrySide(D('0.00'), false).side).toBe('credit')
  })

  it('leaves a zero entry with no flag with no side at all, rather than guessing one', () => {
    expect(tallyEntrySide(D('0.00'), null).side).toBe('nil')
  })

  it('keeps both zero-amount entries as lines of the document', () => {
    const zeroes = caseBatch('zeroEntryWithFlag')
    expect(zeroes.documents[0]?.lines.map((line) => [line.ledger, line.unitPrice])).toEqual([
      ['Sales - Fabrication', '100.00'],
      ['Free Samples', '0.00'],
      ['Packing', '0.00'],
    ])
  })

  it('faces a line the opposite way from the party entry, on both sides of the trade', () => {
    /* A sales invoice debits the customer, so its credits are positive lines; a purchase
     * bill credits the supplier, so its debits are. One multiplication, read off the party
     * entry rather than off the document kind. */
    expect(batch.documents[0]?.lines[0]?.unitPrice).toBe('10000.00')
    expect(batch.documents[1]?.lines[0]?.unitPrice).toBe('25000.00')
    /* And a credit note, which faces the other way again with no second rule. */
    expect(batch.documents[2]?.lines.map((line) => line.unitPrice)).toEqual(['1000.00', '200.00'])
  })
})

describe('a voucher that does not balance', () => {
  it('reports both totals and the difference, and does not adjust anything', () => {
    const reported = withCode(batch.issues, 'INVALID_AMOUNT').filter(
      (issue) => issue.field === 'amount',
    )
    expect(reported).toHaveLength(1)
    expect(reported[0]?.severity).toBe('error')
    expect(reported[0]?.message).toContain('11800.00')
    expect(reported[0]?.message).toContain('11700.00')
    expect(reported[0]?.message).toContain('a difference of 100.00')
  })

  it('leaves the voucher out and imports every other one', () => {
    expect(batch.documents.map((document) => document.number)).not.toContain('SI-2027-042')
    expect(batch.documents).toHaveLength(4)
    expect(batch.receipts).toHaveLength(3)
  })

  it('adds the two sides separately, so a balanced voucher gives zero either way round', () => {
    const entries = [
      { ledger: 'a', amount: '-100.00', side: 'debit' as const },
      { ledger: 'b', amount: '60.00', side: 'credit' as const },
      { ledger: 'c', amount: '40.00', side: 'credit' as const },
    ].map((entry) => ({
      ...entry,
      statedPositive: null,
      contradicts: false,
      allocations: [],
      line: 1,
    }))
    const totals = balanceOf(entries)
    expect(totals.debits.toString()).toBe('100')
    expect(totals.credits.toString()).toBe('100')
    expect(totals.difference.isZero()).toBe(true)
  })
})

describe('a voucher type Coffer does not know', () => {
  it('reports a type the company invented, and says what to do about it', () => {
    const reported = withField(withCode(batch.issues, 'UNKNOWN_ACCOUNT_TYPE'), 'voucherType')
    const unknown = reported.filter((issue) => issue.severity === 'error')
    expect(unknown).toHaveLength(1)
    expect(unknown[0]?.value).toBe('Cash Sales')
    expect(unknown[0]?.message).toContain('CS-2027-007')
    expect(unknown[0]?.message).toContain('Tally lets you invent voucher types')
    expect(batch.documents.map((document) => document.number)).not.toContain('CS-2027-007')
  })

  it('is fixed by one row of table, with no code change and no re-export', () => {
    const withCashSales = importTallyXml(files, {
      openingBalanceDate: fixture.openingBalanceDate,
      ledgers: { chart: fixture.chart },
      voucherTypes: [
        ...TALLY_VOUCHER_TYPES,
        { names: ['Cash Sales'], target: { kind: 'document', documentKind: 'sales-invoice' } },
      ],
    })
    expect(withCashSales.documents.map((document) => document.number)).toContain('CS-2027-007')
    expect(
      withField(withCode(withCashSales.issues, 'UNKNOWN_ACCOUNT_TYPE'), 'voucherType').filter(
        (issue) => issue.severity === 'error',
      ),
    ).toEqual([])
  })

  it('reports a type it KNOWS and has nowhere to put, as a warning with the reason on it', () => {
    /* A journal is not an unknown type and saying so would be a lie: Coffer knows exactly
     * what it is and `ImportBatch` has no collection that can hold one. */
    const ignored = withField(withCode(batch.issues, 'UNKNOWN_ACCOUNT_TYPE'), 'voucherType').filter(
      (issue) => issue.severity === 'warning',
    )
    expect(ignored).toHaveLength(1)
    expect(ignored[0]?.message).toContain('JV-2027-002')
    expect(ignored[0]?.message).toContain('Enter it in Coffer by hand')
  })

  it('refuses a table with two rules for one type rather than taking the first', () => {
    const doubled: TallyVoucherTypeRule[] = [
      { names: ['Sales'], target: { kind: 'document', documentKind: 'sales-invoice' } },
      { names: ['sales'], target: { kind: 'document', documentKind: 'credit-note' } },
    ]
    expect(tallyVoucherTarget('Sales', doubled)).toEqual({
      kind: 'ambiguous',
      candidates: ['document', 'document'],
    })
    const confused = importTallyXml(files, { voucherTypes: doubled })
    expect(confused.documents).toEqual([])
    expect(
      withCode(confused.issues, 'UNKNOWN_ACCOUNT_TYPE').some((issue) =>
        issue.message.includes('more than one rule'),
      ),
    ).toBe(true)
  })

  it('reports a voucher that states no type at all in different words', () => {
    /* Two names for one field that DISAGREE resolve to neither, so this voucher has no
     * type — which is a different problem from a type nobody mapped, and a different fix. */
    const disagreeing = caseBatch('disagreeingVoucherType')
    expect(disagreeing.documents).toEqual([])
    const ambiguous = withCode(disagreeing.issues, 'AMBIGUOUS_COLUMN')
    expect(ambiguous).toHaveLength(1)
    expect(ambiguous[0]?.message).toContain('VCHTYPE="Sales"')
    expect(ambiguous[0]?.message).toContain('VOUCHERTYPENAME="Purchase"')
    const untyped = withField(withCode(disagreeing.issues, 'MISSING_VALUE'), 'voucherType')
    expect(untyped).toHaveLength(1)
    expect(untyped[0]?.message).toContain('does not say what kind of voucher it is')
  })
})

describe('the parent chain, which is what says who a ledger is', () => {
  it('makes a ledger under Sundry Debtors a PARTY and never an account', () => {
    /* docs/data-model.md: Tally gives every customer its own ledger and Coffer keeps one
     * control account per side. Four hundred customers must not become four hundred
     * accounts. */
    expect(batch.parties.map((party) => party.name)).toContain('Bharat Metals Pvt Ltd')
    expect(batch.accounts.map((account) => account.name)).not.toContain('Bharat Metals Pvt Ltd')
    expect(batch.parties[0]?.isCustomer).toBe(true)
    expect(batch.parties[0]?.isVendor).toBe(false)
  })

  it('makes a ledger under Sundry Creditors a vendor, on the other side of the same rule', () => {
    expect(batch.parties[1]?.name).toBe('Nilgiri Steel Traders')
    expect(batch.parties[1]?.isVendor).toBe(true)
    expect(batch.parties[1]?.isCustomer).toBe(false)
  })

  it('gives a bank, a cash account, a sales ledger and an expense their types and roles', () => {
    expect(
      batch.accounts.map((account) => [account.name, account.type, account.sourceType]),
    ).toEqual([
      ['HDFC Bank - 4021', 'asset', 'Bank Accounts'],
      ['Cash', 'asset', 'Cash-in-Hand'],
      ['Sales - Fabrication', 'income', 'Sales Accounts'],
      ['Purchases - Raw Material', 'expense', 'Purchase Accounts'],
      ['Output Levy 18%', 'liability', 'Duties & Taxes'],
      ['Input Levy 18%', 'liability', 'Duties & Taxes'],
      ['Sales Returns', 'income', 'Sales Accounts'],
      ['Discount Allowed', 'expense', 'Indirect Expenses'],
      ['Depreciation', 'expense', 'Indirect Expenses'],
    ])
  })

  it('reports a chain that names a group this export does not contain', () => {
    const reported = withField(withCode(batch.issues, 'UNKNOWN_ACCOUNT_TYPE'), 'parent')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.severity).toBe('warning')
    expect(reported[0]?.message).toContain('Deccan Hardware')
    expect(reported[0]?.message).toContain('Zone West')
    expect(reported[0]?.message).toContain('this export has no group of that name')
  })

  it('says in the SAME sentence that the ledger’s opening balance went with it', () => {
    /* Which way an opening balance goes depends on the account type, both readings balance,
     * and the wrong one is found a year later. Two issues would let a user act on one. */
    const reported = withField(withCode(batch.issues, 'UNKNOWN_ACCOUNT_TYPE'), 'parent')
    expect(reported[0]?.message).toContain('6000.00')
    expect(reported[0]?.message).toContain('both readings balance')
    expect(batch.openingBalances.map((opening) => opening.partyName)).not.toContain(
      'Deccan Hardware',
    )
  })

  it('reports a chain that ENDS on a group nobody recognises, in different words', () => {
    const top = caseBatch('topLevelGroup')
    const reported = withField(withCode(top.issues, 'UNKNOWN_ACCOUNT_TYPE'), 'parent')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.message).toContain('Special Accounts')
    expect(reported[0]?.message).toContain('names no parent')
    expect(top.accounts).toEqual([])
  })

  it('reports a chain that LOOPS, rather than walking it forever', () => {
    const looped = caseBatch('loopingParent')
    const reported = withField(withCode(looped.issues, 'UNKNOWN_ACCOUNT_TYPE'), 'parent')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.message).toContain('North Zone -> South Zone -> North Zone')
    expect(looped.openingBalances).toEqual([])
  })

  it('reports a ledger that names no parent at all, with a third sentence', () => {
    expect(classifyTallyLedger('', new Map(), TALLY_GROUPS)).toEqual({
      kind: 'unresolved',
      because: 'it names no parent group, so nothing in this export says what it is.',
      chain: [],
    })
  })

  it('refuses a group table with two rules for one name rather than taking the first', () => {
    /* The shipped table cannot produce this, so the guard would be a line no test can reach
     * and no mutation can kill unless the table is an argument (CONVENTIONS §6). */
    const doubled: TallyGroupRule[] = [
      { names: ['Sundry Debtors'], type: 'asset', role: 'accounts-receivable', party: 'sales' },
      { names: ['sundry debtors'], type: 'liability', role: 'accounts-payable', party: 'purchase' },
    ]
    expect(classifyTallyLedger('Sundry Debtors', new Map(), doubled)).toMatchObject({
      kind: 'ambiguous',
      group: 'Sundry Debtors',
      candidates: ['asset (accounts-receivable)', 'liability (accounts-payable)'],
    })
  })

  it('walks the chain hop by hop, keeping every group it passed', () => {
    const parents = new Map([
      ['karnataka customers', 'South Zone'],
      ['south zone', 'Sundry Debtors'],
    ])
    expect(classifyTallyLedger('Karnataka Customers', parents, TALLY_GROUPS)).toEqual({
      kind: 'party',
      side: 'sales',
      role: 'accounts-receivable',
      type: 'asset',
      group: 'Sundry Debtors',
      chain: ['Karnataka Customers', 'South Zone', 'Sundry Debtors'],
    })
  })
})

describe('opening balances', () => {
  it('turn Tally’s sign into the account’s normal direction, exactly once', () => {
    /* Tally writes a debit balance as a negative. A receivable and a payable both come out
     * positive, which is what `OpeningBalanceLine` means, so nobody translates twice. */
    expect(
      batch.openingBalances.map((opening) => [opening.partyName ?? null, opening.amount]),
    ).toEqual([
      ['Bharat Metals Pvt Ltd', '45000.00'],
      ['Nilgiri Steel Traders', '22000.00'],
      [null, '125000.00'],
    ])
  })

  it('put a party’s balance against the CONTROL ROLE with the party on it, never a document', () => {
    expect(batch.openingBalances[0]?.ledger).toEqual({
      kind: 'role',
      role: 'accounts-receivable',
    })
    expect(batch.openingBalances[1]?.ledger).toEqual({ kind: 'role', role: 'accounts-payable' })
    expect(batch.documents.map((document) => document.sourceId)).not.toContain(
      'opening:tly-led-bharat',
    )
  })

  it('put an ordinary account’s balance against the ledger NAME, resolved through the mapping', () => {
    expect(batch.openingBalances[2]?.ledger).toEqual({
      kind: 'name',
      ledger: 'HDFC Bank - 4021',
    })
    expect(ledgerEntryFor(batch.ledgers, 'HDFC Bank - 4021')?.usageCount).toBe(3)
  })

  it('are not staged for a zero balance, nor for an absent one', () => {
    /* Two halves of one condition, and the fixture carries a ledger for each: Cash states
     * 0.00 and Sales - Fabrication states nothing. Delete either condition and only one of
     * these rows changes. */
    expect(batch.accounts.map((account) => account.name)).toContain('Cash')
    expect(batch.accounts.map((account) => account.name)).toContain('Sales - Fabrication')
    const named = batch.openingBalances.map((opening) =>
      opening.ledger.kind === 'name' ? opening.ledger.ledger : null,
    )
    expect(named).not.toContain('Cash')
    expect(named).not.toContain('Sales - Fabrication')
  })

  it('turn every account type the right way round, not just the two in the fixture', () => {
    /* The fixture has an asset, a liability and a receivable. The rule is about the NORMAL
     * BALANCE, so the two types it never exercises are asserted here rather than left to a
     * mutation nothing can kill. */
    expect(openingAmountFor('-1000.00', 'asset')).toBe('1000.00')
    expect(openingAmountFor('-1000.00', 'expense')).toBe('1000.00')
    expect(openingAmountFor('1000.00', 'liability')).toBe('1000.00')
    expect(openingAmountFor('1000.00', 'equity')).toBe('1000.00')
    expect(openingAmountFor('1000.00', 'income')).toBe('1000.00')
    /* And a balance on the WRONG side of an account stays negative rather than being
     * flipped into one that looks ordinary: a customer in credit is a customer in credit. */
    expect(openingAmountFor('12000.00', 'asset')).toBe('-12000.00')
  })

  it('refuse to place a balance whose account type nothing established', () => {
    /* `stageTallyLedgers` never calls this with an unresolved role, so the guard is one no
     * fixture can reach and no mutation could kill (CONVENTIONS §6). A test hands it the
     * state it is guarding against instead. */
    const ledger = {
      sourceId: 'x',
      name: 'Nowhere Ledger',
      parent: 'Zone West',
      openingBalance: '-500.00',
      registrationNumber: null,
      email: null,
      jurisdictionName: null,
      countryName: null,
      paymentTermsDays: null,
      provenance: [],
    }
    expect(
      openingBalanceOf(ledger, { kind: 'unresolved', because: 'no chain', chain: [] }),
    ).toBeNull()
    expect(
      openingBalanceOf(ledger, {
        kind: 'account',
        role: null,
        recomputed: false,
        type: 'asset',
        group: 'Current Assets',
        chain: ['Current Assets'],
      }),
    ).toMatchObject({ amount: '500.00', ledger: { kind: 'name', ledger: 'Nowhere Ledger' } })
  })

  it('take the date from the caller, because a ledger carries none', () => {
    expect(batch.openingBalanceDate).toBe('2027-04-01')
  })

  it('refuse to be written with no date, rather than choosing one', () => {
    const undated = importTallyXml(files, { ledgers: { chart: fixture.chart } })
    expect(undated.openingBalances).toHaveLength(3)
    const reported = undated.issues.filter(
      (issue) => issue.code === 'MISSING_VALUE' && issue.message.includes('opening balances'),
    )
    expect(reported).toHaveLength(1)
    expect(reported[0]?.severity).toBe('error')
  })
})

describe('vouchers that move money', () => {
  it('reads a receipt from a customer as a receipt', () => {
    expect(batch.receipts[0]?.kind).toBe('receipt')
    expect(batch.receipts[0]?.amount).toBe('11800.00')
    expect(batch.receipts[0]?.reference).toBe('CHQ 884120')
  })

  it('reads a PAYMENT voucher whose party is a CUSTOMER as a refund, not a payment', () => {
    /* The whole reason the kind is a direction crossed with a side. Filing this as a
     * payment would put a customer's money into accounts payable, where no statement of
     * theirs would ever show it (CONVENTIONS §9, 0015). */
    expect(batch.receipts[1]?.number).toBe('PY-2027-014')
    expect(batch.receipts[1]?.kind).toBe('refund')
    expect(batch.receipts[1]?.partyName).toBe('Bharat Metals Pvt Ltd')
    expect(batch.receipts[1]?.ledger).toBe('Cash')
  })

  it('looks the kind up in the voucher table by both facts, and reports two answers', () => {
    expect(tallyReceiptKind('out', 'sales')).toEqual({ kind: 'one', receiptKind: 'refund' })
    expect(tallyReceiptKind('in', 'purchase')).toEqual({
      kind: 'one',
      receiptKind: 'refund-received',
    })
    const doubled: ReceiptKindDefinition[] = [
      ...RECEIPT_KINDS,
      { kind: 'payment', label: 'X', pluralLabel: 'Xs', side: 'sales', direction: 'out' },
    ]
    expect(tallyReceiptKind('out', 'sales', doubled)).toEqual({
      kind: 'ambiguous',
      candidates: ['refund', 'payment'],
    })
    expect(tallyReceiptKind('in', 'sales', [])).toEqual({ kind: 'none' })
  })

  it('stages a bill reference marked Agst Ref and skips one marked New Ref', () => {
    expect(batch.receipts[0]?.allocations).toEqual([
      {
        documentNumber: 'SI-2027-041',
        amount: '11800.00',
        provenance: [{ file: 'Vouchers.xml', line: 134, rowNumber: 5 }],
      },
    ])
    /* RC-2027-010 carries an Agst Ref and a New Ref; only one becomes an allocation, so an
     * invoice cannot pay itself. */
    expect(batch.receipts[2]?.allocations).toHaveLength(1)
    expect(batch.receipts[2]?.allocations[0]?.documentNumber).toBe('SI-2026-777')
  })

  it('warns that a voucher settles a document this export does not contain', () => {
    const reported = withCode(batch.issues, 'ALLOCATION_TARGET_MISSING')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.severity).toBe('warning')
    expect(reported[0]?.value).toBe('SI-2026-777')
  })

  it('reads a bill type through a table that reports two answers rather than choosing', () => {
    expect(tallyBillTreatment('Agst Ref')).toEqual({ kind: 'one', treatment: 'settles' })
    expect(tallyBillTreatment('New Ref')).toEqual({ kind: 'one', treatment: 'opens' })
    expect(tallyBillTreatment('On Account')).toEqual({ kind: 'one', treatment: 'unallocated' })
    expect(tallyBillTreatment('Adjustment')).toEqual({ kind: 'unknown' })
    expect(
      tallyBillTreatment('Agst Ref', [
        { names: ['Agst Ref'], treatment: 'settles' },
        { names: ['agst ref'], treatment: 'opens' },
      ]),
    ).toEqual({ kind: 'ambiguous', candidates: ['settles', 'opens'] })
  })

  it('refuses a receipt with a third leg rather than overstating the bank or the party', () => {
    const reported = withField(withCode(batch.issues, 'INVALID_AMOUNT'), 'ledger')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.severity).toBe('error')
    expect(reported[0]?.message).toContain('RC-2027-011')
    expect(reported[0]?.message).toContain('Discount Allowed -100.00')
    expect(batch.receipts.map((receipt) => receipt.number)).not.toContain('RC-2027-011')
  })

  it('keeps a voucher with no number and refuses a DOCUMENT with no number', () => {
    /* The asymmetry is the point. A document's number is its identity and goes into its
     * fingerprint; a voucher's number is allotted by whichever program recorded the money
     * and is deliberately left out of one (see the header of ../model.ts). */
    const unnumbered = caseBatch('documentWithoutNumber')
    expect(unnumbered.documents).toEqual([])
    expect(unnumbered.receipts.map((receipt) => receipt.number)).toEqual(['tly-v-unnum'])
    const refused = withField(withCode(unnumbered.issues, 'MISSING_VALUE'), 'number').filter(
      (issue) => issue.severity === 'error',
    )
    const kept = withField(withCode(unnumbered.issues, 'MISSING_VALUE'), 'number').filter(
      (issue) => issue.severity === 'warning',
    )
    expect(refused).toHaveLength(1)
    expect(kept).toHaveLength(1)
  })
})

describe('finding the party', () => {
  it('prefers the entry whose chain reaches a customer group over PARTYLEDGERNAME', () => {
    const stale = caseBatch('partyNameDisagreesWithChain')
    expect(stale.documents[0]?.partyName).toBe('Renamed Traders')
    const reported = withCode(stale.issues, 'CONFLICTING_HEADER')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.severity).toBe('warning')
    expect(reported[0]?.message).toContain('Old Traders')
    expect(reported[0]?.message).toContain('Renamed Traders')
  })

  it('falls back to PARTYLEDGERNAME when no chain reaches a customer or supplier group', () => {
    /* PB-2027-019: Deccan Hardware's chain is broken, so nothing classifies it, and the
     * voucher still knows whose bill it is. */
    expect(batch.documents[3]?.partyName).toBe('Deccan Hardware')
    expect(batch.documents[3]?.partySourceId).toBe('tly-led-deccan')
  })

  it('refuses a voucher with two entries on customer or supplier ledgers', () => {
    const two = caseBatch('twoPartyEntries')
    expect(two.documents).toEqual([])
    const reported = withCode(two.issues, 'CONFLICTING_HEADER')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.severity).toBe('error')
    expect(reported[0]?.message).toContain('First Customer, Second Customer')
  })

  it('refuses a voucher that names no party and holds no party ledger', () => {
    const none = caseBatch('noParty')
    expect(none.documents).toEqual([])
    expect(withField(withCode(none.issues, 'MISSING_VALUE'), 'partyLedger')).toHaveLength(1)
  })

  it('refuses a voucher naming a party that is on none of its entries', () => {
    /* The row the test above cannot exclude: this voucher DOES name a party, and no entry
     * carries that ledger, so every entry would become a line — including the one that is
     * really the party's side of it. */
    const named = caseBatch('namedPartyWithNoEntry')
    expect(named.documents).toEqual([])
    const reported = withField(withCode(named.issues, 'MISSING_VALUE'), 'partyLedger')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.message).toContain('Absent Traders')
    expect(reported[0]?.message).toContain('has no entry on that ledger')
  })

  it('creates a party a voucher names that no master places, and reports it', () => {
    const invented = withCode(batch.issues, 'PARTY_NOT_FOUND')
    expect(invented).toHaveLength(1)
    expect(invented[0]?.severity).toBe('warning')
    expect(invented[0]?.value).toBe('Deccan Hardware')
    expect(batch.parties[2]).toEqual({
      sourceId: 'tly-led-deccan',
      name: 'Deccan Hardware',
      isCustomer: false,
      isVendor: true,
      provenance: [],
    })
  })
})

describe('a levy is not a line', () => {
  it('keeps an entry under Duties & Taxes off the document’s lines', () => {
    /* Coffer computes the levy from the lines at write time, so an entry that was also a
     * line would be charged twice and the invoice would come out above 11,800. */
    expect(batch.documents[0]?.lines.map((line) => line.ledger)).toEqual(['Sales - Fabrication'])
    expect(batch.documents[2]?.lines.map((line) => line.ledger)).toEqual([
      'Sales Returns',
      'Site Allowance',
    ])
  })

  it('keeps the levy inside the total the file stated, which is the party’s own figure', () => {
    expect(batch.documents[0]?.statedTotal).toBe('11800.00')
    expect(batch.documents[0]?.lines[0]?.unitPrice).toBe('10000.00')
    expect(batch.documents[2]?.statedTotal).toBe('1416.00')
  })

  it('still stages the levy ledger as an account, because the chart needs it', () => {
    expect(batch.accounts.map((account) => account.name)).toContain('Output Levy 18%')
  })

  it('is decided by the group table and by nothing in the ledger’s name', () => {
    const noLevyRule = TALLY_GROUPS.filter(
      (rule) => !rule.names.some((name) => name === 'Duties & Taxes'),
    )
    const taxed = importTallyXml(files, {
      openingBalanceDate: fixture.openingBalanceDate,
      groups: noLevyRule,
    })
    /* With the rule removed the levy becomes an ordinary line, which is exactly what
     * happens to an export that brings no masters — visible, and blocking, rather than
     * silently doubled. */
    expect(taxed.documents[0]?.lines.map((line) => line.ledger)).toEqual([
      'Sales - Fabrication',
      'Output Levy 18%',
    ])
  })
})

describe('cancelled and optional vouchers', () => {
  it('leaves a cancelled voucher out and says why', () => {
    const reported = withField(withCode(batch.issues, 'MISSING_VALUE'), 'isCancelled')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.severity).toBe('warning')
    expect(reported[0]?.message).toContain('SI-2027-043')
    expect(batch.documents.map((document) => document.number)).not.toContain('SI-2027-043')
  })

  it('leaves an optional voucher out, and keeps the one marked No beside it', () => {
    /* The negative control for the same rule: without SI-OP-2, a reader that dropped every
     * voucher carrying an ISOPTIONAL element at all would pass. */
    const optional = caseBatch('optionalVoucher')
    expect(optional.documents.map((document) => document.number)).toEqual(['SI-OP-2'])
    expect(withField(withCode(optional.issues, 'MISSING_VALUE'), 'isOptional')).toHaveLength(1)
  })
})

describe('dates', () => {
  it('reads eight digits, and validates rather than assuming', () => {
    expect(parseTallyDate('20270719')).toEqual({ ok: true, value: '2027-07-19' })
    expect(parseTallyDate('20280229')).toEqual({ ok: true, value: '2028-02-29' })
  })

  it('refuses a date in a shape Tally does not write, naming the shape it does', () => {
    const refused = parseTallyDate('1-Apr-2027')
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.message).toContain('eight digits')
  })

  it('refuses a day that is not on the calendar, in different words', () => {
    const refused = parseTallyDate('20270231')
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.message).toContain('not a real date')
    /* And it does NOT quote YYYY-MM-DD at the user, which is the shape this function put
     * the separators into and not the shape of anything in their file. */
    expect(refused.ok ? '' : refused.message).not.toContain('YYYY-MM-DD')
  })

  it('refuses eight digits with anything after them', () => {
    /* The row that only the END anchor excludes. A timestamp starts with a perfectly good
     * date, so a pattern that merely STARTS with eight digits reads `2027071912` as 19 July
     * and throws away the rest without a word. */
    const refused = parseTallyDate('2027071912')
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.message).toContain('eight digits')
  })

  it('refuses an empty date', () => {
    expect(parseTallyDate('   ')).toEqual({ ok: false, message: 'is empty' })
  })

  it('reports each unreadable date on its own voucher and imports the rest of the file', () => {
    const dates = caseBatch('unreadableDates')
    expect(dates.documents.map((document) => document.number)).toEqual(['SI-D4'])
    expect(withCode(dates.issues, 'INVALID_DATE')).toHaveLength(2)
    expect(withField(withCode(dates.issues, 'MISSING_VALUE'), 'date')).toHaveLength(1)
  })
})

describe('the other scalars Tally writes', () => {
  it('reads a Yes/No flag from a closed table and refuses anything else', () => {
    expect(parseTallyFlag('Yes')).toEqual({ ok: true, value: true })
    expect(parseTallyFlag(' no ')).toEqual({ ok: true, value: false })
    expect(parseTallyFlag('1')).toEqual({ ok: true, value: true })
    const refused = parseTallyFlag('Maybe')
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.message).toContain('not Yes or No')
  })

  it('reads a credit period written as a number or as a number of days', () => {
    expect(parseTallyDays('30')).toEqual({ ok: true, value: 30 })
    expect(parseTallyDays('45 Days')).toEqual({ ok: true, value: 45 })
    expect(parseTallyDays('1 day')).toEqual({ ok: true, value: 1 })
    expect(parseTallyDays('Due on Receipt').ok).toBe(false)
  })

  it('reports a credit period that is not a number of days rather than reading it as zero', () => {
    /* Zero days would make every invoice to that supplier overdue on the day it is raised. */
    const reported = withField(withCode(batch.issues, 'INVALID_NUMBER'), 'creditPeriod')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.value).toBe('Due on Receipt')
    expect(batch.parties[1]?.paymentTermsDays).toBeUndefined()
    expect(batch.parties[0]?.paymentTermsDays).toBe(30)
  })

  it('reads a unit’s decimal places, and leaves them absent when the file is nonsense', () => {
    expect(parseTallyCount('2')).toEqual({ ok: true, value: 2 })
    expect(parseTallyCount('2 places').ok).toBe(false)
    /* The rows that only the DIGITS test excludes, and not the whole-number one after it:
     * JavaScript reads all three of these as perfectly good integers. */
    expect(parseTallyCount('2.0').ok).toBe(false)
    expect(parseTallyCount('0x10').ok).toBe(false)
    expect(parseTallyCount('1e3').ok).toBe(false)
    expect(batch.units[0]).toMatchObject({ code: 'NOS', decimalPlaces: 2 })
    expect(batch.units[1]?.decimalPlaces).toBeUndefined()
    expect(withField(withCode(batch.issues, 'INVALID_NUMBER'), 'decimalPlaces')).toHaveLength(1)
  })

  it('collects a unit an item names that has no master of its own', () => {
    expect(batch.units.map((unit) => unit.code)).toEqual(['NOS', 'KG', 'HRS'])
  })
})

describe('stock items', () => {
  it('reads the supply type where the file states it', () => {
    expect(batch.items.map((item) => [item.name, item.kind])).toEqual([
      ['Steel Bracket', 'goods'],
      ['Design Consultancy', 'service'],
      ['Powder Coating', 'goods'],
    ])
  })

  it('reports a supply type it does not know rather than folding it into the default', () => {
    const reported = withCode(batch.issues, 'UNKNOWN_ITEM_KIND')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.value).toBe('Composite')
    expect(reported[0]?.message).toContain('Powder Coating')
  })

  it('works out which side an item is traded on from the vouchers that name it', () => {
    /* Steel Bracket is on a sales voucher and on a purchase voucher, so it is both; the
     * other two are on none, so they are both by default rather than neither. */
    expect(batch.items.map((item) => [item.name, item.isSold, item.isPurchased])).toEqual([
      ['Steel Bracket', true, true],
      ['Design Consultancy', true, true],
      ['Powder Coating', true, true],
    ])
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

  it('reads an Indian-accounting name onto a role', () => {
    expect(entry('Sales Returns')?.resolution).toMatchObject({
      kind: 'role',
      role: 'sales-returns',
    })
    expect(entry('Cash')?.resolution).toMatchObject({ kind: 'role', role: 'cash' })
  })

  it('reaches an account the company already has, by name', () => {
    expect(entry('HDFC Bank - 4021')?.resolution).toMatchObject({ kind: 'code', code: '1210' })
  })

  it('reaches an account the export itself brings', () => {
    expect(entry('Purchases - Raw Material')?.resolution).toMatchObject({
      kind: 'new',
      accountSourceId: 'tly-led-purchases',
    })
  })

  it('blocks the write on a ledger nothing could place, without losing the other rows', () => {
    const readiness = readinessOf(batch)
    expect(readiness.isReadyToWrite).toBe(false)
    expect(readiness.unmappedLedgers).toEqual(['Site Allowance'])
    expect(batch.documents).toHaveLength(4)
    expect(batch.documents[2]?.lines).toHaveLength(2)
  })

  it('is fixed by one override, without re-reading a single file', () => {
    const fixed = remapLedgers(batch, {
      chart: fixture.chart,
      newAccounts: batch.accounts,
      overrides: { 'Site Allowance': { kind: 'role', role: 'discount-allowed' } },
    })
    expect(readinessOf(fixed).unmappedLedgers).toEqual([])
    expect(ledgerIssues(fixed)).toEqual([])
    /* One error fewer, and the same rows: a remap replaces one small table and rewrites
     * nothing, so a document cannot come out of it disagreeing with the mapping. */
    expect(readinessOf(fixed).errorCount).toBe(readinessOf(batch).errorCount - 1)
    expect(fixed.documents).toEqual(batch.documents)
    expect(fixed.receipts).toEqual(batch.receipts)
  })
})

describe('an element name that is wrong is diagnosable from the batch alone', () => {
  it('reports an element it met and no field claims, once per name with a count', () => {
    const reported = withCode(batch.issues, 'UNMAPPED_COLUMN').filter(
      (issue) => issue.heading !== undefined,
    )
    expect(reported.map((issue) => issue.heading)).toEqual([
      'COMPANY',
      'LANGUAGENAME.LIST',
      'UDF:REGION.LIST',
      'ISSIMPLEUNIT',
    ])
    /* LANGUAGENAME.LIST is on two ledgers and is ONE issue saying so, because a real export
     * carries it on every one of forty thousand. */
    expect(reported[1]?.message).toContain('appears 2 times')
    expect(reported[0]?.message).toContain('appears 1 time')
  })

  it('reports the element a renamed field was written under, and reads it once corrected', () => {
    const renamed = caseBatch('renamedElements')
    expect(renamed.documents).toEqual([])
    expect(withCode(renamed.issues, 'UNMAPPED_COLUMN').map((issue) => issue.heading)).toEqual([
      'VCHNO',
    ])

    const corrected = caseBatch('renamedElements', {
      elements: { voucherNumber: { elements: ['VCHNO'] } },
    })
    expect(corrected.documents.map((document) => document.number)).toEqual(['SI-RN-1'])
    expect(withCode(corrected.issues, 'UNMAPPED_COLUMN')).toEqual([])
  })

  it('throws when a correction names an element this importer does not have', () => {
    expect(() => tallyElements({ voucherNumbre: { elements: ['X'] } } as never)).toThrow(
      ImportError,
    )
  })

  it('throws when a correction names no elements at all', () => {
    expect(() => tallyElements({ voucherNumber: { elements: [] } })).toThrow(ImportError)
  })

  it('refuses to read a repeated group as if it were a field', () => {
    /* Reachable without a cast, because `ledgerEntries` is in the union. Returning the
     * concatenated text would hand back every ledger name in the voucher joined together. */
    const voucher = elementOf('ambiguousEntryList', 'Both.xml', 'VOUCHER')
    expect(() => tallyValue(voucher, 'ledgerEntries')).toThrow(ImportError)
  })

  it('refuses an element name it has no spec for, rather than returning nothing', () => {
    try {
      tallyElementSpec('vouchernumber' as never)
      expect.unreachable('an unknown element must be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(ImportError)
      expect((error as ImportError).code).toBe('IMPORT_SPEC_INVALID')
    }
  })

  it('folds case and spacing, and keeps a .LIST suffix as part of the name', () => {
    expect(elementKey('AMOUNT')).toBe(elementKey(' Amount '))
    expect(elementKey('ALLLEDGERENTRIES.LIST')).not.toBe(elementKey('ALLLEDGERENTRIES'))
  })
})

describe('two names for one field', () => {
  it('reads an empty candidate as ABSENT, not as a second value that disagrees', () => {
    /* An export routinely fills in one of a pair and leaves the other as an empty element.
     * Counting the empty one as a value would report every such voucher as ambiguous and
     * read neither, which is the field dropped on the ordinary case rather than the odd
     * one. */
    const blank = caseBatch('blankCandidateBesideAValue')
    expect(blank.receipts.map((receipt) => receipt.reference)).toEqual(['UTR-4471100'])
    expect(withCode(blank.issues, 'AMBIGUOUS_COLUMN')).toEqual([])
  })

  it('counts an unclaimed element per OCCURRENCE, not per element that carried one', () => {
    const repeated = caseBatch('repeatedUnclaimedElement')
    const reported = withCode(repeated.issues, 'UNMAPPED_COLUMN').filter(
      (issue) => issue.heading === 'LANGUAGENAME.LIST',
    )
    expect(reported).toHaveLength(1)
    expect(reported[0]?.message).toContain('appears 2 times')
  })
})

describe('two names for one list', () => {
  it('refuses a voucher that writes its entries under both, rather than adding them up', () => {
    const both = caseBatch('ambiguousEntryList')
    expect(both.documents).toEqual([])
    const reported = withCode(both.issues, 'AMBIGUOUS_COLUMN')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.severity).toBe('error')
    expect(reported[0]?.message).toContain('ALLLEDGERENTRIES.LIST and LEDGERENTRIES.LIST')
    expect(reported[0]?.message).toContain('will not add them together')
  })

  it('says which spellings were present, from the elements themselves', () => {
    const voucher = elementOf('ambiguousEntryList', 'Both.xml', 'VOUCHER')
    expect(tallyChildren(voucher, 'ledgerEntries')).toEqual({
      kind: 'ambiguous',
      found: ['ALLLEDGERENTRIES.LIST', 'LEDGERENTRIES.LIST'],
    })
    expect(tallyChildren(voucher, 'inventoryEntries')).toEqual({ kind: 'none' })
  })

  it('reads two candidates that AGREE as one value, which is the ordinary voucher', () => {
    const voucher = elementOf('mixedCaseElements', 'MixedCase.xml', 'Voucher')
    expect(tallyValue(voucher, 'voucherType')).toEqual({
      kind: 'one',
      value: 'Sales',
      from: 'VchType',
    })
  })
})

describe('an entry that cannot be read takes its whole voucher with it', () => {
  it('refuses a voucher whose amount uses a comma as a decimal point', () => {
    const bad = caseBatch('unreadableEntry')
    expect(bad.documents).toEqual([])
    const reported = withField(withCode(bad.issues, 'INVALID_AMOUNT'), 'amount')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.message).toContain('SI-BE-1')
    expect(reported[0]?.message).toContain('whole voucher has been left out')
  })

  it('refuses a voucher with an entry that names no ledger, for the same arithmetic reason', () => {
    const bad = caseBatch('unreadableEntry')
    const reported = withField(withCode(bad.issues, 'MISSING_VALUE'), 'ledgerName')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.message).toContain('would leave the voucher unbalanced')
  })

  it('refuses a voucher with no ledger entries at all, in different words', () => {
    const bad = caseBatch('unreadableEntry')
    const reported = withField(withCode(bad.issues, 'MISSING_VALUE'), 'ledgerEntries')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.message).toContain('nothing in it to post')
  })
})

describe('what the XML reader noticed about the file itself', () => {
  it('carries the encoding declaration into the batch rather than refusing the file', () => {
    /* A UTF-8 file read as ISO-8859-1 is undetectable from the text, so the declaration is
     * the only signal there is — which is why it reaches the user rather than being
     * consumed by a check (see the header of xml/scan.ts). */
    const reported = withField(withCode(batch.issues, 'UNMAPPED_COLUMN'), 'encoding')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.file).toBe('Vouchers.xml')
    expect(reported[0]?.value).toBe('ISO-8859-1')
    expect(reported[0]?.severity).toBe('warning')
  })

  it('says nothing about the file that declares UTF-8', () => {
    /* The negative control. Without it, a reader that reported every file would pass the
     * test above and be reported as working. */
    expect(
      withField(withCode(batch.issues, 'UNMAPPED_COLUMN'), 'encoding').map((issue) => issue.file),
    ).toEqual(['Vouchers.xml'])
  })

  it('carries a replacement character report through as well', () => {
    const mojibake = caseBatch('replacementCharacters')
    const reported = withField(withCode(mojibake.issues, 'UNMAPPED_COLUMN'), 'text')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.message).toContain('replacement character')
  })

  it('refuses a file that is not well-formed XML, rather than importing half of it', () => {
    expect(() =>
      importTallyXml([{ name: 'Broken.xml', text: '<ENVELOPE><VOUCHER></ENVELOPE>' }]),
    ).toThrow()
  })

  it('refuses a file carrying a DOCTYPE', () => {
    expect(() =>
      importTallyXml([{ name: 'Doc.xml', text: '<!DOCTYPE ENVELOPE><ENVELOPE><A/></ENVELOPE>' }]),
    ).toThrow()
  })
})

describe('re-running an import', () => {
  it('produces the same batch, fingerprints and all', () => {
    const again = importTallyXml(files, {
      openingBalanceDate: fixture.openingBalanceDate,
      ledgers: { chart: fixture.chart },
    })
    expect(again.documents.map((document) => document.fingerprint)).toEqual(
      batch.documents.map((document) => document.fingerprint),
    )
    expect(again).toEqual(batch)
  })

  it('does not collapse two genuinely identical receipts into one', () => {
    const twins = caseBatch('identicalReceipts')
    expect(twins.receipts.map((receipt) => receipt.number)).toEqual(['RC-T-1', 'RC-T-2'])
    expect(twins.receipts[0]?.fingerprint).toBe(twins.receipts[1]?.fingerprint)
    const reported = withCode(twins.issues, 'REPEATED_TRANSACTION')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.severity).toBe('warning')
    expect(reported[0]?.message).toContain('two real payments')
  })

  it('says nothing about an export whose transactions genuinely differ', () => {
    /* The negative control. Without it, a check that fired on every import would pass the
     * test above and be reported as working. */
    expect(withCode(batch.issues, 'REPEATED_TRANSACTION')).toEqual([])
  })

  it('reports two masters sharing one identifier, and two groups sharing one name', () => {
    const dupes = caseBatch('duplicateGuid')
    const reported = withCode(dupes.issues, 'DUPLICATE_SOURCE_ID')
    expect(reported).toHaveLength(2)
    expect(reported.every((issue) => issue.severity === 'error')).toBe(true)
    expect(reported[0]?.message).toContain('two groups called "Repeated Group"')
    expect(reported[1]?.message).toContain('tly-led-same')
  })

  it('says nothing about the golden export, whose identifiers are all distinct', () => {
    expect(withCode(batch.issues, 'DUPLICATE_SOURCE_ID')).toEqual([])
  })
})

describe('every issue this import raised', () => {
  it('is one of these, in this order, at these severities', () => {
    /* The whole list, asserted as rows. A count would not see two issues swapped, and a
     * `toContain` would not see one that stopped being raised. */
    expect(batch.issues.map((issue) => [issue.code, issue.severity, issue.field ?? null])).toEqual([
      ['UNMAPPED_COLUMN', 'warning', 'encoding'],
      ['CONFLICTING_HEADER', 'warning', 'isDeemedPositive'],
      ['MISSING_VALUE', 'warning', 'isCancelled'],
      ['INVALID_NUMBER', 'warning', 'creditPeriod'],
      ['INVALID_NUMBER', 'warning', 'decimalPlaces'],
      ['UNMAPPED_COLUMN', 'warning', null],
      ['UNMAPPED_COLUMN', 'warning', null],
      ['UNMAPPED_COLUMN', 'warning', null],
      ['UNMAPPED_COLUMN', 'warning', null],
      ['UNKNOWN_ACCOUNT_TYPE', 'warning', 'parent'],
      ['UNKNOWN_ACCOUNT_TYPE', 'warning', 'voucherType'],
      ['UNKNOWN_ACCOUNT_TYPE', 'error', 'voucherType'],
      ['INVALID_AMOUNT', 'error', 'amount'],
      ['MISSING_VALUE', 'warning', 'number'],
      ['INVALID_AMOUNT', 'error', 'ledger'],
      ['PARTY_NOT_FOUND', 'warning', null],
      ['UNKNOWN_ITEM_KIND', 'warning', 'supplyType'],
      ['ALLOCATION_TARGET_MISSING', 'warning', null],
    ])
  })

  it('never stops the import: four errors and the other eleven vouchers still arrive', () => {
    expect(codes(batch.issues).filter((code) => code === 'INVALID_AMOUNT')).toHaveLength(2)
    expect(readinessOf(batch).errorCount).toBe(4)
    expect(batch.documents).toHaveLength(4)
    expect(batch.receipts).toHaveLength(3)
    expect(batch.accounts).toHaveLength(9)
  })
})
