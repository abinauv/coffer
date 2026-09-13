/*
 * The target model, and specifically the two things in it that are decisions rather than
 * plumbing: where a foreign ledger goes, and what a fingerprint can and cannot tell you.
 *
 * Every assertion about a LOOKUP here is written so that a `.find` would fail it — the
 * ambiguous cases are built on purpose, and `buildLedgerMapping` is handed the tables it
 * is guarding against rather than being trusted to guard against tables nobody can build
 * (CONVENTIONS §6: a guard against a state the real data cannot reach is a guard nothing
 * can kill).
 */

import { describe, expect, it } from 'vitest'

import { ACCOUNT_ROLES } from '@main/domain/ledger'

import { normaliseHeading } from './csv'
import {
  ImportError,
  LEDGER_SYNONYMS,
  accountsToCreate,
  allIssues,
  buildLedgerMapping,
  createImportBatch,
  documentFingerprint,
  isImportError,
  ledgerEntryFor,
  ledgerIssues,
  ledgerMentions,
  readinessOf,
  receiptFingerprint,
  remapLedgers,
  repeatedTransactions,
  stagedSubtotal,
  stagedTransactions,
  summariseBatch,
  taggedText,
  type ChartAccountRef,
  type ImportSource,
  type LedgerSynonym,
  type StagedAccount,
  type StagedDocument,
  type StagedDocumentLine,
  type StagedReceipt,
} from './model'

const SOURCE: ImportSource = { system: 'test', label: 'Test', files: [] }

const line = (over: Partial<StagedDocumentLine> = {}): StagedDocumentLine => ({
  lineNumber: 1,
  description: 'Widget',
  quantity: '2.000',
  unitPrice: '100.00',
  discount: '0.00',
  provenance: [],
  ...over,
})

const document = (over: Partial<StagedDocument> = {}): StagedDocument => {
  const draft: Omit<StagedDocument, 'fingerprint'> = {
    sourceId: 'inv-1',
    kind: 'sales-invoice',
    number: 'INV-1',
    date: '2027-05-04',
    partyName: 'Bharat Metals',
    lines: [line()],
    provenance: [],
    ...over,
  }
  return { ...draft, fingerprint: documentFingerprint(draft) }
}

const receipt = (over: Partial<StagedReceipt> = {}): StagedReceipt => {
  const draft: Omit<StagedReceipt, 'fingerprint'> = {
    sourceId: 'cp-1',
    kind: 'receipt',
    number: 'CP-1',
    date: '2027-05-04',
    partyName: 'Bharat Metals',
    amount: '500.00',
    allocations: [],
    provenance: [],
    ...over,
  }
  return { ...draft, fingerprint: receiptFingerprint(draft) }
}

const account = (over: Partial<StagedAccount> = {}): StagedAccount => ({
  sourceId: '4150',
  name: 'Consultancy Income',
  type: 'income',
  sourceType: 'Income',
  provenance: [],
  ...over,
})

describe('the shipped synonym table', () => {
  it('names only real account roles', () => {
    for (const synonym of LEDGER_SYNONYMS) {
      expect(ACCOUNT_ROLES).toContain(synonym.role)
    }
  })

  it('is written in the normalised form it is matched in', () => {
    /* An alias with a stray capital or a double space would never match anything, and
     * nothing else in the suite would notice — the ledger would simply be unmapped. */
    for (const synonym of LEDGER_SYNONYMS) {
      for (const alias of synonym.aliases) {
        expect(normaliseHeading(alias)).toBe(alias)
      }
    }
  })

  it('gives no alias to two roles, so the shipped table is never ambiguous', () => {
    const rolesByAlias = new Map<string, string[]>()
    for (const synonym of LEDGER_SYNONYMS) {
      for (const alias of synonym.aliases) {
        rolesByAlias.set(alias, [...(rolesByAlias.get(alias) ?? []), synonym.role])
      }
    }
    expect([...rolesByAlias.entries()].filter(([, roles]) => roles.length > 1)).toEqual([])
  })
})

