/*
 * THE TALLY IMPORTER. Import from here, not from the files beside it.
 *
 * The second importer, and the hard one. Zoho exports one CSV per entity with a heading
 * row that says what each column is; Tally exports one XML stream in which a customer, a
 * bank account and an expense are the same element with the same children, and what
 * distinguishes them is a chain of parent groups that may or may not be in the file.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE TRUSTING ANY ELEMENT NAME IN THIS FOLDER.
 *
 * There was NO SAMPLE EXPORT and no access to Tally when this was written. Every element
 * name is a best-effort default, and the design compensates in four ways, all of which are
 * argued out in `elements.ts`:
 *
 *   - every name is a LIST OF CANDIDATES, matched with case and spacing folded, so
 *     `<Amount>` and `<AMOUNT>` are one field where XML would call them two;
 *   - every name is OVERRIDABLE (`TallyImportOptions.elements`) without a code change;
 *   - two candidates that both carry a value and DISAGREE resolve to nothing and are
 *     reported, never to whichever this file lists first;
 *   - every element the reader met and no field claimed is REPORTED, and every distinct
 *     element name in the file is recorded on `ImportedFile.headings`.
 *
 * THOSE LAST TWO ARE THE ANSWER TO "WHAT IF A NAME HERE IS WRONG". A field looked for
 * under the wrong name shows up in the same batch as an element nobody claimed, with the
 * line it is on, beside a `headings` list of every name the file actually used. The
 * diagnosis is a glance at the import report; the fix is one entry in `elements`; neither
 * needs a rebuild and neither needs the file to be opened.
 *
 * The tables that are NOT element names — which groups mean what, which voucher types map
 * where, what a bill type does — are arguments with defaults, for the same reason and with
 * the same escape hatch.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES THAT THE OTHERS CANNOT: everything that needs the WHOLE export.
 *
 * A Tally export routinely arrives as two files (`Masters.xml` and `Vouchers.xml`), in
 * either order, and even one file lists a ledger after the voucher that uses it. So five
 * things can only be answered once every file has been read, and all five are here:
 *
 *   THE CHART      is built from every `GROUP` and `LEDGER` in every file, and only then
 *                  is any ledger classified. Nothing resolves during the walk.
 *
 *   THE VOUCHERS   are classified against that finished chart, from the flat records the
 *                  walk produced. The XML is long gone by then — see `read.ts`.
 *
 *   MISSING        a voucher naming a ledger no master describes still has a party: the
 *   PARTIES        voucher is proof they exist. A minimal party is staged from it and it
 *                  is REPORTED, the same trade the Zoho importer makes and for the same
 *                  reason — inventing a PARTY records a name the file already contains,
 *                  where inventing an ACCOUNT would decide where money lands.
 *
 *   ITEM SIDES     an item on a sales voucher is sold and one on a purchase voucher is
 *                  bought. An item no voucher mentions is both, because Tally has no flag
 *                  restricting a stock item to one side.
 *
 *   THE LEDGER     is built last, over every ledger name every voucher mentioned, so a
 *   MAPPING        ledger used by four vouchers is one row on the mapping screen with a
 *                  usage count of four.
 *
 * ---------------------------------------------------------------------------
 * THREE ISSUE CODES ARE BORROWED, AND THE REPORT SAYS WHICH.
 *
 * `BatchIssueCode` is closed and lives in `model.ts`, which this batch does not own. Tally
 * raises three facts it has no code for, so each uses the closest one and carries a `field`
 * that says what it really is:
 *
 *   an unrecognised or unhomeable    `UNKNOWN_ACCOUNT_TYPE`, `field: 'voucherType'`
 *   VOUCHER TYPE
 *   an element no field claims, and  `UNMAPPED_COLUMN`, `heading` or `field: 'encoding'`
 *   the XML reader's own two issues
 *   a voucher that does not balance  `INVALID_AMOUNT` — whose own doc comment already says
 *                                    "a debit/credit pair did not resolve", so this one is
 *                                    a borrowing only in that it is not per-cell
 *
 * The integration step should add `UNKNOWN_VOUCHER_TYPE`, `UNMAPPED_ELEMENT` and
 * `UNBALANCED_VOUCHER`, and `xml/errors.ts` already asks for the shared issue module that
 * would hold them.
 */

