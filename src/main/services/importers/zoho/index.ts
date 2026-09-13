/*
 * THE ZOHO BOOKS IMPORTER. Import from here, not from the files beside it.
 *
 * Zoho exports one CSV per entity — contacts, items, a chart of accounts, invoices, credit
 * notes, bills and the two payment registers — so this is the most MECHANICAL of the three
 * importers planned, which is exactly why it was built first: the target model
 * (`../model.ts`) had to be discovered against something whose own shape was not also in
 * question. Tally's XML and Vyapar's single-file exports are harder problems and they now
 * have a target to hit rather than a target to design.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES THAT `read.ts` CANNOT: the cross-file work.
 *
 * A single file is read in isolation and knows nothing about the others. Five things can
 * only be answered once every file has been read, and all five are here:
 *
 *   UNITS         are not exported as an entity at all. Zoho writes `Usage unit` as free
 *                 text on items and on document lines, so the units of an import are
 *                 whatever those columns actually contained — collected, de-duplicated by
 *                 upper-cased code, and each keeping the first row that mentioned it.
 *
 *   PARTY ROLES   are often not in the contacts file, and are always in the transactions:
 *                 a firm on an invoice is a customer and a firm on a bill is a vendor. The
 *                 side comes off `DOCUMENT_KINDS` and `RECEIPT_KINDS` rather than out of a
 *                 condition on the kind, so a kind added later gets the right answer by
 *                 declaring itself (CONVENTIONS §1.9).
 *
 *   MISSING       a document naming a party the contacts file does not have is not a
 *   PARTIES       reason to drop the document — the party is the one thing a document
 *                 cannot do without, and the transaction is proof they exist. So a minimal
 *                 party is staged from the transaction and it is REPORTED. Note the
 *                 difference from an account: inventing an ACCOUNT decides where money
 *                 lands, which is a judgement nobody made; inventing a PARTY records a
 *                 name the file already contains.
 *
 *   ALLOCATIONS   name a document NUMBER, and the document may be in another file, already
 *                 in Coffer, or from before the cutover. An allocation whose target this
 *                 export does not contain is a warning, never an error.
 *
 *   THE LEDGER    is built last, over every ledger name every file mentioned, so that a
 *   MAPPING       ledger used by both an item and an invoice line is one row on the
 *                 mapping screen with a usage count of two.
 *
 * ---------------------------------------------------------------------------
 * THE HEADINGS ARE A BEST-EFFORT DEFAULT. Read the header of `columns.ts` before trusting
 * any column name in this importer: there was no sample export available when it was
 * written, Zoho's headings vary by account settings and region, and the design compensates
 * by making every heading overridable, reporting every column it did not recognise, and
 * recording the headings it actually saw on every `ImportedFile`.
 */

import { definitionOf, type TradeSide } from '@shared/documents'
import { receiptDefinitionOf } from '@shared/receipts'
import type { DateString } from '@shared/scalars'

import {
  buildLedgerMapping,
  createImportBatch,
  ledgerMentions,
  repeatedTransactions,
  stagedTransactions,
  type BatchIssue,
  type ImportBatch,
  type ImportedFile,
  type LedgerMappingOptions,
  type StagedAccount,
  type StagedDocument,
  type StagedItem,
  type StagedOpeningBalance,
  type StagedParty,
  type StagedReceipt,
  type StagedUnit,
} from '../model'
import { readZohoFile, type ZohoFile, type ZohoReadOptions } from './read'

export {
  ZOHO_ENTITIES,
  ZOHO_ENTITY_DEFINITIONS,
  ZOHO_DEFAULT_DATE_FORMAT,
  isZohoEntity,
  zohoColumnMap,
  zohoDateFields,
  zohoEntityDefinition,
} from './columns'
export type {
  ZohoColumnOverrides,
  ZohoEntity,
  ZohoEntityDefinition,
  ZohoEntityShape,
} from './columns'

export { agreedValue, cell, groupRecords, readZohoFile } from './read'
export type { Agreement, RowGroup, ZohoFile, ZohoFileOutcome, ZohoReadOptions } from './read'

export interface ZohoImportOptions extends ZohoReadOptions {
  /** The chart to map onto, the user's overrides, the synonym table. See `../model.ts`. */
  readonly ledgers?: LedgerMappingOptions
  /**
   * The date the opening balances are as at — in practice the first day of the fiscal year.
   *
   * A Zoho contacts export carries an `Opening Balance` with no date to go with it, so the
   * caller supplies one. Without it the balances are still staged and the batch reports
   * that it cannot be written: an opening figure with no date has nowhere to post, and
   * choosing a date on the user's behalf would put money in a period they did not pick.
   */
  readonly openingBalanceDate?: DateString
}

/**
 * Read a whole Zoho Books export into one proposal.
 *
 * PURE. Nothing here opens a file, allocates an id, or writes anything. Give it the same
 * text twice and it produces the same batch, fingerprints included.
 *
 * @throws CsvError when a file is not something this build will read at all — see the caps
 *   in csv/parse.ts.
 * @throws ImportError when a column correction or a ledger override is malformed.
 */