describe('buildLedgerMapping — the Indian-accounting names', () => {
  it('reads Sundry Debtors as receivables however it is spelled and spaced', () => {
    const mapping = buildLedgerMapping(['  SUNDRY   Debtors '])
    expect(mapping).toHaveLength(1)
    expect(mapping[0]?.resolution).toMatchObject({ kind: 'role', role: 'accounts-receivable' })
    /* The ledger is kept as the file wrote it — that is what a message shows the user —
     * while the key is what matching compared. */
    expect(mapping[0]?.ledger).toBe('SUNDRY   Debtors')
    expect(mapping[0]?.key).toBe('sundry debtors')
  })

  it('counts every mention and lists ledgers in the order the import met them', () => {
    const mapping = buildLedgerMapping([
      'Sundry Creditors',
      'Sales Accounts',
      'Sundry Creditors',
      'Cash in Hand',
    ])
    expect(mapping.map((entry) => [entry.ledger, entry.usageCount])).toEqual([
      ['Sundry Creditors', 2],
      ['Sales Accounts', 1],
      ['Cash in Hand', 1],
    ])
    /* The fixture disagrees with alphabetical order on purpose: a mapping that sorted
     * would still produce three right answers and the wrong screen. */
    const names = mapping.map((entry) => entry.ledger)
    expect(names).not.toEqual([...names].sort())
  })

  it('skips a blank mention rather than making a row nothing can be said about', () => {
    expect(buildLedgerMapping(['   ', 'Sales'])).toHaveLength(1)
  })
})

describe('buildLedgerMapping — ambiguity is reported, never resolved by order', () => {
  it('refuses to choose between two chart accounts of one name', () => {
    const chart: ChartAccountRef[] = [
      { code: '6200', name: 'Rent' },
      { code: '6210', name: 'RENT' },
    ]
    const mapping = buildLedgerMapping(['Rent'], { chart })
    expect(mapping[0]?.resolution).toMatchObject({
      kind: 'ambiguous',
      candidates: ['6200 Rent', '6210 RENT'],
    })
  })

  it('refuses to choose between two roles a HANDED-IN synonym table claims', () => {
    /* The shipped table cannot produce this, which is exactly why the table is an
     * argument: a refusal the real data cannot reach is a refusal no test can kill. */
    const synonyms: LedgerSynonym[] = [
      { role: 'discount-allowed', aliases: ['discount'] },
      { role: 'discount-received', aliases: ['discount'] },
    ]
    const mapping = buildLedgerMapping(['Discount'], { synonyms })
    expect(mapping[0]?.resolution).toMatchObject({
      kind: 'ambiguous',
      candidates: ['discount-allowed', 'discount-received'],
    })
  })

  it('refuses to choose between two accounts the export itself brings of one name', () => {
    const newAccounts = [
      account({ sourceId: '4150', name: 'Consultancy Income' }),
      account({ sourceId: '4160', name: 'consultancy income' }),
    ]
    const mapping = buildLedgerMapping(['Consultancy Income'], { newAccounts })
    expect(mapping[0]?.resolution).toMatchObject({
      kind: 'ambiguous',
      candidates: ['4150', '4160'],
    })
  })

  it('is not confused by a synonym table that lists one role twice for one name', () => {
    const synonyms: LedgerSynonym[] = [
      { role: 'sales', aliases: ['turnover'] },
      { role: 'sales', aliases: ['turnover', 'revenue'] },
    ]
    expect(buildLedgerMapping(['Turnover'], { synonyms })[0]?.resolution).toMatchObject({
      kind: 'role',
      role: 'sales',
    })
  })
})

