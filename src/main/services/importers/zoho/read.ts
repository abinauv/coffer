/*
 * READING ONE FILE OF A ZOHO BOOKS EXPORT.
 *
 * The CSV foundation does the reading (`readCsvTable`, `mapCsvRows`, the date survey, the
 * amount parser); this file does the INTERPRETATION, and there are exactly four decisions
 * in it worth arguing with.
 *
 * ---------------------------------------------------------------------------
 * 1. A DOCUMENT IS A GROUP OF ROWS, AND THE GROUP IS NOT CONTIGUOUS.
 *
 * Zoho writes one CSV row PER LINE ITEM, repeating the invoice's own fields on each. A
 * three-line invoice is three rows. The naive importer makes three invoices; the slightly
 * less naive one accumulates rows until the number changes, which is right for every file
 * anyone tests with and wrong for the ones that arrive sorted by item, by account, or by
 * anything else — and then it makes two invoices with one number and the second silently
 * replaces the first.
 *
 * So grouping goes through a Map keyed on the document number and ASSUMES NOTHING ABOUT
 * ORDER. The golden fixture interleaves two documents' rows for exactly this reason: an
 * implementation that assumes contiguity fails it, and one that sorts first passes it for
 * the wrong reason — which is why the expected output is in FIRST-APPEARANCE order and
 * the fixture's first appearances disagree with both date order and number order.
 *
 * EVERY entity is grouped, not just documents — see `groupBy` in columns.ts. A contacts
 * export has one row per contact PERSON.
 *
 * ---------------------------------------------------------------------------
 * 2. DOCUMENT-LEVEL FIELDS ARE AGREED ACROSS THE GROUP, NEVER TAKEN FROM A ROW.
 *
 * `agreedValue` collects the DISTINCT non-blank values a field has across the group's
 * rows. One value is the answer. None is absence. TWO IS A CONFLICT, and it is reported
 * rather than resolved, because "take the first row's" is CONVENTIONS §9's `.find` in
 * disguise: it makes the file's sort order the rule while looking like a lookup.
 *
 * The severity depends on what the field is FOR, and that is the only place the two
 * differ: a conflict on the date or the party is an error and the document is dropped
 * (there is no honest way to build one document out of two dates); a conflict on anything
 * else is a warning and the field is left EMPTY. Degrading to absence is safe in a way
 * that choosing is not.
 *
 * This is also what makes blank continuation rows work, which is the shape a real export
 * actually has: `Total` written once on the first row and blank on the rest is one
 * distinct value, not a conflict.
 *
 * ---------------------------------------------------------------------------
 * 3. NOTHING HERE COMPUTES TAX, AND NOTHING HERE INVENTS AN ACCOUNT.
 *
 * A staged line carries `ratePct` — the slab the source recorded — and no components and
 * no `taxableAmount`. Which components apply is the regime's answer as of the document's
 * date and only the documents service may ask it (CONVENTIONS §1.6, and the note above
 * `CreateTaxedDocumentInput` in dto.ts).
 *
 * An `Account` column value is kept as a NAME and resolved through the batch's ledger
 * mapping. An account type this build does not recognise means the account is NOT staged
 * and is reported — after which any ledger pointing at it is unmapped, which is reported
 * too. The chain is deliberate: the failure surfaces as a question the user can answer,
 * never as an account nobody asked for.
 *
 * ---------------------------------------------------------------------------
 * 4. A ROW THAT CANNOT BE PLACED DOES NOT ABORT THE FILE.
 *
 * Every failure below is a `BatchIssue` with a file, a line and a row number. The only
 * things that throw are refusals: a malformed column correction, and the CSV module's own
 * caps on a file that is not a CSV at all.
 */

import { D } from '@main/domain/money'

import type { AccountType } from '@main/domain/ledger'
import type { DocumentKind } from '@shared/documents'
import type { ItemKind } from '@shared/dto'
import type { ReceiptKind } from '@shared/receipts'
import type { DateString } from '@shared/scalars'

import {
  mapCsvRows,
  readCsvTable,
  resolveColumns,
  surveyDateFormats,
  type ColumnMap,
  type CsvParseOptions,
  type CsvRow,
  type CsvTable,
  type DateFormat,
  type MappedRecord,
  type SignedAmount,
} from '../csv'
import {
  documentFingerprint,
  liftCsvIssue,
  receiptFingerprint,
  type BatchIssue,
  type ImportedFile,
  type SourceRow,
  type StagedAccount,
  type StagedAllocation,
  type StagedDocument,
  type StagedDocumentLine,
  type StagedItem,
  type StagedOpeningBalance,
  type StagedParty,
  type StagedReceipt,
} from '../model'
import {
  ZOHO_DEFAULT_DATE_FORMAT,
  zohoColumnMap,
  zohoEntityDefinition,
  type ZohoColumnOverrides,
  type ZohoEntity,
  type ZohoEntityShape,
} from './columns'

