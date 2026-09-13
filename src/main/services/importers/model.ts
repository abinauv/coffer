/*
 * WHAT ONE IMPORT PRODUCES — everything, as data, before anything is written.
 *
 * Three importers are planned (Tally, Vyapar, Zoho) and this is the single target all
 * three hit. It exists ahead of the second one on purpose: the alternative is three
 * importers each inventing their own answer to "what is an unmapped ledger", and then a
 * staging table that has to hold the union of three answers.
 *
 * ---------------------------------------------------------------------------
 * THE FIVE DECISIONS. Each one is a failure mode, not a preference.
 *
 * 1. NOTHING IN HERE IS A COFFER ID.
 *
 *    A foreign file has foreign keys. An invoice row says `Customer Name: Acme Traders`
 *    and maybe `Customer ID: 4207...`, and neither of those is a Coffer party id — the
 *    party may not exist yet, may exist under a different spelling, or may be about to be
 *    created by this same import. So a staged row carries the SOURCE's identifiers and
 *    nothing else, and the resolution to real ids happens at write time, once, where the
 *    database is.
 *
 *    The consequence is the point: this whole module is PURE and RE-RUNNABLE. Reading a
 *    file produces the same batch on any machine, with no company open, with no ids
 *    allocated. A test can assert the whole shape of an import from a string.
 *
 * 2. AN IMPORT IS A PROPOSAL, NOT A WRITE.
 *
 *    Nothing here writes. There is no `id`, no `createdAt`, no entry, and no function in
 *    this file that touches a database. What a user gets to see before they commit is
 *    exactly this object: "these 12 ledgers map to these accounts, and these 3 I could
 *    not place".
 *
 *    And it has to be REVISABLE, which is why the placement of a foreign ledger is NOT
 *    stored on the rows that use it. A staged line names the ledger the way the file
 *    named it; `ImportBatch.ledgers` is a separate table from those names to Coffer
 *    targets. Fixing the three unplaced ledgers therefore replaces ONE small table
 *    (`remapLedgers`) instead of re-parsing the file or rewriting eight hundred rows, and
 *    a revision cannot possibly disagree with itself row by row.
 *
 * 3. UNMAPPED, AMBIGUOUS AND WRONG ARE THREE DIFFERENT THINGS.
 *
 *    Following the CSV module exactly (see csv/errors.ts): a REFUSAL throws — the caller
 *    asked for something this module will not do, and there is no per-row answer to give.
 *    Everything about the DATA is collected as a `BatchIssue` with a severity, and a row
 *    that cannot be placed must never abort an 800-row import.
 *
 *    `unmapped` is "I have nowhere to put this". `ambiguous` is "I have two places and
 *    picking one would be a lie" — CONVENTIONS §1.9, the `.find` trap: a lookup that takes
 *    the first match silently implements "whichever is listed first" while looking like a
 *    rule. Both are reported; neither is guessed.
 *
 * 4. THE CHART OF ACCOUNTS IS THE HARD PART, AND NOTHING HERE INVENTS AN ACCOUNT.
 *
 *    A foreign ledger name — "Sundry Debtors", "Sales Accounts", "Carriage Inwards" — has
 *    to reach either an `AccountRole` (the semantic slot the posting engine actually
 *    uses) or a specific account code in the company's own chart. `buildLedgerMapping`
 *    resolves in one fixed order, seeded with the Indian-accounting synonyms below, and
 *    an unresolved name is an ERROR that blocks the write rather than a silent new
 *    account or a silent trip to Suspense.
 *
 *    THE ESCAPE HATCH IS EXPLICIT AND AUDITABLE: a user may override any ledger to
 *    `{ kind: 'role', role: 'suspense' }` or to `{ kind: 'ignore' }`. Both are decisions
 *    somebody made and both are recorded in the mapping. What is forbidden is the
 *    software making that decision on their behalf.
 *
 * 5. OPENING BALANCES ARE THEIR OWN COLLECTION, NOT DOCUMENTS.
 *
 *    Most real imports are "everything as at 1 April". `postOpeningBalances` already
 *    exists, takes one date and a list of `{ accountId, amount, partyId? }`, and posts
 *    ONE balanced entry against `opening-balance-equity`. So `StagedOpeningBalance` maps
 *    onto `OpeningBalanceLine` and nothing else, and it is deliberately not a
 *    `StagedDocument`:
 *
 *      - The ledger is append-only and holds no drafts, so there is no state in which an
 *        opening figure is "entered but not posted". Modelling it as a document would
 *        invent one.
 *      - An opening receivable of 4,50,000 is not an invoice. Making it one would
 *        fabricate an invoice number that no customer has ever seen, a due date, and a
 *        tax treatment for a supply that was made under a different system and has
 *        already been reported in a return filed there.
 *      - `amount` is POSITIVE IN THE ACCOUNT'S NORMAL DIRECTION, exactly as
 *        `OpeningBalanceLine.amount` is, so a user's old trial balance is not translated
 *        twice.
 *      - `partySourceId` exists for the same reason `OpeningBalanceLine.partyId` does:
 *        one lump on a control account produces no aged report and can be allocated
 *        against nothing.
 *
 *    An importer that can read the actual OPEN INVOICES at cutover should stage those as
 *    documents instead and leave the control account out of `openingBalances` — that
 *    gives a real aged report. What it must never do is BOTH, and `openingBalanceDate`
 *    plus `summariseBatch` are what let a caller see which choice was made.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENCE, AND THE LIMIT THAT HAS TO BE SAID OUT LOUD
 *
 * Every staged transaction carries a `fingerprint` from the CSV module's
 * `rowFingerprint`, so re-running an import is detectable rather than doubling the books.
 * Re-reading the same bytes gives the same fingerprints, because nothing about the file's
 * POSITION goes into one.
 *
 * AND: TWO IDENTICAL TRANSACTIONS ARE NOT A DUPLICATE. Two receipts of the same amount
 * from the same customer on the same day with no bank reference are two real events with
 * one fingerprint. So a caller MUST compare COUNTS, not membership — which is why
 * `repeatedTransactions` returns POSITIONS, exactly as `groupByFingerprint` does, and why nothing in
 * this module ever de-duplicates a batch on its own.
 *
 * WHICH IDENTIFIER GOES IN, AND WHY THE TWO ANSWERS DIFFER. A document's fingerprint
 * carries its NUMBER: an invoice number is the document's identity everywhere it appears
 * — on the print, in the customer's books, in a return — so a human re-entering it by
 * hand types the same string. A voucher's fingerprint carries the BANK REFERENCE (a
 * cheque number, a UTR) and NOT the source system's own voucher number, because that
 * serial is allotted by whichever program recorded the money and two programs will never
 * agree on it. It is the same argument fingerprint.ts makes for leaving a statement's
 * "Sl No" out.
 */