describe('buildLedgerMapping — the order of resolution', () => {
  const chart: ChartAccountRef[] = [
    { code: '4100', name: 'Sales', role: 'sales' },
    { code: '6650', name: 'Printing and Stationery' },
    { code: '4150', name: 'Consultancy Income' },
  ]

  it('takes a name nothing recognises from the chart', () => {
    expect(buildLedgerMapping(['Printing and Stationery'], { chart })[0]?.resolution).toMatchObject(
      { kind: 'code', code: '6650' },
    )
  })

  it('prefers a role to a chart name, because a role survives the account being renamed', () => {
    expect(buildLedgerMapping(['Sales'], { chart })[0]?.resolution).toMatchObject({
      kind: 'role',
      role: 'sales',
    })
  })

  it('prefers an account the chart already has to one the export would create', () => {
    /* Otherwise the import gives the company two accounts with one name, and every ledger
     * reference to that name is ambiguous for ever afterwards. */
    const mapping = buildLedgerMapping(['Consultancy Income'], {
      chart,
      newAccounts: [account()],
    })
    expect(mapping[0]?.resolution).toMatchObject({ kind: 'code', code: '4150' })
  })

  it('points at an account the export brings when the chart has nothing of that name', () => {
    const mapping = buildLedgerMapping(['Consultancy Income'], { newAccounts: [account()] })
    expect(mapping[0]?.resolution).toMatchObject({ kind: 'new', accountSourceId: '4150' })
  })

  it('reports a name nothing matches, and explains itself', () => {
    const resolution = buildLedgerMapping(['Delivery Charges'], { chart })[0]?.resolution
    expect(resolution?.kind).toBe('unmapped')
    expect(resolution?.because).toContain('nothing in your chart')
  })
})

describe('buildLedgerMapping — overrides', () => {
  const chart: ChartAccountRef[] = [{ code: '6650', name: 'Printing and Stationery' }]

  it('beats a synonym that would otherwise have answered', () => {
    const mapping = buildLedgerMapping(['Sales'], {
      overrides: { Sales: { kind: 'role', role: 'suspense' } },
    })
    expect(mapping[0]?.resolution).toMatchObject({ kind: 'role', role: 'suspense' })
  })

  it('matches the ledger name case- and space-insensitively', () => {
    const mapping = buildLedgerMapping(['delivery   charges'], {
      overrides: { 'Delivery Charges': { kind: 'ignore' } },
    })
    expect(mapping[0]?.resolution.kind).toBe('ignored')
  })

  it('takes a code that IS in the chart', () => {
    const mapping = buildLedgerMapping(['Stationery'], {
      chart,
      overrides: { Stationery: { kind: 'code', code: '6650' } },
    })
    expect(mapping[0]?.resolution).toMatchObject({ kind: 'code', code: '6650' })
  })

  it('refuses a code the chart does NOT have, rather than inventing the account', () => {
    const mapping = buildLedgerMapping(['Stationery'], {
      chart,
      overrides: { Stationery: { kind: 'code', code: '9999' } },
    })
    expect(mapping[0]?.resolution.kind).toBe('unmapped')
    expect(mapping[0]?.resolution.because).toContain('9999')
  })

  it('takes a code on trust when there is no chart to check it against', () => {
    /* The half of that condition the case above cannot see: with no chart supplied there
     * is nothing to disagree with, and refusing every code would make the override useless
     * to a caller who has not fetched a chart. */
    const mapping = buildLedgerMapping(['Stationery'], {
      overrides: { Stationery: { kind: 'code', code: '9999' } },
    })
    expect(mapping[0]?.resolution).toMatchObject({ kind: 'code', code: '9999' })
  })

  it('throws on a role that is not an account role', () => {
    expect(() =>
      buildLedgerMapping(['Sales'], {
        overrides: { Sales: { kind: 'role', role: 'profit' as any } },
      }),
    ).toThrowError(ImportError)
  })

  it('reports that refusal with a code a caller can branch on', () => {
    try {
      buildLedgerMapping(['Sales'], {
        overrides: { Sales: { kind: 'role', role: 'profit' as any } },
      })
      expect.unreachable('an unknown role must be refused')
    } catch (error) {
      expect(isImportError(error)).toBe(true)
      expect((error as ImportError).code).toBe('IMPORT_TARGET_INVALID')
    }
  })
})