/**
 * One file of an export.
 *
 * `entity` is named by the CALLER and not guessed from `name`. Zoho's file names vary with
 * the export's date range and with the user renaming them, and a file read as the wrong
 * entity produces a plausible-looking batch of nonsense rather than an error.
 *
 * `text` is the file's contents. Nothing in this module opens a file — the same rule the
 * CSV foundation keeps, so the decision about which paths may be read stays with the
 * caller, where it can be enforced once.
 */
export interface ZohoFile {
  readonly name: string
  readonly entity: ZohoEntity
  readonly text: string
}

export interface ZohoReadOptions {
  /**
   * The date format the export was written in.
   *
   * Absent means SURVEY IT. Zoho writes dates in whatever format the organisation chose,
   * so `01/02/2027` from one account is a different day from `01/02/2027` from another —
   * and this is the one place an importer must not have a house style.
   */
  readonly dateFormat?: DateFormat
  readonly columns?: ZohoColumnOverrides
  readonly csv?: CsvParseOptions
}

/** Everything one file produced. Empty arrays where the entity produces none of that kind. */
export interface ZohoFileOutcome {
  readonly file: ImportedFile
  readonly issues: readonly BatchIssue[]
  readonly accounts: readonly StagedAccount[]
  readonly parties: readonly StagedParty[]
  readonly items: readonly StagedItem[]
  readonly openingBalances: readonly StagedOpeningBalance[]
  readonly documents: readonly StagedDocument[]
  readonly receipts: readonly StagedReceipt[]
}

/**
 * Zoho's account types, and what each is in Coffer's terms.
 *
 * A CLOSED LIST. An account type not on it is REPORTED and the account is not created —
 * see decision 3 in the header. Guessing from the name ("anything with Payable in it is a
 * liability") is how an asset ends up on the wrong side of a balance sheet that still
 * balances, because the opening entry balances either way.
 */
const ZOHO_ACCOUNT_TYPES: Readonly<Record<string, AccountType>> = {
  'other current asset': 'asset',
  'other asset': 'asset',
  cash: 'asset',
  bank: 'asset',
  'fixed asset': 'asset',
  stock: 'asset',
  'inventory asset': 'asset',
  'accounts receivable': 'asset',
  'payment clearing account': 'asset',
  'other current liability': 'liability',
  'other liability': 'liability',
  'long term liability': 'liability',
  'credit card': 'liability',
  'accounts payable': 'liability',
  equity: 'equity',
  income: 'income',
  'other income': 'income',
  expense: 'expense',
  'other expense': 'expense',
  'cost of goods sold': 'expense',
}

/** Zoho's product types. Anything else is reported; see `readItem`. */
const ZOHO_ITEM_KINDS: Readonly<Record<string, ItemKind>> = {
  goods: 'goods',
  service: 'service',
  services: 'service',
}

/** How Zoho spells a contact's side of the trade. */
const ZOHO_CONTACT_TYPES: Readonly<Record<string, 'customer' | 'vendor'>> = {
  customer: 'customer',
  customers: 'customer',
  vendor: 'vendor',
  vendors: 'vendor',
  supplier: 'vendor',
}

/**
 * Read one file into staged rows.
 *
 * @throws CsvError when the text is not something this build will read at all — see the
 *   caps in csv/parse.ts.
 * @throws ImportError when a column correction is malformed.
 */