import {
  buildLedgerMapping,
  createImportBatch,
  ledgerMentions,
  repeatedTransactions,
  stagedTransactions,
  type BatchIssue,
  type ImportBatch,
  type LedgerMappingOptions,
  type StagedDocument,
  type StagedParty,
  type StagedReceipt,
} from '../model'
import type { XmlParseOptions } from '../xml'
import {
  TALLY_GROUPS,
  type TallyBillTypeRule,
  type TallyGroupRule,
  type TallyVoucherTypeRule,
} from './classify'
import { elementKey, tallyElements, type TallyElementOverrides } from './elements'
import { buildTallyChart, stageTallyItems, stageTallyLedgers, stageTallyUnits } from './masters'
import { readTallyFiles, type TallyFile } from './read'
import { stageTallyVoucher, type TallyStagedVoucher } from './vouchers'

import type { ReceiptKindDefinition } from '@shared/receipts'
import type { DateString } from '@shared/scalars'

export {
  TALLY_ELEMENTS,
  elementKey,
  elementNamesIn,
  tallyChildren,
  tallyElementSpec,
  tallyElements,
  tallyText,
  tallyValue,
  unclaimedChildren,
} from './elements'
export type {
  TallyChildren,
  TallyElementName,
  TallyElementOverrides,
  TallyElementSpec,
  TallySpace,
  TallyValue,
} from './elements'

export {
  TALLY_BILL_TYPES,
  TALLY_GROUPS,
  TALLY_VOUCHER_TYPES,
  classifyTallyLedger,
  tallyBillTreatment,
  tallyReceiptKind,
  tallyVoucherTarget,
} from './classify'
export type {
  TallyBillLookup,
  TallyBillTreatment,
  TallyBillTypeRule,
  TallyGroupRule,
  TallyLedgerRole,
  TallyReceiptLookup,
  TallyVoucherLookup,
  TallyVoucherTarget,
  TallyVoucherTypeRule,
} from './classify'

export {
  parseTallyAmount,
  parseTallyCount,
  parseTallyDate,
  parseTallyDays,
  parseTallyFlag,
  tallyEntrySide,
} from './values'
export type { TallyEntrySide, TallySideReading } from './values'

export { liftXmlIssue, readTallyFiles } from './read'
export type {
  TallyFile,
  TallyRawAllocation,
  TallyRawEntry,
  TallyRawLedger,
  TallyRawStockItem,
  TallyRawUnit,
  TallyRawVoucher,
  TallyReadOptions,
  TallyReading,
} from './read'

export {
  buildTallyChart,
  chartLedgerOf,
  chartRoleOf,
  openingAmountFor,
  openingBalanceOf,
  stageTallyItems,
  stageTallyLedgers,
  stageTallyUnits,
} from './masters'
export type { ItemUsage, StagedLedgers, TallyChart } from './masters'

export { balanceOf, stageTallyVoucher } from './vouchers'
export type { TallyStagedVoucher, TallyVoucherOptions } from './vouchers'

export interface TallyImportOptions {
  /** Corrections to the element names in `elements.ts`. Replaces, never adds. */
  readonly elements?: TallyElementOverrides
  /**
   * Which Tally voucher type is what.
   *
   * REPLACES `TALLY_VOUCHER_TYPES` entirely rather than merging into it, which is the same
   * contract `LedgerMappingOptions.synonyms` has. Adding a company's own type is
   * `[...TALLY_VOUCHER_TYPES, { names: ['Cash Sales'], target: ... }]` — explicit about
   * what is being kept, and it lets a caller REMOVE a default as well as add to it, which
   * a merge cannot express.
   */
  readonly voucherTypes?: readonly TallyVoucherTypeRule[]
  /** Which Tally group means what. Replaces `TALLY_GROUPS`, for the same reason. */
  readonly groups?: readonly TallyGroupRule[]
  /** What a `BILLTYPE` does. Replaces `TALLY_BILL_TYPES`. */
  readonly billTypes?: readonly TallyBillTypeRule[]
  /** The voucher-kind table a receipt's direction and side are looked up in. */
  readonly receiptKinds?: readonly ReceiptKindDefinition[]
  /** The chart to map onto, the user's overrides, the synonym table. See `../model.ts`. */
  readonly ledgers?: LedgerMappingOptions
  /**
   * The date the opening balances are as at — in practice the first day of the fiscal year.
   *
   * A Tally `LEDGER` carries an `OPENINGBALANCE` and no date to go with it: the date is a
   * property of the COMPANY's books-beginning, not of the ledger. So the caller supplies
   * one. Without it the balances are still staged and the batch reports that it cannot be
   * written — choosing a date on the user's behalf would put money in a period they did
   * not pick, and the Zoho importer refuses in exactly the same words.
   */
  readonly openingBalanceDate?: DateString
  readonly xml?: XmlParseOptions
}