describe('ledgerEntryFor', () => {
  it('finds an entry by any spelling of its name', () => {
    const mapping = buildLedgerMapping(['Sundry Debtors'])
    expect(ledgerEntryFor(mapping, ' sundry  DEBTORS ')?.key).toBe('sundry debtors')
  })

  it('answers null for a ledger the import never mentioned', () => {
    expect(ledgerEntryFor(buildLedgerMapping(['Sales']), 'Rent')).toBeNull()
  })
})

describe('a batch is a proposal, and placement is derived from a table it can replace', () => {
  const batch = createImportBatch({
    source: SOURCE,
    documents: [
      document({
        lines: [
          line({ lineNumber: 1, ledger: 'Sales Accounts' }),
          line({ lineNumber: 2, ledger: 'Delivery Charges' }),
        ],
      }),
    ],
    receipts: [receipt({ ledger: 'Bank Accounts' })],
  })
  const mapped = remapLedgers(batch, {})

  it('collects every ledger the rows name, documents first, then vouchers', () => {
    expect(ledgerMentions(batch)).toEqual(['Sales Accounts', 'Delivery Charges', 'Bank Accounts'])
  })

  it('reports the one it could not place, naming how many rows use it', () => {
    const issues = ledgerIssues(mapped)
    expect(issues.map((issue) => issue.code)).toEqual(['UNMAPPED_LEDGER'])
    expect(issues[0]?.message).toContain('Delivery Charges')
    expect(issues[0]?.message).toContain('1 imported row')
  })

  it('will not be written while a ledger is unplaced', () => {
    const readiness = readinessOf(mapped)
    expect(readiness.isReadyToWrite).toBe(false)
    expect(readiness.unmappedLedgers).toEqual(['Delivery Charges'])
    expect(readiness.errorCount).toBe(1)
  })

  it('is fixed by replacing ONE table, and the rows are untouched', () => {
    const fixed = remapLedgers(mapped, {
      overrides: { 'Delivery Charges': { kind: 'role', role: 'sales' } },
    })
    expect(readinessOf(fixed).isReadyToWrite).toBe(true)
    /* The point of keeping placement off the rows: a revision cannot disagree with itself
     * row by row, because no row ever held a placement. */
    expect(fixed.documents).toEqual(mapped.documents)
    expect(fixed.receipts).toEqual(mapped.receipts)
  })

  it('lets a user send a ledger to Suspense — but only by saying so', () => {
    const fixed = remapLedgers(mapped, {
      overrides: { 'Delivery Charges': { kind: 'role', role: 'suspense' } },
    })
    expect(ledgerEntryFor(fixed.ledgers, 'Delivery Charges')?.resolution).toMatchObject({
      kind: 'role',
      role: 'suspense',
    })
    expect(readinessOf(fixed).isReadyToWrite).toBe(true)
  })

  it('treats an ignored ledger as settled, not as a hole', () => {
    const fixed = remapLedgers(mapped, {
      overrides: { 'Delivery Charges': { kind: 'ignore' } },
    })
    expect(ledgerIssues(fixed)).toEqual([])
    expect(readinessOf(fixed).isReadyToWrite).toBe(true)
  })

  it('counts an ambiguous ledger as blocking too, and separately from an unplaced one', () => {
    const ambiguous = remapLedgers(mapped, {
      chart: [
        { code: '6500', name: 'Delivery Charges' },
        { code: '6510', name: 'delivery charges' },
      ],
    })
    const readiness = readinessOf(ambiguous)
    expect(readiness.ambiguousLedgers).toEqual(['Delivery Charges'])
    expect(readiness.unmappedLedgers).toEqual([])
    expect(readiness.isReadyToWrite).toBe(false)
  })

  it('keeps what reading the files found separate from what placing them found', () => {
    const withIssue = {
      ...mapped,
      issues: [{ code: 'UNMAPPED_COLUMN' as const, severity: 'warning' as const, message: 'x' }],
    }
    expect(withIssue.issues).toHaveLength(1)
    expect(allIssues(withIssue).map((issue) => issue.code)).toEqual([
      'UNMAPPED_COLUMN',
      'UNMAPPED_LEDGER',
    ])
  })
})