export function readZohoFile(file: ZohoFile, options: ZohoReadOptions = {}): ZohoFileOutcome {
  const definition = zohoEntityDefinition(file.entity)
  const issues: BatchIssue[] = []
  const table = readCsvTable(file.text, options.csv ?? {})

  const chosen = chooseDateFormat(file, table, options, issues)
  const map = zohoColumnMap(file.entity, chosen.format, options.columns)

  /*
   * When the dates cannot be settled, the file is mapped WITH NO ROWS IN IT.
   *
   * Not "mapped and then ignored": running the mapper over the rows would produce one
   * INVALID_DATE for every row of the file, and the single sentence that actually explains
   * the problem would be buried under eight hundred copies of its symptom — which is the
   * exact failure decision 1 of mapping.ts exists to prevent. Passing an empty row list
   * keeps every COLUMN-level report (missing, ambiguous, unclaimed) and produces no row
   * work at all.
   */
  const result = mapCsvRows(chosen.readable ? table : { ...table, rows: [], ragged: [] }, map)
  for (const issue of result.issues) {
    issues.push(liftCsvIssue(file.name, issue))
  }

  const groups = groupRecords(result.records, definition.groupBy)

  const context: ReadContext = { file, issues }
  const staged = stageGroups(groups, definition.shape, context)

  return {
    file: {
      name: file.name,
      entity: file.entity,
      headings: table.header.map((column) => column.heading),
      rowsRead: table.rows.length,
      rowsStaged: groups.reduce((total, group) => total + group.rows.length, 0),
      dateFormat: chosen.stated ? chosen.format : null,
    },
    issues,
    ...staged,
  }
}

// ---- Grouping -------------------------------------------------------------

/** One staged thing's worth of rows, in the order the file listed them. */
export interface RowGroup {
  readonly key: string
  readonly rows: readonly MappedRecord<ColumnMap>[]
}

/**
 * Group mapped rows, without assuming anything about their order.
 *
 * A Map keyed on the group value: insertion order is first appearance, and a row that
 * turns up again after other documents' rows joins the group it belongs to rather than
 * starting a second one. See decision 1 in the header.
 *
 * `fields` is a PRECEDENCE, not a set of alternatives: the first one with a value wins, so
 * an entity is grouped by its source id where the file carries one and by its name where
 * it does not. That is a stated order and not the `.find` trap — the trap is a list whose
 * members are meant to be equivalent, and these are not.
 */
export function groupRecords(
  records: readonly MappedRecord<ColumnMap>[],
  fields: readonly string[],
): readonly RowGroup[] {
  const groups = new Map<string, MappedRecord<ColumnMap>[]>()
  for (const record of records) {
    const key = groupKey(record, fields)
    if (key === null) {
      continue
    }
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, [record])
    } else {
      existing.push(record)
    }
  }
  return [...groups.entries()].map(([key, rows]) => ({ key, rows }))
}

function groupKey(record: MappedRecord<ColumnMap>, fields: readonly string[]): string | null {
  for (const field of fields) {
    const value = cell(record, field)
    if (value !== undefined) {
      return value
    }
  }
  return null
}

// ---- Reading one group ----------------------------------------------------

interface ReadContext {
  readonly file: ZohoFile
  readonly issues: BatchIssue[]
}

interface StagedCollections {
  readonly accounts: StagedAccount[]
  readonly parties: StagedParty[]
  readonly items: StagedItem[]
  readonly openingBalances: StagedOpeningBalance[]
  readonly documents: StagedDocument[]
  readonly receipts: StagedReceipt[]
}

function stageGroups(
  groups: readonly RowGroup[],
  shape: ZohoEntityShape,
  context: ReadContext,
): StagedCollections {
  const staged: StagedCollections = {
    accounts: [],
    parties: [],
    items: [],
    openingBalances: [],
    documents: [],
    receipts: [],
  }

  for (const group of groups) {
    /* A switch, exhaustively checked, so an entity shape added without a reader does not
     * compile — the property CONVENTIONS §9 asks a total record for. */
    switch (shape.kind) {
      case 'contacts': {
        const read = readContact(group, context)
        if (read !== null) {
          staged.parties.push(read.party)
          if (read.openingBalance !== null) {
            staged.openingBalances.push(read.openingBalance)
          }
        }
        break
      }
      case 'items': {
        const item = readItem(group, context)
        if (item !== null) {
          staged.items.push(item)
        }
        break
      }
      case 'accounts': {
        const account = readAccount(group, context)
        if (account !== null) {
          staged.accounts.push(account)
        }
        break
      }
      case 'document': {
        const document = readDocument(group, shape.documentKind, context)
        if (document !== null) {
          staged.documents.push(document)
        }
        break
      }
      case 'voucher': {
        const receipt = readVoucher(group, shape.receiptKind, context)
        if (receipt !== null) {
          staged.receipts.push(receipt)
        }
        break
      }
      default:
        return assertNever(shape)
    }
  }

  return staged
}

// ---- Contacts -------------------------------------------------------------