import { D, parseDecimalString, toMoneyString } from '@main/domain/money'
import { ACCOUNT_ROLES, type AccountRole, type AccountType } from '@main/domain/ledger'

import type { DocumentKind } from '@shared/documents'
import type { ItemKind } from '@shared/dto'
import type { ReceiptKind } from '@shared/receipts'
import type { DateString, DecimalString } from '@shared/scalars'

import {
  normaliseHeading,
  rowFingerprint,
  type DateFormat,
  type ImportIssue as CsvImportIssue,
  type ImportIssueCode as CsvImportIssueCode,
  type ImportIssueSeverity,
} from './csv'

// ---- Refusals -------------------------------------------------------------

export type ImportErrorCode =
  /** A caller's mapping does not describe anything an importer can run. */
  | 'IMPORT_SPEC_INVALID'
  /** A ledger override names a target that could not be a target — an unknown role. */
  | 'IMPORT_TARGET_INVALID'
  /** A file was handed to an importer under a name it does not have an entity for. */
  | 'IMPORT_ENTITY_UNKNOWN'

/**
 * A refusal from an importer.
 *
 * The same split csv/errors.ts makes, for the same reason: this is the caller asking for
 * something impossible, not the user's file being messy. Everything about the DATA is a
 * `BatchIssue`, is collected, and is never thrown.
 */
export class ImportError extends Error {
  readonly code: ImportErrorCode

  constructor(code: ImportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ImportError'
    this.code = code
  }
}

/** True when `value` is an `ImportError`. */
export function isImportError(value: unknown): value is ImportError {
  return value instanceof ImportError
}

// ---- Issues ---------------------------------------------------------------

/**
 * What an importer can report beyond what reading a CSV can.
 *
 * Unioned with the CSV module's codes rather than duplicating them — a `MISSING_COLUMN`
 * found by `mapCsvRows` is the same fact whichever importer hit it, and re-spelling it
 * here would be a second enumeration to keep in step.
 */
export type ImporterIssueCode =
  /** The date column is consistent with two formats that DISAGREE. Nothing is guessed. */
  | 'DATE_FORMAT_AMBIGUOUS'
  /** No known date format reads this column. */
  | 'DATE_FORMAT_UNREADABLE'
  /** A line row carried no document number, so there is nothing to group it onto. */
  | 'ROW_NOT_GROUPED'
  /** Two rows of one document disagree about a document-level field. */
  | 'CONFLICTING_HEADER'
  /** A foreign ledger name reached no account and no role. */
  | 'UNMAPPED_LEDGER'
  /** A foreign ledger name reached two targets. Picking one would be a lie. */
  | 'AMBIGUOUS_LEDGER'
  /** The source's account type is not one this build knows how to classify. */
  | 'UNKNOWN_ACCOUNT_TYPE'
  /** The source's item type is not `goods` or `service`. */
  | 'UNKNOWN_ITEM_KIND'
  /** The source does not say whether a contact is a customer or a vendor. */
  | 'UNKNOWN_PARTY_ROLE'
  /** Two source rows claim the same source identifier. One of them will be lost. */
  | 'DUPLICATE_SOURCE_ID'
  /** Two staged transactions have one fingerprint. Not necessarily wrong — see the header. */
  | 'REPEATED_TRANSACTION'
  /** A document or voucher names a party no contact file lists. */
  | 'PARTY_NOT_FOUND'
  /** A voucher settles a document number that is not in this export. */
  | 'ALLOCATION_TARGET_MISSING'
  /** A value that should be a whole number of days, or a count, was not. */
  | 'INVALID_NUMBER'

export type BatchIssueCode = CsvImportIssueCode | ImporterIssueCode

export type BatchIssueSeverity = ImportIssueSeverity

/**
 * One thing that went wrong, located precisely enough for a user to go and look at it.
 *
 * The CSV module's `ImportIssue` plus a FILE. That field is the whole difference and it
 * is not optional cosmetics: a Zoho export is six or eight separate CSVs, and "row 14,
 * column 3" identifies nothing at all unless it says which file. `liftCsvIssue` is how a
 * CSV issue acquires one.
 */
export interface BatchIssue {
  readonly code: BatchIssueCode
  readonly severity: BatchIssueSeverity
  /** Written for the person holding the export: what is wrong and what to do. */
  readonly message: string
  /** The file the issue is in, as the export names it. */
  readonly file?: string
  /** 1-based line in that file, as a text editor counts them. */
  readonly line?: number
  /** 1-based position among data rows, header excluded. */
  readonly rowNumber?: number
  /** 1-based column position in the row. */
  readonly columnNumber?: number
  /** The heading as it is written in the file. */
  readonly heading?: string
  /** The target field the issue is about, where there is one. */
  readonly field?: string
  /** The offending value, so the message reads without opening the file. */
  readonly value?: string
  /** The source identifier of the staged row this is about, where there is one. */
  readonly sourceId?: string
}

/** Attach a file name to an issue the CSV module produced. */
export function liftCsvIssue(file: string, issue: CsvImportIssue): BatchIssue {
  return { ...issue, file }
}

// ---- Provenance -----------------------------------------------------------

/**
 * One row of one file.
 *
 * Both `line` and `rowNumber` are carried for the reason csv/errors.ts gives: they
 * disagree exactly in the files that are hardest to debug (a quoted narration containing
 * a newline), and a message with only one of them sends the user to the wrong place in
 * precisely those files.
 */
export interface SourceRow {
  readonly file: string
  /** 1-based line in the file, as a text editor counts them. */
  readonly line: number
  /** 1-based position among data rows, header excluded. */
  readonly rowNumber: number
}

/**
 * Every row that contributed to one staged thing.
 *
 * A list rather than a single row, because the interesting case is the one a naive
 * importer gets wrong: a three-line invoice is ONE document assembled from THREE rows,
 * and "explain this document" has to be able to name all three.
 */
export type Provenance = readonly SourceRow[]

// ---- What was read --------------------------------------------------------

/**
 * One file of an export, and what happened to it.
 *
 * `headings` is here because of a problem no amount of care removes: the exact column
 * names a foreign product writes vary by account settings, by region and by version, and
 * a mapping is a best-effort default. Recording the headings AS WRITTEN means a wrong
 * assumption is diagnosable from the batch alone — the user (or the next batch) can see
 * that the file said `Invoice Number` where the mapping looked for `Invoice #`, without
 * anybody re-opening the file.
 */