describe('accountsToCreate', () => {
  it('drops an account whose name the chart already has, however it is spelled', () => {
    const batch = createImportBatch({
      source: SOURCE,
      accounts: [account(), account({ sourceId: '2410', name: 'Duty Drawback Receivable' })],
    })
    expect(
      accountsToCreate(batch, [{ code: '4150', name: '  consultancy   INCOME ' }]).map(
        (row) => row.sourceId,
      ),
    ).toEqual(['2410'])
  })

  it('creates everything when the chart has none of it', () => {
    const batch = createImportBatch({ source: SOURCE, accounts: [account()] })
    expect(accountsToCreate(batch, [])).toHaveLength(1)
  })
})

describe('fingerprints', () => {
  it('is the same for the same content, twice', () => {
    expect(document().fingerprint).toBe(document().fingerprint)
  })

  it('does not move when the row moves, so a re-export is still recognisable', () => {
    const first = document({ provenance: [{ file: 'a.csv', line: 2, rowNumber: 1 }] })
    const later = document({ provenance: [{ file: 'a.csv', line: 900, rowNumber: 400 }] })
    expect(first.fingerprint).toBe(later.fingerprint)
  })

  it('changes with the number, the date, the party and the total', () => {
    const base = document().fingerprint
    expect(document({ number: 'INV-2' }).fingerprint).not.toBe(base)
    expect(document({ date: '2027-05-05' }).fingerprint).not.toBe(base)
    expect(document({ partyName: 'Nilgiri Traders' }).fingerprint).not.toBe(base)
    expect(document({ statedTotal: '999.00' }).fingerprint).not.toBe(base)
  })

  it('uses the source id for the party when there is one, and the name when there is not', () => {
    expect(document({ partySourceId: '4207' }).fingerprint).not.toBe(document().fingerprint)
  })

  it('folds a party name the way the CSV module folds a narration', () => {
    const one = document({ kind: 'credit-note', partyName: 'X' })
    const two = document({ kind: 'credit-note', partyName: 'X ' })
    expect(one.fingerprint).toBe(two.fingerprint)
  })

  it('falls back to the lines when the source stated no total', () => {
    const priced = document({
      statedTotal: undefined,
      lines: [line({ quantity: '2.000', unitPrice: '100.00', discount: '0.00' })],
    })
    const stated = document({ statedTotal: '200.00' })
    expect(priced.fingerprint).toBe(stated.fingerprint)
  })

  it('adds up the lines the way a document line is priced', () => {
    expect(
      stagedSubtotal({
        lines: [
          line({ quantity: '2.000', unitPrice: '100.00', discount: '25.00' }),
          line({ quantity: '0.500', unitPrice: '10.00', discount: '0.00' }),
        ],
      }),
    ).toBe('180.00')
  })

  it('leaves the source system’s own voucher number OUT of a voucher fingerprint', () => {
    expect(receipt({ number: 'CP-1' }).fingerprint).toBe(receipt({ number: 'CP-2' }).fingerprint)
  })

  it('puts the BANK reference in, which is what makes it sharp', () => {
    expect(receipt({ reference: 'UTR-1' }).fingerprint).not.toBe(receipt().fingerprint)
    expect(receipt({ reference: 'UTR-1' }).fingerprint).not.toBe(
      receipt({ reference: 'UTR-2' }).fingerprint,
    )
  })
})

describe('taggedText — the two things that share the narration slot', () => {
  /*
   * Handed the collision rather than trusted to avoid one. The five document kinds are a
   * closed set and none is a prefix of another, so a plain concatenation is injective over
   * the kinds that EXIST — which would make the length prefix a guard the real data cannot
   * exercise. So the test supplies the pair that breaks it (CONVENTIONS §6).
   */
  it('cannot be collided by moving a character from the tag into the value', () => {
    expect(taggedText('ab', 'c')).not.toBe(taggedText('a', 'bc'))
  })

  it('is stable, and different for different inputs', () => {
    expect(taggedText('credit-note', 'X')).toBe(taggedText('credit-note', 'X'))
    expect(taggedText('credit-note', 'X')).not.toBe(taggedText('credit', 'noteX'))
  })
})