function readContact(
  group: RowGroup,
  context: ReadContext,
): { party: StagedParty; openingBalance: StagedOpeningBalance | null } | null {
  const header = new GroupHeader(group, context, 'contact')
  const name = header.required('name', 'a display name')
  if (name === null) {
    return null
  }

  const sourceId = header.optional('sourceId') ?? `contact:${name}`
  const declared = header.optional('contactType')
  const role = declared === undefined ? undefined : ZOHO_CONTACT_TYPES[foldValue(declared)]
  if (role === undefined) {
    context.issues.push(
      header.issue(
        'UNKNOWN_PARTY_ROLE',
        'warning',
        `Coffer could not tell from this export whether ${JSON.stringify(name)} is a customer ` +
          'or a vendor. It has been worked out from the transactions that name them, and can ' +
          'be set by hand afterwards.',
        sourceId,
      ),
    )
  }

  const party: StagedParty = {
    sourceId,
    name,
    isCustomer: role === 'customer',
    isVendor: role === 'vendor',
    legalName: header.optional('companyName'),
    registrationNumber: header.optional('registrationNumber'),
    /* `Place of Contact` where the export has one, falling back to the billing state. Both
     * are the state's NAME; turning that into the code that decides the place of supply is
     * the regime's answer and not this module's (CONVENTIONS §1.6). */
    jurisdictionName: header.optional('jurisdictionName') ?? header.optional('billingState'),
    countryName: header.optional('countryName'),
    addressLine1: header.optional('addressLine1'),
    addressLine2: header.optional('addressLine2'),
    city: header.optional('city'),
    postalCode: header.optional('postalCode'),
    email: header.optional('email'),
    phone: header.optional('phone') ?? header.optional('mobile'),
    paymentTermsDays: header.wholeNumber('paymentTerms'),
    creditLimit: header.optional('creditLimit'),
    notes: header.optional('notes'),
    isArchived: archivedFrom(header.optional('status')),
    provenance: header.provenance,
  }

  const opening = header.optional('openingBalance')
  if (opening === undefined || D(opening).isZero()) {
    return { party, openingBalance: null }
  }

  return {
    party,
    openingBalance: {
      sourceId: `opening:${sourceId}`,
      /* A contact's opening balance is against a control account BY DEFINITION and the
       * file names no ledger for it, which is exactly the case `LedgerReference`'s `role`
       * member exists for. The amount is positive in the account's normal direction, as
       * `OpeningBalanceLine` requires — Zoho writes it the same way round. */
      ledger: {
        kind: 'role',
        role: party.isVendor ? 'accounts-payable' : 'accounts-receivable',
      },
      partySourceId: sourceId,
      partyName: name,
      amount: opening,
      provenance: header.provenance,
    },
  }
}

// ---- Items ----------------------------------------------------------------

function readItem(group: RowGroup, context: ReadContext): StagedItem | null {
  const header = new GroupHeader(group, context, 'item')
  const name = header.required('name', 'an item name')
  if (name === null) {
    return null
  }
  const sourceId = header.optional('sourceId') ?? `item:${name}`

  const declared = header.optional('productType')
  const kind = declared === undefined ? undefined : ZOHO_ITEM_KINDS[foldValue(declared)]
  if (declared !== undefined && kind === undefined) {
    context.issues.push(
      header.issue(
        'UNKNOWN_ITEM_KIND',
        'warning',
        `${JSON.stringify(declared)} is not a product type Coffer knows, so ` +
          `${JSON.stringify(name)} has been brought in as goods. Change it on the item if it ` +
          'is a service.',
        sourceId,
      ),
    )
  }

  const salePrice = header.optional('salePrice')
  const purchasePrice = header.optional('purchasePrice')
  const salesLedger = header.optional('salesLedger')
  const purchaseLedger = header.optional('purchaseLedger')
  const sold = salePrice !== undefined || salesLedger !== undefined
  const purchased = purchasePrice !== undefined || purchaseLedger !== undefined

  return {
    sourceId,
    name,
    kind: kind ?? 'goods',
    /* An item the export says nothing about is offered on BOTH sides. An item on neither
     * side appears in no picker at all, which looks to the user like the import having
     * dropped it — and the correction is one click either way. */
    isSold: sold || !purchased,
    isPurchased: purchased || !sold,
    code: header.optional('code'),
    description: header.optional('description'),
    unitLabel: header.optional('unitLabel'),
    classificationCode: header.optional('classificationCode'),
    taxRatePct: header.optional('taxRatePct'),
    salePrice,
    purchasePrice,
    salesLedger,
    purchaseLedger,
    isArchived: archivedFrom(header.optional('status')),
    provenance: header.provenance,
  }
}

// ---- Chart of accounts ----------------------------------------------------