export interface ImportedFile {
  /** As the export names it, e.g. 'Invoice.csv'. */
  readonly name: string
  /** Which entity of the source system this file was read as. */
  readonly entity: string
  /** The heading row exactly as the file spells it. */
  readonly headings: readonly string[]
  /** Data rows in the file, blank lines excluded. */
  readonly rowsRead: number
  /** Rows that produced something. Never more than `rowsRead`, often fewer. */
  readonly rowsStaged: number
  /** The date format used, whether the caller named it or the survey settled it. */
  readonly dateFormat: DateFormat | null
}

export interface ImportSource {
  /** Machine-readable, e.g. 'zoho'. */
  readonly system: string
  /** What the user sees, e.g. 'Zoho Books'. */
  readonly label: string
  readonly files: readonly ImportedFile[]
}

// ---- Where a foreign ledger points ----------------------------------------

/**
 * The minimum this module needs to know about the chart it is mapping ONTO.
 *
 * Taken as an argument, never fetched. That is what keeps the module pure, and it is also
 * CONVENTIONS §6's rule about guards: a refusal the real chart cannot trigger is a line no
 * test can reach, so a test hands `buildLedgerMapping` a chart with two accounts of one
 * name and watches it report ambiguity instead of choosing.
 */
export interface ChartAccountRef {
  readonly code: string
  readonly name: string
  /** The semantic slot it fills, where it fills one. */
  readonly role?: AccountRole | null
}

/**
 * What a user chose for one foreign ledger. Wins over everything the software worked out.
 *
 * `ignore` is not the same as leaving it unmapped. It says "this ledger is not something
 * Coffer needs an account for" — Zoho's `Unbilled Receivables`, say — and a line that
 * names an ignored ledger simply carries no account of its own, so the document kind
 * decides where it posts, exactly as a hand-entered line with no override does.
 */
export type LedgerOverride =
  | { readonly kind: 'role'; readonly role: AccountRole }
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'ignore' }

/**
 * Where one foreign ledger name ended up.
 *
 * `because` is on every member, including the failures. It is what makes the mapping
 * screen able to answer "why did Sundry Debtors go there?" without the user reading this
 * file — and it is what makes an unmapped ledger an explanation rather than a shrug.
 */
export type LedgerResolution =
  /** A semantic slot. The posting engine looks accounts up by role, so this is the sharp one. */
  | { readonly kind: 'role'; readonly role: AccountRole; readonly because: string }
  /** A specific account code in the company's existing chart. */
  | { readonly kind: 'code'; readonly code: string; readonly because: string }
  /** An account this import proposes to CREATE. Named by its source id, never by an id. */
  | { readonly kind: 'new'; readonly accountSourceId: string; readonly because: string }
  /** The user said this ledger needs no account. */
  | { readonly kind: 'ignored'; readonly because: string }
  /** Two or more targets matched. Reported, never resolved by list order. */
  | {
      readonly kind: 'ambiguous'
      readonly candidates: readonly string[]
      readonly because: string
    }
  /** Nothing matched. A first-class state, and an error until somebody decides. */
  | { readonly kind: 'unmapped'; readonly because: string }

export interface LedgerMappingEntry {
  /** The ledger name exactly as the file spells it — this is what a message shows. */
  readonly ledger: string
  /** `normaliseHeading(ledger)`: NFC, no invisibles, single spaces, trimmed, lower case. */
  readonly key: string
  readonly resolution: LedgerResolution
  /** How many staged rows name this ledger, so a screen can put the costly ones first. */
  readonly usageCount: number
}

/**
 * A foreign ledger name and the roles it is a synonym for.
 *
 * `roles` is a LIST rather than a role, so that an alias meaning two things is
 * representable and therefore reportable. The shipped table has one role per alias — a
 * test asserts that — but the resolver must be able to say "ambiguous" about a table it
 * is handed, and a shape that cannot express the ambiguity makes that untestable.
 */
export interface LedgerSynonym {
  readonly role: AccountRole
  /** Names that mean this role. Matched by `normaliseHeading`, so case and spacing are free. */
  readonly aliases: readonly string[]
}

/**
 * The Indian-accounting names for the slots Coffer's chart already has.
 *
 * These are the words Tally, Vyapar and Zoho's Indian templates actually use. Every entry
 * is a name somebody's ledger is called, not a guess at what one might be called: the
 * cost of a wrong entry is an amount posted to the wrong account with nothing to say so,
 * which is strictly worse than an unmapped ledger the user gets asked about.
 *
 * DELIBERATELY ABSENT, and each for a reason:
 *   `Opening Stock`      is an EXPENSE in a trading account, not the stock asset.
 *   `Bank OD A/c`        is a liability; the `bank` role is an asset.
 *   `Duties and Taxes`   is a GROUP, and which component it means is the regime's answer
 *                        (CONVENTIONS §1.6). Nothing here may name a tax.
 *   `Reserves & Surplus` is a group that contains retained earnings among other things.
 */
export const LEDGER_SYNONYMS: readonly LedgerSynonym[] = [
  {
    role: 'accounts-receivable',
    aliases: [
      'sundry debtors',
      'sundry debtor',
      'debtors',
      'trade debtors',
      'trade receivables',
      'accounts receivable',
      'receivables',
      'book debts',
    ],
  },
  {
    role: 'accounts-payable',
    aliases: [
      'sundry creditors',
      'sundry creditor',
      'creditors',
      'trade creditors',
      'trade payables',
      'accounts payable',
      'payables',
    ],
  },
  {
    role: 'sales',
    aliases: [
      'sales',
      'sales accounts',
      'sales account',
      'sales a/c',
      'revenue',
      'revenue from operations',
    ],
  },
  {
    role: 'sales-returns',
    aliases: ['sales returns', 'sales return', 'returns inward', 'returns inwards'],
  },
  {
    role: 'purchases',
    aliases: ['purchases', 'purchase accounts', 'purchase account', 'purchase a/c'],
  },
  {
    role: 'purchase-returns',
    aliases: ['purchase returns', 'purchase return', 'returns outward', 'returns outwards'],
  },
  { role: 'cash', aliases: ['cash', 'cash in hand', 'cash-in-hand', 'cash a/c', 'petty cash'] },
  { role: 'bank', aliases: ['bank', 'bank accounts', 'bank account', 'bank a/c'] },
  {
    role: 'stock',
    aliases: ['stock in hand', 'stock-in-hand', 'closing stock', 'inventory', 'inventory asset'],
  },
  { role: 'cost-of-goods-sold', aliases: ['cost of goods sold', 'cost of sales', 'cogs'] },
  { role: 'stock-adjustment', aliases: ['stock adjustment', 'inventory adjustment'] },
  {
    role: 'discount-allowed',
    aliases: ['discount allowed', 'discounts allowed', 'discount given'],
  },
  {
    role: 'discount-received',
    aliases: ['discount received', 'discounts received', 'discount earned'],
  },
  {
    role: 'freight-inward',
    aliases: ['freight inward', 'freight inwards', 'carriage inward', 'carriage inwards'],
  },
  {
    role: 'freight-outward',
    aliases: ['freight outward', 'freight outwards', 'carriage outward', 'carriage outwards'],
  },
  { role: 'round-off', aliases: ['round off', 'round-off', 'rounding off', 'rounded off'] },
  {
    role: 'opening-balance-equity',
    aliases: ['opening balance equity', 'opening balance adjustments'],
  },
  {
    role: 'retained-earnings',
    aliases: [
      'retained earnings',
      'profit and loss account',
      'profit & loss a/c',
      'profit and loss a/c',
    ],
  },
  { role: 'suspense', aliases: ['suspense', 'suspense a/c', 'suspense account'] },
]