describe('two identical transactions on one day are two transactions', () => {
  const batch = createImportBatch({
    source: SOURCE,
    receipts: [
      receipt({ sourceId: 'cp-1', number: 'CP-1' }),
      receipt({ sourceId: 'cp-2', number: 'CP-2' }),
      receipt({ sourceId: 'cp-3', number: 'CP-3', reference: 'UTR-9' }),
    ],
  })

  it('keeps both, and does not collapse them', () => {
    expect(batch.receipts).toHaveLength(3)
  })

  it('gives them ONE fingerprint, which is the limit the caller has to know about', () => {
    expect(batch.receipts[0]?.fingerprint).toBe(batch.receipts[1]?.fingerprint)
    expect(batch.receipts[2]?.fingerprint).not.toBe(batch.receipts[0]?.fingerprint)
  })

  it('reports the repeat as POSITIONS, so a caller can compare counts and not membership', () => {
    const repeats = repeatedTransactions(batch)
    expect(repeats.size).toBe(1)
    expect([...repeats.values()]).toEqual([[0, 1]])
  })

  it('numbers those positions across documents first, then vouchers', () => {
    const mixed = createImportBatch({
      source: SOURCE,
      documents: [document()],
      receipts: batch.receipts,
    })
    expect(stagedTransactions(mixed).map((row) => [row.collection, row.sourceId])).toEqual([
      ['documents', 'inv-1'],
      ['receipts', 'cp-1'],
      ['receipts', 'cp-2'],
      ['receipts', 'cp-3'],
    ])
    expect([...repeatedTransactions(mixed).values()]).toEqual([[1, 2]])
  })
})

describe('summariseBatch', () => {
  it('counts the rows and not only the collections', () => {
    const batch = remapLedgers(
      createImportBatch({
        source: SOURCE,
        documents: [
          document({
            lines: [line({ lineNumber: 1, ledger: 'Sales' }), line({ lineNumber: 2 })],
          }),
        ],
        receipts: [
          receipt({ allocations: [{ documentNumber: 'INV-1', amount: '500.00', provenance: [] }] }),
        ],
        accounts: [account()],
      }),
      {},
    )
    expect(summariseBatch(batch)).toMatchObject({
      accounts: 1,
      documents: 1,
      documentLines: 2,
      receipts: 1,
      allocations: 1,
      ledgers: 1,
      ledgersUnmapped: 0,
    })
  })
})

describe('opening balances are their own collection', () => {
  it('carries a role where the shape of the data fixes the account', () => {
    const batch = createImportBatch({
      source: SOURCE,
      openingBalanceDate: '2027-04-01',
      openingBalances: [
        {
          sourceId: 'opening:1',
          ledger: { kind: 'role', role: 'accounts-receivable' },
          partySourceId: '4207',
          amount: '450000.00',
          provenance: [],
        },
      ],
    })
    /* A role reference names no ledger, so it contributes nothing to the mapping — there
     * is nothing for a user to place. */
    expect(ledgerMentions(batch)).toEqual([])
    expect(summariseBatch(batch).openingBalances).toBe(1)
  })

  it('carries a ledger NAME where the source named one, and that does need placing', () => {
    const batch = remapLedgers(
      createImportBatch({
        source: SOURCE,
        openingBalances: [
          {
            sourceId: 'opening:2',
            ledger: { kind: 'name', ledger: 'Sundry Debtors' },
            amount: '450000.00',
            provenance: [],
          },
        ],
      }),
      {},
    )
    expect(ledgerMentions(batch)).toEqual(['Sundry Debtors'])
    expect(batch.ledgers[0]?.resolution).toMatchObject({
      kind: 'role',
      role: 'accounts-receivable',
    })
  })
})