function readAccount(group: RowGroup, context: ReadContext): StagedAccount | null {
  const header = new GroupHeader(group, context, 'account')
  const name = header.required('name', 'an account name')
  if (name === null) {
    return null
  }

  const sourceType = header.optional('sourceType')
  const type = sourceType === undefined ? undefined : ZOHO_ACCOUNT_TYPES[foldValue(sourceType)]
  if (type === undefined) {
    /*
     * Decision 3: the account is NOT created. An account whose type this build guessed is
     * an account on the wrong side of the balance sheet, and the balance sheet still
     * balances — so nothing downstream can find it.
     *
     * A WARNING, NOT AN ERROR, and the distinction is the design working rather than a
     * softening of it. The account not existing is only a problem if something needs it,
     * and what would need it is a LEDGER pointing at this name — which then resolves to
     * `unmapped`, which IS an error and does block the write. So the severity lands where
     * the consequence is: an unused account nobody can classify should not stop an
     * otherwise clean import of eight hundred invoices.
     */
    context.issues.push(
      header.issue(
        'UNKNOWN_ACCOUNT_TYPE',
        'warning',
        sourceType === undefined
          ? `The account ${JSON.stringify(name)} has no account type in this export, so Coffer ` +
              'cannot tell what kind of account it is. Create it in Coffer, then map the ledger to it.'
          : `Coffer does not recognise the account type ${JSON.stringify(sourceType)} for ` +
              `${JSON.stringify(name)}, so the account has not been created. Create it in ` +
              'Coffer, then map the ledger to it.',
        name,
      ),
    )
    return null
  }

  const code = header.optional('code')
  return {
    sourceId: code ?? `account:${name}`,
    name,
    type,
    sourceType: sourceType ?? '',
    code,
    parentName: header.optional('parentName'),
    description: header.optional('description'),
    isArchived: archivedFrom(header.optional('status')),
    provenance: header.provenance,
  }
}

// ---- Documents ------------------------------------------------------------

/**
 * What makes a row of a group a LINE rather than only a carrier of header values.
 *
 * Some templates write a document-level row with nothing on it but the totals. Skipping
 * such a row is not the same as dropping it: its header values were read with the rest of
 * the group, and only its (absent) line is left out.
 */
const LINE_FIELDS = [
  'itemName',
  'itemDescription',
  'quantity',
  'unitPrice',
  'statedLineTotal',
] as const

function readDocument(
  group: RowGroup,
  kind: DocumentKind,
  context: ReadContext,
): StagedDocument | null {
  const header = new GroupHeader(group, context, 'document')
  const number = header.required('number', 'a number')
  const date = header.requiredDate('date')
  const partyName = header.required('partyName', 'a name for the customer or vendor')
  if (number === null || date === null || partyName === null) {
    return null
  }

  const lines: StagedDocumentLine[] = []
  for (const row of group.rows) {
    if (LINE_FIELDS.some((field) => cell(row, field) !== undefined)) {
      lines.push(readLine(row, lines.length + 1, number, context))
    }
  }

  const draft = {
    kind,
    number,
    date,
    partyName,
    partySourceId: header.optional('partySourceId'),
    statedTotal: header.optional('statedTotal'),
    lines,
  }

  return {
    sourceId: header.optional('sourceId') ?? `${context.file.entity}:${number}`,
    ...draft,
    dueDate: header.optionalDate('dueDate'),
    partyReference: header.optional('partyReference'),
    placeOfSupplyName: header.optional('placeOfSupply'),
    narration: header.optional('narration'),
    statedBalance: header.optional('statedBalance'),
    sourceStatus: header.optional('sourceStatus'),
    provenance: header.provenance,
    fingerprint: documentFingerprint(draft),
  }
}

function readLine(
  row: MappedRecord<ColumnMap>,
  lineNumber: number,
  number: string,
  context: ReadContext,
): StagedDocumentLine {
  const itemName = cell(row, 'itemName')
  const description = cell(row, 'itemDescription') ?? itemName
  if (description === undefined) {
    /* Staged anyway, with a warning. Dropping the line would change the document's total
     * without saying so, and a total that is quietly wrong is worse than a description a
     * user can type into one field. */
    context.issues.push({
      code: 'MISSING_VALUE',
      severity: 'warning',
      message:
        `Line ${String(lineNumber)} of ${JSON.stringify(number)} has neither an item name nor a ` +
        'description. It has been brought in with an empty description.',
      file: context.file.name,
      line: row.line,
      rowNumber: row.rowNumber,
      sourceId: number,
    })
  }

  return {
    lineNumber,
    description: description ?? '',
    /* A blank quantity is one, and a blank price is nothing. Both are ordinary on a
     * service line, and neither is a guess about what the source meant: a line with no
     * quantity column at all is one of something. */
    quantity: cell(row, 'quantity') ?? '1.000',
    unitPrice: cell(row, 'unitPrice') ?? '0.00',
    discount: cell(row, 'discount') ?? '0.00',
    itemSourceId: cell(row, 'itemSourceId'),
    itemName,
    unitLabel: cell(row, 'unitLabel'),
    ratePct: cell(row, 'ratePct'),
    classificationCode: cell(row, 'classificationCode'),
    ledger: cell(row, 'ledger'),
    statedLineTotal: cell(row, 'statedLineTotal'),
    provenance: [sourceRowOf(context.file, row)],
  }
}