export interface LedgerMappingOptions {
  /** The chart of the company being imported into. Absent means "match on roles only". */
  readonly chart?: readonly ChartAccountRef[]
  /** Accounts this import proposes to create, so a ledger can point at one. */
  readonly newAccounts?: readonly StagedAccount[]
  /** The user's decisions, keyed by ledger name. Matched after `normaliseHeading`. */
  readonly overrides?: Readonly<Record<string, LedgerOverride>>
  /** Defaults to `LEDGER_SYNONYMS`. A test hands this one an ambiguous table. */
  readonly synonyms?: readonly LedgerSynonym[]
}

/**
 * Resolve every foreign ledger name an import mentions.
 *
 * `mentions` is every mention IN ENCOUNTER ORDER, duplicates included — the count is what
 * tells a user which unplaced ledger is worth their attention, and it cannot be recovered
 * from a set.
 *
 * THE ORDER OF RESOLUTION, AND WHY IT IS THIS ORDER:
 *
 *   1. an override            — somebody decided. Nothing may overrule a decision.
 *   2. a synonym, to a ROLE   — a role is a slot the posting engine reads. It survives the
 *                               account being renamed, which a name match does not.
 *   3. the chart, BY NAME     — everything else the company already has: 'Rent',
 *                               'Professional Fees'. Two accounts of one name is ambiguous.
 *   4. a proposed new account — an account this same import is creating from the foreign
 *                               chart. AFTER the existing chart, so an import cannot
 *                               create a second account with a name the chart already has.
 *   5. unmapped               — reported, and blocking. Never invented.
 *
 * @throws ImportError when an override names a role that is not an `AccountRole`.
 */
export function buildLedgerMapping(
  mentions: readonly string[],
  options: LedgerMappingOptions = {},
): readonly LedgerMappingEntry[] {
  const synonyms = options.synonyms ?? LEDGER_SYNONYMS
  const overrides = normaliseOverrides(options.overrides ?? {})

  /* First-encounter order, with the counts accumulated. A Map preserves insertion order,
   * so a screen lists ledgers the way the file introduced them rather than alphabetically
   * — which is the order the user's own eye is in. */
  const seen = new Map<string, { ledger: string; count: number }>()
  for (const mention of mentions) {
    const key = normaliseHeading(mention)
    if (key === '') {
      continue
    }
    const already = seen.get(key)
    if (already === undefined) {
      seen.set(key, { ledger: mention.trim(), count: 1 })
    } else {
      already.count += 1
    }
  }

  return [...seen.entries()].map(([key, { ledger, count }]) => ({
    ledger,
    key,
    usageCount: count,
    resolution: resolveLedger(key, ledger, {
      overrides,
      synonyms,
      chart: options.chart ?? [],
      newAccounts: options.newAccounts ?? [],
    }),
  }))
}

/** The entry for one ledger name, or null when the import never mentioned it. */
export function ledgerEntryFor(
  mapping: readonly LedgerMappingEntry[],
  ledger: string,
): LedgerMappingEntry | null {
  const key = normaliseHeading(ledger)
  /* `filter` and a count, not `find`: two entries with one key would mean the mapping was
   * built wrong, and `find` would hide that behind whichever came first. */
  const matches = mapping.filter((entry) => entry.key === key)
  const [only, ...rest] = matches
  if (only === undefined || rest.length > 0) {
    return null
  }
  return only
}

// ---- Staged entities ------------------------------------------------------

/*
 * Each of these is what one Coffer DTO looks like before any id exists. The field names
 * match the DTO they become wherever the meaning is identical, so the write step is
 * mechanical; they differ exactly where the DTO holds an id or a computed figure.
 */

/**
 * A unit of measure the source used.
 *
 * `code` is upper case because `UnitOfMeasure.code` is the identity and is upper case;
 * `label` keeps what the file actually said, which is what a user recognises.
 * `decimalPlaces` is absent rather than defaulted — the source rarely states it, and
 * choosing 0 would make half a metre unrepresentable while choosing 3 would let somebody
 * invoice a third of a box.
 */
export interface StagedUnit {
  readonly code: string
  readonly label: string
  readonly decimalPlaces?: number
  readonly provenance: Provenance
}

/**
 * An account the source's own chart has, proposed for creation.
 *
 * `sourceType` keeps the source's word for it ('Other Current Asset') beside the
 * `AccountType` this build read out of it, so a wrong classification is visible without
 * re-reading the file. `parentName` is a NAME because the source's parent link is a name;
 * resolving it to a parent id is the write step's job.
 */
export interface StagedAccount {
  readonly sourceId: string
  readonly code?: string
  readonly name: string
  readonly type: AccountType
  readonly sourceType: string
  readonly parentName?: string
  readonly description?: string
  readonly isArchived?: boolean
  readonly provenance: Provenance
}

/**
 * A customer or a vendor.
 *
 * `jurisdictionName` rather than `jurisdictionCode`: a foreign export writes a state's
 * NAME ('Karnataka'), and the map from that to the code that decides the place of supply
 * belongs to the tax regime (CONVENTIONS §1.6). This module may not name it, so it carries
 * the words the file used and the write step asks the regime once.
 */