export function importZohoBooks(
  files: readonly ZohoFile[],
  options: ZohoImportOptions = {},
): ImportBatch {
  const read: ImportedFile[] = []
  const issues: BatchIssue[] = []
  const accounts: StagedAccount[] = []
  const parties: StagedParty[] = []
  const items: StagedItem[] = []
  const openingBalances: StagedOpeningBalance[] = []
  const documents: StagedDocument[] = []
  const receipts: StagedReceipt[] = []

  for (const file of files) {
    const outcome = readZohoFile(file, options)
    read.push(outcome.file)
    issues.push(...outcome.issues)
    accounts.push(...outcome.accounts)
    parties.push(...outcome.parties)
    items.push(...outcome.items)
    openingBalances.push(...outcome.openingBalances)
    documents.push(...outcome.documents)
    receipts.push(...outcome.receipts)
  }

  const withRoles = applyPartyRoles(parties, documents, receipts, issues)
  const units = collectUnits(items, documents)

  reportUnknownAllocationTargets(receipts, documents, issues)
  reportDuplicateSourceIds('account', accounts, issues)
  reportDuplicateSourceIds('contact', withRoles, issues)
  reportDuplicateSourceIds('item', items, issues)
  reportDuplicateSourceIds('document', documents, issues)
  reportDuplicateSourceIds('payment', receipts, issues)

  const openingBalanceDate = options.openingBalanceDate ?? null
  if (openingBalances.length > 0 && openingBalanceDate === null) {
    issues.push({
      code: 'MISSING_VALUE',
      severity: 'error',
      message:
        `This export carries opening balances for ${String(openingBalances.length)} contacts and ` +
        'no date to enter them as at. Tell Coffer which day the books open on — usually the ' +
        'first day of the year you are starting from.',
    })
  }

  const batch = createImportBatch({
    source: { system: 'zoho', label: 'Zoho Books', files: read },
    units,
    accounts,
    parties: withRoles,
    items,
    openingBalances,
    openingBalanceDate,
    documents,
    receipts,
    issues,
  })

  reportRepeatedTransactions(batch, issues)

  return {
    ...batch,
    issues,
    ledgers: buildLedgerMapping(ledgerMentions(batch), {
      ...(options.ledgers ?? {}),
      newAccounts: options.ledgers?.newAccounts ?? accounts,
    }),
  }
}

// ---- Cross-file passes ----------------------------------------------------

/** How a party is matched between files: the source id where there is one, the name if not. */
function partyKey(party: { sourceId?: string; name: string }): string {
  return party.sourceId ?? `name:${party.name.trim().toLowerCase()}`
}

function transactionPartyKey(transaction: { partySourceId?: string; partyName: string }): string {
  return transaction.partySourceId ?? `name:${transaction.partyName.trim().toLowerCase()}`
}

/**
 * Work out who is a customer and who is a vendor from the transactions, and stage anybody
 * the contacts file left out.
 *
 * The side comes off the document and receipt TABLES rather than out of a test on the
 * kind. A firm that is both — which is the ordinary case in a small business, and the
 * reason `Party` is one record with two flags rather than two tables (migration 0005) —
 * ends up with both flags set, because each transaction adds one and nothing takes one
 * away.
 */
function applyPartyRoles(
  parties: readonly StagedParty[],
  documents: readonly StagedDocument[],
  receipts: readonly StagedReceipt[],
  issues: BatchIssue[],
): readonly StagedParty[] {
  const sides = new Map<string, Set<TradeSide>>()
  const named = new Map<string, { name: string; sourceId?: string }>()

  const note = (key: string, side: TradeSide, name: string, sourceId: string | undefined): void => {
    const already = sides.get(key)
    if (already === undefined) {
      sides.set(key, new Set([side]))
    } else {
      already.add(side)
    }
    if (!named.has(key)) {
      named.set(key, { name, sourceId })
    }
  }

  for (const document of documents) {
    note(
      transactionPartyKey(document),
      definitionOf(document.kind).side,
      document.partyName,
      document.partySourceId,
    )
  }
  for (const receipt of receipts) {
    note(
      transactionPartyKey(receipt),
      receiptDefinitionOf(receipt.kind).side,
      receipt.partyName,
      receipt.partySourceId,
    )
  }

  const known = new Set(parties.map((party) => partyKey(party)))
  const updated = parties.map((party) => {
    const seen = sides.get(partyKey(party))
    if (seen === undefined) {
      return party
    }
    return {
      ...party,
      isCustomer: party.isCustomer || seen.has('sales'),
      isVendor: party.isVendor || seen.has('purchase'),
    }
  })

  const invented: StagedParty[] = []
  for (const [key, seen] of sides) {
    if (known.has(key)) {
      continue
    }
    const details = named.get(key)
    if (details === undefined) {
      continue
    }
    issues.push({
      code: 'PARTY_NOT_FOUND',
      severity: 'warning',
      message:
        `${JSON.stringify(details.name)} is on a transaction in this export but is not in its ` +
        'contacts file, so Coffer has created them from the transaction. Check their address ' +
        'and tax details before you invoice them.',
      sourceId: details.sourceId ?? key,
      value: details.name,
    })
    invented.push({
      sourceId: details.sourceId ?? key,
      name: details.name,
      isCustomer: seen.has('sales'),
      isVendor: seen.has('purchase'),
      provenance: [],
    })
  }

  return [...updated, ...invented]
}