// ---- Vouchers -------------------------------------------------------------

function readVoucher(
  group: RowGroup,
  kind: ReceiptKind,
  context: ReadContext,
): StagedReceipt | null {
  const header = new GroupHeader(group, context, 'payment')
  const number = header.required('number', 'a number')
  const date = header.requiredDate('date')
  const partyName = header.required('partyName', 'a name for the customer or vendor')
  const amount = header.required('amount', 'an amount')
  if (number === null || date === null || partyName === null || amount === null) {
    return null
  }

  const allocations: StagedAllocation[] = []
  for (const row of group.rows) {
    const documentNumber = cell(row, 'documentNumber')
    const applied = cell(row, 'appliedAmount')
    if (documentNumber === undefined && applied === undefined) {
      continue
    }
    if (documentNumber === undefined) {
      context.issues.push({
        code: 'ROW_NOT_GROUPED',
        severity: 'warning',
        message:
          `A row of ${JSON.stringify(number)} says ${String(applied)} was applied but does not ` +
          'say which document to, so Coffer has left that much on account.',
        file: context.file.name,
        line: row.line,
        rowNumber: row.rowNumber,
        sourceId: number,
      })
      continue
    }
    if (applied === undefined) {
      context.issues.push({
        code: 'MISSING_VALUE',
        severity: 'warning',
        message:
          `${JSON.stringify(number)} names ${JSON.stringify(documentNumber)} but does not say ` +
          'how much of it was settled, so nothing has been matched against it.',
        file: context.file.name,
        line: row.line,
        rowNumber: row.rowNumber,
        sourceId: number,
      })
      continue
    }
    allocations.push({
      documentNumber,
      amount: applied,
      provenance: [sourceRowOf(context.file, row)],
    })
  }

  const draft = {
    kind,
    date,
    partyName,
    amount,
    partySourceId: header.optional('partySourceId'),
    reference: header.optional('reference'),
  }

  return {
    sourceId: header.optional('sourceId') ?? `${context.file.entity}:${number}`,
    number,
    ...draft,
    ledger: header.optional('ledger'),
    narration: header.optional('narration') ?? header.optional('mode'),
    allocations,
    provenance: header.provenance,
    fingerprint: receiptFingerprint(draft),
  }
}

// ---- Reading a group's header fields --------------------------------------

/** What a field's values across a group came to. Exactly one of the two is set. */
export interface Agreement {
  readonly value?: string
  readonly conflict?: readonly string[]
}

/**
 * The values a field takes across a group, reduced to one.
 *
 * Blank cells are absent, so a document-level column written once and left blank on the
 * continuation rows has ONE distinct value. Two distinct values is a conflict; see
 * decision 2 in the header.
 */
export function agreedValue(rows: readonly MappedRecord<ColumnMap>[], field: string): Agreement {
  const distinct = [
    ...new Set(
      rows.map((row) => cell(row, field)).filter((value): value is string => value !== undefined),
    ),
  ]
  const [only, ...rest] = distinct
  if (rest.length > 0) {
    return { conflict: distinct }
  }
  return only === undefined ? {} : { value: only }
}

/** Reads one group's document-level fields, reporting rather than choosing. */
class GroupHeader {
  readonly provenance: readonly SourceRow[]
  private readonly rows: readonly MappedRecord<ColumnMap>[]
  private readonly context: ReadContext
  private readonly what: string

  constructor(group: RowGroup, context: ReadContext, what: string) {
    this.rows = group.rows
    this.context = context
    this.what = what
    this.provenance = group.rows.map((row) => sourceRowOf(context.file, row))
  }