export interface StagedParty {
  readonly sourceId: string
  readonly name: string
  readonly legalName?: string
  readonly isCustomer: boolean
  readonly isVendor: boolean
  readonly registrationNumber?: string
  readonly jurisdictionName?: string
  readonly countryName?: string
  readonly addressLine1?: string
  readonly addressLine2?: string
  readonly city?: string
  readonly postalCode?: string
  readonly email?: string
  readonly phone?: string
  readonly paymentTermsDays?: number
  readonly creditLimit?: DecimalString
  readonly notes?: string
  readonly isArchived?: boolean
  readonly provenance: Provenance
}

/** Something that goes on a document line. `unitLabel` is the source's word for the unit. */
export interface StagedItem {
  readonly sourceId: string
  readonly code?: string
  readonly name: string
  readonly kind: ItemKind
  readonly description?: string
  readonly unitLabel?: string
  readonly classificationCode?: string
  readonly taxRatePct?: DecimalString
  readonly salePrice?: DecimalString
  readonly purchasePrice?: DecimalString
  readonly isSold: boolean
  readonly isPurchased: boolean
  readonly isArchived?: boolean
  /** The foreign ledger this item's sales post to. Resolved through `ImportBatch.ledgers`. */
  readonly salesLedger?: string
  readonly purchaseLedger?: string
  readonly provenance: Provenance
}

/**
 * One line of a document, before tax.
 *
 * NO `taxableAmount` AND NO `taxes`. Which components apply, at which rates, on which
 * side of a supply is the REGIME's answer as of the document's date, and an importer may
 * not ask it — the documents service does, once, at write time (see the note above
 * `CreateTaxedDocumentInput` in dto.ts). `ratePct` IS here and is a different kind of
 * thing: it is the slab the source recorded, an input to the tax rather than the tax.
 *
 * `statedLineTotal` is what the source printed on this line, kept and NOT checked. It
 * cannot be checked here: whether a foreign export's line total includes tax depends on
 * that account's settings, and a comparison that assumes one answer would report every
 * line of half the exports in the world as wrong. It is carried so the write step, which
 * knows what Coffer computed, can reconcile the two and say so.
 */
export interface StagedDocumentLine {
  /** 1-based within the document, in the order the rows appeared in the file. */
  readonly lineNumber: number
  readonly itemSourceId?: string
  readonly itemName?: string
  readonly description: string
  readonly quantity: DecimalString
  readonly unitLabel?: string
  readonly unitPrice: DecimalString
  readonly discount: DecimalString
  readonly ratePct?: DecimalString
  readonly classificationCode?: string
  /** The foreign ledger this line posts to. Resolved through `ImportBatch.ledgers`. */
  readonly ledger?: string
  readonly statedLineTotal?: DecimalString
  readonly provenance: Provenance
}

/**
 * A trade document.
 *
 * `partyName` is required and `partySourceId` is not, because a foreign export does not
 * always carry its own contact key on a transaction row and the name is then the only
 * join there is. Both are kept when both are present: the id is the sharp match and the
 * name is what a user reads in the report about it.
 */
export interface StagedDocument {
  readonly sourceId: string
  readonly kind: DocumentKind
  /** The number the source gave it. Kept as written — it is the document's identity. */
  readonly number: string
  readonly date: DateString
  readonly dueDate?: DateString
  readonly partySourceId?: string
  readonly partyName: string
  readonly partyReference?: string
  readonly placeOfSupplyName?: string
  readonly narration?: string
  /** The source's own grand total, kept for reconciliation. Never trusted, never posted. */
  readonly statedTotal?: DecimalString
  /** What the source says is still outstanding on it. */
  readonly statedBalance?: DecimalString
  /** The source's own word for its state: 'Draft', 'Sent', 'Void'. Kept verbatim. */
  readonly sourceStatus?: string
  readonly lines: readonly StagedDocumentLine[]
  readonly provenance: Provenance
  /** See the header. Stable across re-runs; NOT unique across genuinely identical events. */
  readonly fingerprint: string
}

/** How much of one voucher settles one document, named the way the source names it. */
export interface StagedAllocation {
  /** The foreign document NUMBER. There is no id to point at yet. */
  readonly documentNumber: string
  readonly amount: DecimalString
  readonly provenance: Provenance
}

/**
 * Money in or out, and what it settles.
 *
 * `ledger` is the bank or cash ledger the money moved through, as the source names it,
 * and it is resolved through `ImportBatch.ledgers` like every other ledger reference —
 * there is no separate mechanism for "the money account", because there is no reason for
 * one and a second mechanism is a second place to be wrong.
 */
export interface StagedReceipt {
  readonly sourceId: string
  readonly kind: ReceiptKind
  /** The source's own voucher number. Deliberately NOT in the fingerprint — see the header. */
  readonly number: string
  readonly date: DateString
  readonly partySourceId?: string
  readonly partyName: string
  readonly amount: DecimalString
  readonly ledger?: string
  /** A cheque number, a UTR. This is what makes the fingerprint sharp. */
  readonly reference?: string
  readonly narration?: string
  readonly allocations: readonly StagedAllocation[]
  readonly provenance: Provenance
  readonly fingerprint: string
}

/**
 * Which ledger an opening balance is against.
 *
 * A union rather than two nullable fields, because it is exactly the biconditional
 * CONVENTIONS §3 asks for: an opening figure names a foreign LEDGER (a trial balance
 * import) or it is against a SLOT the importer knows from the shape of the data (a
 * contact's opening balance is receivable or payable by definition, and the file names no
 * ledger at all). Two nullable fields would leave "both set" and "neither set"
 * representable, and the direction nobody thought to check is the dangerous one.
 */
export type LedgerReference =
  | { readonly kind: 'name'; readonly ledger: string }
  | { readonly kind: 'role'; readonly role: AccountRole }

/**
 * One account's balance as the books opened. Maps onto `OpeningBalanceLine` and nothing else.
 *
 * `amount` is POSITIVE IN THE ACCOUNT'S NORMAL DIRECTION, exactly as `OpeningBalanceLine`
 * defines it — a bank account with 50,000 in it and a loan of 50,000 owed are both
 * '50000.00'. Asking for a side here would make somebody translate their old trial
 * balance twice, and the second translation is the one that gets a sign backwards.
 */
export interface StagedOpeningBalance {
  readonly sourceId: string
  readonly ledger: LedgerReference
  /** Whose money, on a control account. The reason an opening receivable can be aged. */
  readonly partySourceId?: string
  readonly partyName?: string
  readonly amount: DecimalString
  readonly provenance: Provenance
}

// ---- The batch ------------------------------------------------------------