/**
 * Read a whole Tally export into one proposal.
 *
 * PURE. Nothing here opens a file, allocates an id, or writes anything. Give it the same
 * text twice and it produces the same batch, fingerprints included.
 *
 * @throws XmlError when a file is not well-formed XML, carries a `<!DOCTYPE`, or exceeds
 *   one of the reader's caps. A malformed XML document has no rows to salvage.
 * @throws ImportError when an element correction or a ledger override is malformed.
 */
export function importTallyXml(
  files: readonly TallyFile[],
  options: TallyImportOptions = {},
): ImportBatch {
  const elements = tallyElements(options.elements)
  const reading = readTallyFiles(files, {
    elements,
    ...(options.xml === undefined ? {} : { xml: options.xml }),
  })

  const issues: BatchIssue[] = [...reading.issues]
  const chart = buildTallyChart(
    reading.ledgers,
    reading.groupParents,
    options.groups ?? TALLY_GROUPS,
    issues,
  )

  const { parties, accounts, openingBalances } = stageTallyLedgers(reading.ledgers, chart)

  const documents: StagedDocument[] = []
  const receipts: StagedReceipt[] = []
  const staged: TallyStagedVoucher[] = []
  for (const voucher of reading.vouchers) {
    const outcome = stageTallyVoucher(
      voucher,
      chart,
      {
        ...(options.voucherTypes === undefined ? {} : { voucherTypes: options.voucherTypes }),
        ...(options.billTypes === undefined ? {} : { billTypes: options.billTypes }),
        ...(options.receiptKinds === undefined ? {} : { receiptKinds: options.receiptKinds }),
      },
      issues,
    )
    if (outcome === null) {
      continue
    }
    staged.push(outcome)
    if (outcome.document !== null) {
      documents.push(outcome.document)
    }
    if (outcome.receipt !== null) {
      receipts.push(outcome.receipt)
    }
  }

  const withInvented = [...parties, ...inventedParties(staged, parties, issues)]
  const items = stageTallyItems(reading.stockItems, itemUsage(staged), issues)
  const units = stageTallyUnits(reading.units, reading.stockItems)

  reportUnknownAllocationTargets(receipts, documents, issues)
  reportDuplicateSourceIds('ledger', reading.ledgers, issues)
  reportDuplicateSourceIds('stock item', reading.stockItems, issues)
  reportDuplicateSourceIds('voucher', reading.vouchers, issues)

  const openingBalanceDate = options.openingBalanceDate ?? null
  if (openingBalances.length > 0 && openingBalanceDate === null) {
    issues.push({
      code: 'MISSING_VALUE',
      severity: 'error',
      message:
        `This export carries opening balances for ${String(openingBalances.length)} ledgers and ` +
        'no date to enter them as at. Tell Coffer which day the books open on — usually the ' +
        'first day of the year you are starting from.',
    })
  }

  const batch = createImportBatch({
    source: { system: 'tally', label: 'Tally', files: reading.files },
    units,
    accounts,
    parties: withInvented,
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

/**
 * Parties a voucher names that no `LEDGER` master describes.
 *
 * A vouchers-only export is an ordinary thing to be handed, and it names every customer it
 * traded with. Dropping those transactions because the masters were not included would
 * throw away the part of the import the user cares about most, so the party is created
 * from the transaction and REPORTED — the same trade `zoho/index.ts` makes.
 *
 * The side comes from the staged voucher, which got it from the document table or from the
 * receipt lookup, so a firm you both buy from and sell to ends up with both flags: each
 * transaction adds one and nothing takes one away.
 */
function inventedParties(
  staged: readonly TallyStagedVoucher[],
  known: readonly StagedParty[],
  issues: BatchIssue[],
): readonly StagedParty[] {
  const alreadyStaged = new Set(known.map((party) => elementKey(party.name)))
  const sides = new Map<string, { name: string; sourceId: string | null; sides: Set<string> }>()
  for (const voucher of staged) {
    const key = elementKey(voucher.partyName)
    if (alreadyStaged.has(key)) {
      continue
    }
    const already = sides.get(key)
    if (already === undefined) {
      sides.set(key, {
        name: voucher.partyName,
        sourceId: voucher.partySourceId,
        sides: new Set([voucher.side]),
      })
    } else {
      already.sides.add(voucher.side)
    }
  }

  const invented: StagedParty[] = []
  for (const [key, party] of sides) {
    issues.push({
      code: 'PARTY_NOT_FOUND',
      severity: 'warning',
      message:
        `${JSON.stringify(party.name)} is on a voucher in this export and no ledger master ` +
        'places them under a customer or supplier group, so Coffer has created them from the ' +
        'voucher. Check their address and tax details before you invoice them.',
      sourceId: party.sourceId ?? key,
      value: party.name,
    })
    invented.push({
      sourceId: party.sourceId ?? `ledger:${key}`,
      name: party.name,
      isCustomer: party.sides.has('sales'),
      isVendor: party.sides.has('purchase'),
      provenance: [],
    })
  }
  return invented
}

/** Which stock items were sold and which were bought, from the vouchers that named them. */
function itemUsage(staged: readonly TallyStagedVoucher[]): {
  sold: ReadonlySet<string>
  purchased: ReadonlySet<string>
} {
  const sold = new Set<string>()
  const purchased = new Set<string>()
  for (const voucher of staged) {
    const into = voucher.side === 'sales' ? sold : purchased
    for (const item of voucher.stockItems) {
      into.add(elementKey(item))
    }
  }
  return { sold, purchased }
}

/**
 * Allocations pointing at a document this export does not contain.
 *
 * A WARNING, deliberately. The invoice may be in Coffer already, may have been raised
 * before the cutover, or may simply not have been in the export's date range — all three
 * are ordinary, and the money is still real. The write step keeps the voucher and leaves
 * that much on account, which is a state Coffer models properly.
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
          `${JSON.stringify(receipt.number)} settles ` +
          `${JSON.stringify(allocation.documentNumber)}, which is not in this export. That much ` +
          'has been left on account — match it by hand once the document is in Coffer.',
        ...(first === undefined
          ? {}
          : { file: first.file, line: first.line, rowNumber: first.rowNumber }),
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
 * holding it means one of them is silently lost at write time — and which one depends on
 * the order the writer happens to iterate in. In a Tally export this is what a duplicated
 * `GUID` looks like, which happens when two companies' data have been merged.
 */
function reportDuplicateSourceIds(
  what: string,
  rows: readonly { sourceId: string }[],
  issues: BatchIssue[],
): void {
  const counts = new Map<string, number>()
  for (const row of rows) {
    counts.set(row.sourceId, (counts.get(row.sourceId) ?? 0) + 1)
  }
  for (const [sourceId, count] of counts) {
    if (count > 1) {
      issues.push({
        code: 'DUPLICATE_SOURCE_ID',
        severity: 'error',
        message:
          `${String(count)} ${what} records in this export share the identifier ` +
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
 * know is that a duplicate CHECK against their existing books has to compare counts here,
 * and what they need to see is both rows.
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
        `${String(positions.length)} transactions in this export look identical — same day, ` +
        `same amount, same party, no reference to tell them apart: ${identifiers.join(', ')}. ` +
        'They have all been kept, because two identical payments on one day are two real ' +
        'payments.',
      value: fingerprint,
    })
  }
}