  /** A field the thing cannot exist without. A conflict or an absence drops it, reported. */
  required(field: string, what: string): string | null {
    const agreed = agreedValue(this.rows, field)
    if (agreed.conflict !== undefined) {
      this.context.issues.push(
        this.issue(
          'CONFLICTING_HEADER',
          'error',
          `The rows of this ${this.what} disagree about ${field}: ` +
            `${agreed.conflict.map((value) => JSON.stringify(value)).join(' and ')}. ` +
            'Coffer will not choose between them, so it has been left out of the import.',
        ),
      )
      return null
    }
    if (agreed.value === undefined) {
      this.context.issues.push(
        this.issue(
          'MISSING_VALUE',
          'error',
          `A ${this.what} in this file has no ${what}, so it has been left out of the import.`,
        ),
      )
      return null
    }
    return agreed.value
  }

  /** A field that can be absent. A conflict leaves it absent and warns. */
  optional(field: string): string | undefined {
    const agreed = agreedValue(this.rows, field)
    if (agreed.conflict !== undefined) {
      this.context.issues.push(
        this.issue(
          'CONFLICTING_HEADER',
          'warning',
          `The rows of this ${this.what} disagree about ${field}: ` +
            `${agreed.conflict.map((value) => JSON.stringify(value)).join(' and ')}. ` +
            'It has been left empty rather than guessed at.',
        ),
      )
      return undefined
    }
    return agreed.value
  }

  /** A date field. Same rules; the name says what the value is for a reader. */
  requiredDate(field: string): DateString | null {
    return this.required(field, 'a date')
  }

  optionalDate(field: string): DateString | undefined {
    return this.optional(field)
  }

  /**
   * A field that has to be a whole number of days.
   *
   * Zoho writes payment terms as `30`, and some templates write `Due on Receipt`. The
   * second is not a number of days and is reported rather than read as zero — zero days
   * and "no terms agreed" are different answers, and `Party.paymentTermsDays` is null for
   * the second one on purpose.
   */
  wholeNumber(field: string): number | undefined {
    const raw = this.optional(field)
    if (raw === undefined) {
      return undefined
    }
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 0) {
      this.context.issues.push(
        this.issue(
          'INVALID_NUMBER',
          'warning',
          `${JSON.stringify(raw)} is not a whole number of days, so no payment terms have been ` +
            'set for this contact.',
        ),
      )
      return undefined
    }
    return value
  }

  /** An issue located at this group's first row. */
  issue(
    code: BatchIssue['code'],
    severity: BatchIssue['severity'],
    message: string,
    sourceId?: string,
  ): BatchIssue {
    const first = this.provenance[0]
    return {
      code,
      severity,
      message,
      file: this.context.file.name,
      line: first?.line,
      rowNumber: first?.rowNumber,
      sourceId,
    }
  }
}

// ---- Dates ----------------------------------------------------------------

interface ChosenFormat {
  readonly format: DateFormat
  /** False when the file's dates are ambiguous or unreadable and no row may be read. */
  readonly readable: boolean
  /** True when the format is a real answer about this file rather than the placeholder. */
  readonly stated: boolean
}

/**
 * Decide which date format this file is in, or refuse to read it.
 *
 * The whole point of `surveyDateFormats` is that it reports ambiguity instead of guessing,
 * and this is where that is spent. Four outcomes:
 *
 *   the caller named one    use it. Somebody who has the file open knows.
 *   unambiguous             one format reads every value. Use it.
 *   ambiguous, but every
 *   surviving format gives
 *   the SAME date           nothing to ask about — `05/05/2027` is the fifth of May either
 *                           way — so the file is read and a warning says the file could not
 *                           prove its own format.
 *   ambiguous and they
 *   disagree, or nothing
 *   reads them              an ERROR, and NO ROW OF THE FILE IS READ. A date read in the
 *                           wrong format is a wrong date that looks exactly like a right
 *                           one: 03/04/2027 lands in April or in March, both are real days,
 *                           and nothing downstream can ever notice.
 *
 * The survey pools EVERY date column of the file rather than taking them one at a time. An
 * invoice date and a due date in one export are written by one program in one format, and
 * pooling them is strictly more evidence — a file whose invoice dates all fall before the
 * 13th can still be settled by a due date on the 20th.
 */