/**
 * Everything one import produced.
 *
 * WHAT IS NOT ON IT, ON PURPOSE: no counts, no readiness flag, no list of unplaced
 * ledgers. Every one of those is derivable from what is here and would be a stored copy
 * that could only ever disagree (CONVENTIONS §1.3) — and `remapLedgers` exists precisely
 * to change the inputs those answers depend on. `summariseBatch`, `readinessOf` and
 * `ledgerIssues` compute them.
 *
 * `issues` holds only what reading the FILES found. Those facts cannot change without
 * re-reading, so they are stored. Everything about PLACEMENT is derived from `ledgers`.
 */
export interface ImportBatch {
  readonly source: ImportSource
  readonly units: readonly StagedUnit[]
  readonly accounts: readonly StagedAccount[]
  readonly parties: readonly StagedParty[]
  readonly items: readonly StagedItem[]
  readonly openingBalances: readonly StagedOpeningBalance[]
  /** The date the opening figures are as at. Null when the import staged none. */
  readonly openingBalanceDate: DateString | null
  readonly documents: readonly StagedDocument[]
  readonly receipts: readonly StagedReceipt[]
  /** Foreign ledger name -> where it points. Replaceable; see `remapLedgers`. */
  readonly ledgers: readonly LedgerMappingEntry[]
  /** What reading the files found. Placement issues are derived, not stored here. */
  readonly issues: readonly BatchIssue[]
}

/** Every collection an importer may fill. All optional so a caller cannot forget one. */
export interface ImportBatchInput {
  readonly source: ImportSource
  readonly units?: readonly StagedUnit[]
  readonly accounts?: readonly StagedAccount[]
  readonly parties?: readonly StagedParty[]
  readonly items?: readonly StagedItem[]
  readonly openingBalances?: readonly StagedOpeningBalance[]
  readonly openingBalanceDate?: DateString | null
  readonly documents?: readonly StagedDocument[]
  readonly receipts?: readonly StagedReceipt[]
  readonly ledgers?: readonly LedgerMappingEntry[]
  readonly issues?: readonly BatchIssue[]
}

/** Build a batch, filling every collection an importer did not produce. */
export function createImportBatch(input: ImportBatchInput): ImportBatch {
  return {
    source: input.source,
    units: input.units ?? [],
    accounts: input.accounts ?? [],
    parties: input.parties ?? [],
    items: input.items ?? [],
    openingBalances: input.openingBalances ?? [],
    openingBalanceDate: input.openingBalanceDate ?? null,
    documents: input.documents ?? [],
    receipts: input.receipts ?? [],
    ledgers: input.ledgers ?? [],
    issues: input.issues ?? [],
  }
}

/**
 * Every foreign ledger name the batch mentions, in encounter order, duplicates included.
 *
 * The order is documents, then vouchers, then items, then opening balances — the order a
 * user thinks about them in, and stable, so a remap does not reshuffle the screen.
 */
export function ledgerMentions(batch: ImportBatch): readonly string[] {
  const mentions: string[] = []
  for (const document of batch.documents) {
    for (const line of document.lines) {
      if (line.ledger !== undefined) {
        mentions.push(line.ledger)
      }
    }
  }
  for (const receipt of batch.receipts) {
    if (receipt.ledger !== undefined) {
      mentions.push(receipt.ledger)
    }
  }
  for (const item of batch.items) {
    if (item.salesLedger !== undefined) {
      mentions.push(item.salesLedger)
    }
    if (item.purchaseLedger !== undefined) {
      mentions.push(item.purchaseLedger)
    }
  }
  for (const opening of batch.openingBalances) {
    if (opening.ledger.kind === 'name') {
      mentions.push(opening.ledger.ledger)
    }
  }
  return mentions
}

/**
 * The same batch with its ledgers resolved again, under different options.
 *
 * THIS IS WHAT MAKES AN IMPORT A REVISABLE PROPOSAL. A user fixes the three ledgers
 * nothing could place, and one table is rebuilt from the names the rows already carry —
 * no re-parse, no rewrite of eight hundred rows, and no possibility of a row disagreeing
 * with the mapping because a row never held a placement in the first place.
 *
 * The caller supplies the whole options object again rather than a patch, for the reason
 * `AllocateReceiptInput` does: a screen holds the entire mapping in front of the user, and
 * sending back half of it would leave the entries they had cleared.
 */
export function remapLedgers(batch: ImportBatch, options: LedgerMappingOptions): ImportBatch {
  return { ...batch, ledgers: buildLedgerMapping(ledgerMentions(batch), options) }
}

/**
 * The placement problems, derived from the mapping as it stands right now.
 *
 * Derived rather than stored because the mapping is the one part of a batch a user
 * changes, and a stored copy of "these three are unplaced" is a stored answer whose inputs
 * move underneath it (CONVENTIONS §1.3).
 */
export function ledgerIssues(batch: ImportBatch): readonly BatchIssue[] {
  const issues: BatchIssue[] = []
  for (const entry of batch.ledgers) {
    if (entry.resolution.kind === 'unmapped') {
      issues.push({
        code: 'UNMAPPED_LEDGER',
        severity: 'error',
        message:
          `Coffer could not decide where ${JSON.stringify(entry.ledger)} belongs in your chart ` +
          `of accounts, and ${String(entry.usageCount)} imported ${rows(entry.usageCount)} use it. ` +
          'Choose an account for it, or mark it as one Coffer does not need.',
        field: entry.ledger,
        value: entry.ledger,
      })
      continue
    }
    if (entry.resolution.kind === 'ambiguous') {
      issues.push({
        code: 'AMBIGUOUS_LEDGER',
        severity: 'error',
        message:
          `${JSON.stringify(entry.ledger)} could be ${entry.resolution.candidates.join(' or ')}. ` +
          'Coffer will not choose for you — pick the one you mean.',
        field: entry.ledger,
        value: entry.ledger,
      })
    }
  }
  return issues
}

/** Everything wrong with the batch as it stands: what reading found, plus placement. */
export function allIssues(batch: ImportBatch): readonly BatchIssue[] {
  return [...batch.issues, ...ledgerIssues(batch)]
}

export interface ImportReadiness {
  /** True when nothing of `error` severity stands in the way. */
  readonly isReadyToWrite: boolean
  readonly errorCount: number
  readonly warningCount: number
  /** Ledger names nothing could place, as written. */
  readonly unmappedLedgers: readonly string[]
  /** Ledger names that reached two targets, as written. */
  readonly ambiguousLedgers: readonly string[]
}