/**
 * The units an import needs, collected from wherever a unit was written.
 *
 * `UnitOfMeasure.code` is the identity and is upper case, so `Pcs`, `pcs` and `PCS` are one
 * unit; `label` keeps what the file said, which is what a user recognises when Coffer asks
 * them to confirm it. `decimalPlaces` is left absent — the export does not say, and
 * choosing would either make half a metre unrepresentable or let somebody invoice a third
 * of a box.
 */
function collectUnits(
  items: readonly StagedItem[],
  documents: readonly StagedDocument[],
): readonly StagedUnit[] {
  const units = new Map<string, StagedUnit>()
  const add = (label: string | undefined, provenance: StagedUnit['provenance']): void => {
    if (label === undefined) {
      return
    }
    const code = label.trim().toUpperCase()
    if (code === '' || units.has(code)) {
      return
    }
    units.set(code, { code, label: label.trim(), provenance })
  }

  for (const item of items) {
    add(item.unitLabel, item.provenance)
  }
  for (const document of documents) {
    for (const line of document.lines) {
      add(line.unitLabel, line.provenance)
    }
  }
  return [...units.values()]
}

/**
 * Allocations pointing at a document this export does not contain.
 *
 * A WARNING, deliberately. The invoice may be in Coffer already, may have been raised
 * before the cutover, or may simply not have been included in the export's date range —
 * all three are ordinary, and the money is still real. The write step keeps the payment
 * and leaves that much on account, which is a state Coffer models properly.
 */
function reportUnknownAllocationTargets(
  receipts: readonly StagedReceipt[],
  documents: readonly StagedDocument[],
  issues: BatchIssue[],
): void {
  const numbers = new Set(documents.map((document) => document.number))
  for (const receipt of receipts) {
    for (const allocation of receipt.allocations) {
      if (numbers.has(allocation.documentNumber)) {
        continue
      }
      const first = allocation.provenance[0]
      issues.push({
        code: 'ALLOCATION_TARGET_MISSING',
        severity: 'warning',
        message:
          `${JSON.stringify(receipt.number)} settles ${JSON.stringify(allocation.documentNumber)}, ` +
          'which is not in this export. That much has been left on account — match it by hand ' +
          'once the document is in Coffer.',
        file: first?.file,
        line: first?.line,
        rowNumber: first?.rowNumber,
        sourceId: receipt.sourceId,
        value: allocation.documentNumber,
      })
    }
  }
}

/**
 * Two staged rows claiming one source identifier.
 *
 * An ERROR: the identifier is what everything else in the batch points at, so two rows
 * holding it means one of them will be silently lost at write time — and which one depends
 * on the order the writer happens to iterate in.
 */
function reportDuplicateSourceIds(
  what: string,
  rows: readonly { sourceId: string }[],
  issues: BatchIssue[],
): void {
  const positions = new Map<string, number>()
  for (const row of rows) {
    positions.set(row.sourceId, (positions.get(row.sourceId) ?? 0) + 1)
  }
  for (const [sourceId, count] of positions) {
    if (count > 1) {
      issues.push({
        code: 'DUPLICATE_SOURCE_ID',
        severity: 'error',
        message:
          `${String(count)} ${what} rows in this export share the identifier ` +
          `${JSON.stringify(sourceId)}. Coffer cannot tell them apart, so nothing has been ` +
          'imported for it.',
        sourceId,
      })
    }
  }
}

/**
 * Staged transactions that share a fingerprint.
 *
 * A WARNING, and the message says why: two identical receipts on one day are two real
 * events, not a duplicate (see the module header of `../model.ts`). What the user needs to
 * know is that a duplicate CHECK against their existing books will have to compare counts
 * here, and what they need to see is both rows.
 */
function reportRepeatedTransactions(batch: ImportBatch, issues: BatchIssue[]): void {
  const all = stagedTransactions(batch)
  for (const [fingerprint, positions] of repeatedTransactions(batch)) {
    const identifiers = positions
      .map((position) => all[position]?.sourceId)
      .filter((sourceId): sourceId is string => sourceId !== undefined)
    issues.push({
      code: 'REPEATED_TRANSACTION',
      severity: 'warning',
      message:
        `${String(positions.length)} transactions in this export look identical — same day, same ` +
        `amount, same party, no reference to tell them apart: ${identifiers.join(', ')}. They ` +
        'have all been kept, because two identical payments on one day are two real payments.',
      value: fingerprint,
    })
  }
}