function chooseDateFormat(
  file: ZohoFile,
  table: CsvTable,
  options: ZohoReadOptions,
  issues: BatchIssue[],
): ChosenFormat {
  if (options.dateFormat !== undefined) {
    return { format: options.dateFormat, readable: true, stated: true }
  }

  const provisional = zohoColumnMap(file.entity, ZOHO_DEFAULT_DATE_FORMAT, options.columns)
  const dateFields = new Set(
    Object.entries(provisional)
      .filter(([, spec]) => spec.kind === 'date')
      .map(([field]) => field),
  )
  const indexes = resolveColumns(table.header, provisional)
    .columns.filter((resolved) => dateFields.has(resolved.field))
    .flatMap((resolved) => resolved.columns.map((column) => column.index))

  if (indexes.length === 0) {
    /* This entity has no date columns in this file — a chart of accounts has none at all,
     * and a file missing one has already been told about it by `mapCsvRows`. Nothing to
     * survey and nothing to say. */
    return { format: ZOHO_DEFAULT_DATE_FORMAT, readable: true, stated: false }
  }

  const values = table.rows.flatMap((row) => indexes.map((index) => cellOfRow(row, index)))
  const survey = surveyDateFormats(values)
  const [best] = survey.consistent

  if (survey.verdict === 'unambiguous' && best !== undefined) {
    return { format: best, readable: true, stated: true }
  }

  if (survey.verdict === 'none') {
    /* Date columns with nothing in them is not a reason to refuse a file; date columns
     * that read as nothing IS one, and it is a different sentence. */
    const empty = survey.valuesConsidered === 0
    issues.push({
      code: empty ? 'MISSING_VALUE' : 'DATE_FORMAT_UNREADABLE',
      severity: empty ? 'warning' : 'error',
      message: empty
        ? `Every date in ${file.name} is empty, so nothing in it has been given a date.`
        : `Coffer could not read the dates in ${file.name} in any format it knows. Tell it ` +
          'which format the file uses, or export it again as YYYY-MM-DD.',
      file: file.name,
    })
    return { format: ZOHO_DEFAULT_DATE_FORMAT, readable: empty, stated: false }
  }

  if (survey.agreeOnEveryValue && best !== undefined) {
    issues.push({
      code: 'DATE_FORMAT_AMBIGUOUS',
      severity: 'warning',
      message:
        `The dates in ${file.name} could be read as ${survey.consistent.join(' or ')}, and every ` +
        `one of them means the same day either way, so the file has been read as ${best}.`,
      file: file.name,
    })
    return { format: best, readable: true, stated: true }
  }

  issues.push({
    code: 'DATE_FORMAT_AMBIGUOUS',
    severity: 'error',
    message:
      `The dates in ${file.name} could be read as ${survey.consistent.join(' or ')}, and those ` +
      'readings do not agree. Nothing has been read from this file — tell Coffer which format ' +
      'it is in and try again.',
    file: file.name,
  })
  return { format: ZOHO_DEFAULT_DATE_FORMAT, readable: false, stated: false }
}

// ---- Small shared pieces --------------------------------------------------

/**
 * One mapped cell as text, or absent.
 *
 * The mapping is typed by its own literal shape and this module holds it widened to
 * `ColumnMap`, so a value arrives as the union of everything a field kind can produce. All
 * of this importer's fields are text, dates or decimals — every one of them a string — and
 * the guard is what makes that a check rather than an assumption.
 *
 * NO BLANK CHECK HERE, DELIBERATELY, AND THIS IS WORTH THE SENTENCE BECAUSE THE FIRST
 * VERSION HAD ONE. `mapCsvRows` already maps a blank cell to `undefined` — `isBlank` folds
 * invisibles and whitespace before deciding — and it already trims what it keeps. A second
 * `trimmed === '' ? undefined : trimmed` here was therefore a branch nothing could reach
 * and no mutation could kill, which CONVENTIONS §6 is explicit about not keeping.
 */
export function cell(record: MappedRecord<ColumnMap>, field: string): string | undefined {
  const value: string | SignedAmount | undefined = record.values[field]
  return typeof value === 'string' ? value : undefined
}

function cellOfRow(row: CsvRow, index: number): string {
  return row.fields[index] ?? ''
}

function sourceRowOf(
  file: ZohoFile,
  record: { readonly line: number; readonly rowNumber: number },
): SourceRow {
  return { file: file.name, line: record.line, rowNumber: record.rowNumber }
}

/** Zoho marks a disabled record `Inactive`. Absent means active, which is the common case. */
function archivedFrom(status: string | undefined): boolean | undefined {
  if (status === undefined) {
    return undefined
  }
  return foldValue(status) === 'inactive' ? true : undefined
}

function foldValue(value: string): string {
  return value.trim().toLowerCase()
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Zoho entity shape: ${JSON.stringify(value)}`)
}