/**
 * Whether this proposal can be written, and what is stopping it.
 *
 * An unplaced ledger BLOCKS. It would be easy to post those lines to Suspense and let the
 * user sort it out later, and that is precisely the silent guess this module refuses: a
 * balance in Suspense is discovered a month later by somebody reading a balance sheet,
 * and by then nobody remembers which import put it there. A user who WANTS that can say
 * so — `{ kind: 'role', role: 'suspense' }` is one override — and then it is a decision
 * with a name on it.
 */
export function readinessOf(batch: ImportBatch): ImportReadiness {
  const issues = allIssues(batch)
  const unmapped: string[] = []
  const ambiguous: string[] = []
  for (const entry of batch.ledgers) {
    if (entry.resolution.kind === 'unmapped') {
      unmapped.push(entry.ledger)
    }
    if (entry.resolution.kind === 'ambiguous') {
      ambiguous.push(entry.ledger)
    }
  }
  const errorCount = issues.filter((issue) => issue.severity === 'error').length
  return {
    isReadyToWrite: errorCount === 0,
    errorCount,
    warningCount: issues.length - errorCount,
    unmappedLedgers: unmapped,
    ambiguousLedgers: ambiguous,
  }
}

export interface ImportSummary {
  readonly units: number
  readonly accounts: number
  readonly parties: number
  readonly items: number
  readonly openingBalances: number
  readonly documents: number
  readonly documentLines: number
  readonly receipts: number
  readonly allocations: number
  readonly ledgers: number
  readonly ledgersUnmapped: number
  readonly ledgersAmbiguous: number
  readonly errorCount: number
  readonly warningCount: number
}

/** What the batch contains, counted. Derived on demand; nothing stores it. */
export function summariseBatch(batch: ImportBatch): ImportSummary {
  const readiness = readinessOf(batch)
  return {
    units: batch.units.length,
    accounts: batch.accounts.length,
    parties: batch.parties.length,
    items: batch.items.length,
    openingBalances: batch.openingBalances.length,
    documents: batch.documents.length,
    documentLines: batch.documents.reduce((total, document) => total + document.lines.length, 0),
    receipts: batch.receipts.length,
    allocations: batch.receipts.reduce((total, receipt) => total + receipt.allocations.length, 0),
    ledgers: batch.ledgers.length,
    ledgersUnmapped: readiness.unmappedLedgers.length,
    ledgersAmbiguous: readiness.ambiguousLedgers.length,
    errorCount: readiness.errorCount,
    warningCount: readiness.warningCount,
  }
}

/**
 * Accounts this import would actually create.
 *
 * A staged account whose name is already in the chart is dropped: creating it would give
 * the company two accounts with one name, and every ledger reference to that name would
 * then be ambiguous for ever after. The existing one wins, which is the same precedence
 * `buildLedgerMapping` uses, written once so the two cannot disagree.
 */
export function accountsToCreate(
  batch: ImportBatch,
  chart: readonly ChartAccountRef[],
): readonly StagedAccount[] {
  const taken = new Set(chart.map((account) => normaliseHeading(account.name)))
  return batch.accounts.filter((account) => !taken.has(normaliseHeading(account.name)))
}

// ---- Fingerprints ---------------------------------------------------------

/** The sum of `quantity x unitPrice - discount` over a staged document's lines. */
export function stagedSubtotal(document: {
  readonly lines: readonly StagedDocumentLine[]
}): DecimalString {
  let total = D(0)
  for (const line of document.lines) {
    const quantity = parseDecimalString(line.quantity, 'staged quantity')
    const unitPrice = parseDecimalString(line.unitPrice, 'staged unit price')
    const discount = parseDecimalString(line.discount, 'staged discount')
    total = total.plus(quantity.times(unitPrice).minus(discount))
  }
  return toMoneyString(total)
}

/**
 * Two pieces of text joined so that no rearrangement of them can produce one string.
 *
 * `rowFingerprint` has four slots and this module needs five things in them, so the KIND
 * and the PARTY share the narration slot. They are joined the way `rowFingerprint` joins
 * its own parts and for the same reason: any separator character can also occur inside a
 * party name, so a delimiter makes the encoding non-injective and two different rows can
 * hash the same.
 *
 * WRITTEN AS ITS OWN FUNCTION SO THAT A TEST CAN HAND IT THE COLLISION. Inlined at the two
 * call sites it was a rule nothing could break: the five document kinds are a closed set
 * and none of them is a prefix of another, so plain concatenation happens to be injective
 * over the kinds that exist today — which makes the length prefix a guard the real data
 * cannot exercise, and CONVENTIONS §6 is explicit that such a guard is one no mutation can
 * kill. As a function it takes its inputs from the test instead.
 */
export function taggedText(tag: string, value: string): string {
  return `${String(tag.length)}:${tag}${value}`
}

/**
 * A stable fingerprint for one staged document.
 *
 * The NUMBER is the reference, because an invoice number is the document's identity
 * everywhere — on the print, in the customer's books, in a return — so a human re-entering
 * it by hand types the same string. The amount is what the source stated, falling back to
 * the lines when it stated nothing.
 */
export function documentFingerprint(document: {
  readonly kind: DocumentKind
  readonly number: string
  readonly date: DateString
  readonly partySourceId?: string
  readonly partyName: string
  readonly statedTotal?: DecimalString
  readonly lines: readonly StagedDocumentLine[]
}): string {
  const party = document.partySourceId ?? document.partyName
  return rowFingerprint({
    date: document.date,
    amount: document.statedTotal ?? stagedSubtotal(document),
    narration: taggedText(document.kind, party),
    reference: document.number,
  })
}

/**
 * A stable fingerprint for one staged voucher.
 *
 * The BANK REFERENCE, never the source's own voucher number — see the module header. A
 * receipt with no reference therefore fingerprints on date, amount, kind and party alone,
 * and two identical receipts on one day collide. That is correct and is the whole reason
 * callers compare counts.
 */
export function receiptFingerprint(receipt: {
  readonly kind: ReceiptKind
  readonly date: DateString
  readonly partySourceId?: string
  readonly partyName: string
  readonly amount: DecimalString
  readonly reference?: string
}): string {
  const party = receipt.partySourceId ?? receipt.partyName
  return rowFingerprint({
    date: receipt.date,
    amount: receipt.amount,
    narration: taggedText(receipt.kind, party),
    reference: receipt.reference,
  })
}

/** One staged transaction, reduced to what a duplicate check needs. */
export interface StagedTransactionRef {
  readonly collection: 'documents' | 'receipts'
  /** Position within that collection. */
  readonly index: number
  readonly sourceId: string
  readonly fingerprint: string
}

/** Every staged transaction in the batch: documents first, then vouchers. */
export function stagedTransactions(batch: ImportBatch): readonly StagedTransactionRef[] {
  return [
    ...batch.documents.map((document, index) => ({
      collection: 'documents' as const,
      index,
      sourceId: document.sourceId,
      fingerprint: document.fingerprint,
    })),
    ...batch.receipts.map((receipt, index) => ({
      collection: 'receipts' as const,
      index,
      sourceId: receipt.sourceId,
      fingerprint: receipt.fingerprint,
    })),
  ]
}

/**
 * Staged transactions that share a fingerprint, by fingerprint, as POSITIONS.
 *
 * Positions and not a set, and not a count either: a caller comparing this import against
 * what is already in the books needs to act on the SECOND occurrence specifically. Two
 * identical transactions on one day are two real events with one fingerprint, so
 * "the ledger already has this one" is a statement about how MANY, never about whether.
 */
export function repeatedTransactions(batch: ImportBatch): Map<string, number[]> {
  /* The same contract `groupByFingerprint` has, over fingerprints that are already
   * computed: positions within `stagedTransactions(batch)`, in encounter order, and only
   * the groups with more than one member. It is written out rather than delegated because
   * delegating would mean re-hashing a hash, and the recipe would then exist twice. */
  const groups = new Map<string, number[]>()
  for (const [index, transaction] of stagedTransactions(batch).entries()) {
    const positions = groups.get(transaction.fingerprint)
    if (positions === undefined) {
      groups.set(transaction.fingerprint, [index])
    } else {
      positions.push(index)
    }
  }
  const repeats = new Map<string, number[]>()
  for (const [fingerprint, positions] of groups) {
    if (positions.length > 1) {
      repeats.set(fingerprint, positions)
    }
  }
  return repeats
}

// ---- Internals ------------------------------------------------------------

function rows(count: number): string {
  return count === 1 ? 'row' : 'rows'
}

interface ResolutionContext {
  readonly overrides: ReadonlyMap<string, LedgerOverride>
  readonly synonyms: readonly LedgerSynonym[]
  readonly chart: readonly ChartAccountRef[]
  readonly newAccounts: readonly StagedAccount[]
}

function normaliseOverrides(
  overrides: Readonly<Record<string, LedgerOverride>>,
): ReadonlyMap<string, LedgerOverride> {
  const map = new Map<string, LedgerOverride>()
  for (const [ledger, override] of Object.entries(overrides)) {
    if (override.kind === 'role' && !(ACCOUNT_ROLES as readonly string[]).includes(override.role)) {
      throw new ImportError(
        'IMPORT_TARGET_INVALID',
        `${JSON.stringify(override.role)} is not an account role, so ${JSON.stringify(ledger)} ` +
          'cannot be mapped to it.',
      )
    }
    map.set(normaliseHeading(ledger), override)
  }
  return map
}

/**
 * One ledger name, resolved.
 *
 * Every lookup below is a `filter` and a count. CONVENTIONS §1.9: `.find` cannot tell "one
 * answer" from "the first of two", so it silently implements table order while looking
 * like a rule — and the whole promise of this module is that it does not guess.
 */
function resolveLedger(key: string, ledger: string, context: ResolutionContext): LedgerResolution {
  const override = context.overrides.get(key)
  if (override !== undefined) {
    return resolveOverride(ledger, override, context)
  }

  const roles = [
    ...new Set(
      context.synonyms
        .filter((synonym) => synonym.aliases.some((alias) => normaliseHeading(alias) === key))
        .map((synonym) => synonym.role),
    ),
  ]
  const [onlyRole, ...otherRoles] = roles
  if (onlyRole !== undefined && otherRoles.length === 0) {
    return {
      kind: 'role',
      role: onlyRole,
      because: `a ledger called ${JSON.stringify(ledger)} is the ${onlyRole} account.`,
    }
  }
  if (otherRoles.length > 0) {
    return {
      kind: 'ambiguous',
      candidates: roles,
      because: 'more than one role claims this name.',
    }
  }

  const chartMatches = context.chart.filter((account) => normaliseHeading(account.name) === key)
  const [onlyAccount, ...otherAccounts] = chartMatches
  if (otherAccounts.length > 0) {
    return {
      kind: 'ambiguous',
      candidates: chartMatches.map((account) => `${account.code} ${account.name}`),
      because: 'your chart has more than one account with this name.',
    }
  }
  if (onlyAccount !== undefined) {
    return {
      kind: 'code',
      code: onlyAccount.code,
      because: `your chart already has an account called ${JSON.stringify(onlyAccount.name)}.`,
    }
  }

  const staged = context.newAccounts.filter((account) => normaliseHeading(account.name) === key)
  const [onlyStaged, ...otherStaged] = staged
  if (otherStaged.length > 0) {
    return {
      kind: 'ambiguous',
      candidates: staged.map((account) => account.sourceId),
      because: 'this export lists more than one account with this name.',
    }
  }
  if (onlyStaged !== undefined) {
    return {
      kind: 'new',
      accountSourceId: onlyStaged.sourceId,
      because: 'this export brings an account of this name with it.',
    }
  }

  return {
    kind: 'unmapped',
    because: 'nothing in your chart, and no name Coffer recognises, matches this ledger.',
  }
}

function resolveOverride(
  ledger: string,
  override: LedgerOverride,
  context: ResolutionContext,
): LedgerResolution {
  /* A switch, exhaustively checked — the same form mapping.ts uses, and it gives what
   * CONVENTIONS §1.9 asks a total record for: `assertNever` stops this compiling the moment
   * a fourth override kind is added, rather than handing it whatever the last branch said. */
  switch (override.kind) {
    case 'role':
      return { kind: 'role', role: override.role, because: 'you chose this account role.' }
    case 'code': {
      /* Verified against the chart when there is one. An override naming a code the chart
       * does not have is a decision that cannot be carried out, and posting it anyway
       * would be the invention this module exists to refuse. */
      const code = override.code
      const matches = context.chart.filter((account) => account.code === code)
      if (context.chart.length > 0 && matches.length === 0) {
        return {
          kind: 'unmapped',
          because:
            `you chose account ${code} for ${JSON.stringify(ledger)}, and there is no account ` +
            'with that code in this chart.',
        }
      }
      return { kind: 'code', code, because: 'you chose this account.' }
    }
    case 'ignore':
      return {
        kind: 'ignored',
        because: 'you said Coffer does not need an account for this ledger.',
      }
    default:
      return assertNever(override)
  }
}

function assertNever(value: never): never {
  throw new ImportError(
    'IMPORT_TARGET_INVALID',
    `Unhandled ledger override: ${JSON.stringify(value)}`,
  )
}
