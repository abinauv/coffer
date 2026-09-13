/*
 * WHERE ZOHO BOOKS' COLUMNS ARE, DECLARED AS DATA.
 *
 * ---------------------------------------------------------------------------
 * READ THIS FIRST: THE HEADINGS BELOW ARE A BEST-EFFORT DEFAULT, NOT A SCHEMA.
 *
 * There is no published schema for a Zoho Books CSV export and the batch that wrote this
 * had NO SAMPLE EXPORT to check against. The exact column names vary by the account's
 * settings (whether GST is enabled, whether discounts are per line or per document),
 * by region, and between versions of the product — `Item Price` and `Rate` are the same
 * column in two different years, and `EmailID` and `Email` are the same column in two
 * different templates.
 *
 * So this file is written to be WRONG SAFELY:
 *
 *   - Every field lists SEVERAL candidate headings, and matching is case- and
 *     whitespace-insensitive because `findColumn` folds both (csv/text.ts).
 *   - Every field is OVERRIDABLE by the caller (`ZohoColumnOverrides`), so a user or a
 *     later batch corrects a heading without a code change.
 *   - A column in the file that no field claims is REPORTED — `mapCsvRows` emits
 *     `UNMAPPED_COLUMN` for it — rather than dropped in silence. That report, plus the
 *     `headings` recorded on every `ImportedFile`, is how a wrong assumption here is
 *     diagnosed from the batch alone.
 *   - Two candidates that are BOTH present resolve to nothing and are reported as
 *     ambiguous, never to whichever is listed first (mapping.ts, decision 3). A file that
 *     has both `Item Price` and `Rate` is a file whose author has to tell us which one.
 *
 * ONLY THE DOCUMENT NUMBER IS REQUIRED, on the entities that have one. That is deliberate
 * and it is decision 1 of mapping.ts turned to this problem: a missing NUMBER column
 * means the file cannot be grouped at all and the user needs one sentence about it before
 * any row is read. Everything else is optional at the column level and checked once per
 * GROUP instead, because a real export writes the document-level fields on the first row
 * of an invoice and leaves them blank on its continuation rows.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TARGET FIELD NAMES ARE THE SAME ACROSS THE THREE DOCUMENT ENTITIES
 *
 * An invoice, a credit note and a bill differ in their HEADINGS and in nothing else that
 * matters to the reader — `Invoice Date`, `Credit Note Date`, `Bill Date` are one field.
 * Naming the targets identically means read.ts has ONE document reader rather than three
 * that agree by inspection, and the `DocumentKind` each produces comes off the entity
 * table rather than out of a condition. The same holds for the two payment entities.
 */

import type { DocumentKind } from '@shared/documents'
import type { ReceiptKind } from '@shared/receipts'

import type { ColumnMap, DateFieldSpec, DateFormat, FieldSpec } from '../csv'
import { ImportError } from '../model'

/** Every entity this importer reads. Closed: an unknown entity is a refusal, not a guess. */
export const ZOHO_ENTITIES = [
  'contacts',
  'items',
  'chart-of-accounts',
  'invoices',
  'credit-notes',
  'bills',
  'customer-payments',
  'vendor-payments',
] as const

export type ZohoEntity = (typeof ZOHO_ENTITIES)[number]

/** True when `value` names an entity this importer reads. */
export function isZohoEntity(value: unknown): value is ZohoEntity {
  return typeof value === 'string' && (ZOHO_ENTITIES as readonly string[]).includes(value)
}

/**
 * What kind of thing a file produces, and the one fact that differs per entity.
 *
 * A discriminated union rather than a `kind` plus two nullable fields: a document entity
 * has a `DocumentKind` and a voucher entity has a `ReceiptKind`, never both and never
 * neither. read.ts switches on it exhaustively, so an entity added without a reader does
 * not compile.
 */
export type ZohoEntityShape =
  | { readonly kind: 'contacts' }
  | { readonly kind: 'items' }
  | { readonly kind: 'accounts' }
  | { readonly kind: 'document'; readonly documentKind: DocumentKind }
  | { readonly kind: 'voucher'; readonly receiptKind: ReceiptKind }

export interface ZohoEntityDefinition {
  readonly entity: ZohoEntity
  /** What the user sees. */
  readonly label: string
  /** The file name a Zoho export usually gives this. Informational — the caller says which is which. */
  readonly defaultFileName: string
  readonly shape: ZohoEntityShape
  /**
   * The field whose value groups rows into one staged thing.
   *
   * EVERY entity is grouped, not only the ones with multi-row documents. A Zoho contacts
   * export writes one row per CONTACT PERSON, so the same `Contact ID` appears three times
   * for a firm with three people in it — and an importer that stages one party per row
   * creates three copies of that customer, silently. One grouping rule, applied
   * everywhere, is one thing to get right.
   */
  readonly groupBy: readonly string[]
  readonly columns: ColumnMap
}

/*
 * The date format the specs below are declared with.
 *
 * A PLACEHOLDER, and the survey usually replaces it. Zoho writes dates in the format the
 * organisation chose, so `01/02/2027` from one account is a different day from
 * `01/02/2027` from another. `readZohoFile` surveys the file's own date columns with
 * `surveyDateFormats` and only uses this when the caller names no format and the file
 * offers nothing to survey.
 */
export const ZOHO_DEFAULT_DATE_FORMAT: DateFormat = 'YYYY-MM-DD'

const text = (columns: readonly string[], required = false): FieldSpec => ({
  kind: 'text',
  columns,
  required,
})

const date = (columns: readonly string[]): FieldSpec => ({
  kind: 'date',
  columns,
  required: false,
  format: ZOHO_DEFAULT_DATE_FORMAT,
})

const money = (columns: readonly string[]): FieldSpec => ({
  kind: 'decimal',
  columns,
  required: false,
})

const quantity = (columns: readonly string[]): FieldSpec => ({
  kind: 'decimal',
  columns,
  required: false,
  scale: 'quantity',
})

const rate = (columns: readonly string[]): FieldSpec => ({
  kind: 'decimal',
  columns,
  required: false,
  scale: 'rate',
})

/*
 * The document entities share every target field name and differ only in headings, so
 * the three maps below are built by one function. `numberColumns` is the only required
 * field — see the header.
 */
function documentColumns(headings: {
  readonly number: readonly string[]
  readonly sourceId: readonly string[]
  readonly date: readonly string[]
  readonly status: readonly string[]
  readonly partySourceId: readonly string[]
  readonly partyName: readonly string[]
  readonly unitPrice: readonly string[]
}): ColumnMap {
  return {
    number: text(headings.number, true),
    sourceId: text(headings.sourceId),
    date: date(headings.date),
    dueDate: date(['Due Date']),
    sourceStatus: text(headings.status),
    partySourceId: text(headings.partySourceId),
    partyName: text(headings.partyName),
    partyReference: text(['PurchaseOrder', 'Purchase Order', 'Reference#']),
    placeOfSupply: text(['Place of Supply']),
    narration: text(['Notes']),
    statedTotal: money(['Total']),
    statedBalance: money(['Balance']),
    itemSourceId: text(['Product ID']),
    itemName: text(['Item Name']),
    itemDescription: text(['Item Desc']),
    quantity: quantity(['Quantity']),
    unitLabel: text(['Usage unit']),
    unitPrice: money(headings.unitPrice),
    discount: money(['Discount Amount']),
    ratePct: rate(['Item Tax %']),
    classificationCode: text(['HSN/SAC']),
    ledger: text(['Account']),
    statedLineTotal: money(['Item Total']),
  }
}

function voucherColumns(headings: {
  readonly number: readonly string[]
  readonly sourceId: readonly string[]
  readonly partySourceId: readonly string[]
  readonly partyName: readonly string[]
  readonly ledger: readonly string[]
  readonly documentNumber: readonly string[]
  readonly appliedAmount: readonly string[]
}): ColumnMap {
  return {
    number: text(headings.number, true),
    sourceId: text(headings.sourceId),
    date: date(['Date', 'Payment Date']),
    partySourceId: text(headings.partySourceId),
    partyName: text(headings.partyName),
    amount: money(['Amount']),
    ledger: text(headings.ledger),
    reference: text(['Reference Number']),
    mode: text(['Payment Mode', 'Mode']),
    narration: text(['Description']),
    documentNumber: text(headings.documentNumber),
    appliedAmount: money(headings.appliedAmount),
  }
}

/**
 * The entity table.
 *
 * A total record over `ZohoEntity` (CONVENTIONS §9): adding an entity to the union does
 * not compile until it has a row here, rather than falling through to whatever a lookup
 * happened to return.
 */
export const ZOHO_ENTITY_DEFINITIONS: Readonly<Record<ZohoEntity, ZohoEntityDefinition>> = {
  contacts: {
    entity: 'contacts',
    label: 'Contacts',
    defaultFileName: 'Contacts.csv',
    shape: { kind: 'contacts' },
    groupBy: ['sourceId', 'name'],
    columns: {
      sourceId: text(['Contact ID']),
      name: text(['Display Name', 'Contact Name'], true),
      companyName: text(['Company Name']),
      contactType: text(['Contact Type']),
      email: text(['EmailID', 'Email', 'Email ID']),
      phone: text(['Phone']),
      mobile: text(['MobilePhone', 'Mobile Phone']),
      registrationNumber: text(['GST Identification Number (GSTIN)', 'GSTIN']),
      jurisdictionName: text(['Place of Contact']),
      billingState: text(['Billing State']),
      countryName: text(['Billing Country']),
      addressLine1: text(['Billing Address']),
      addressLine2: text(['Billing Street2']),
      city: text(['Billing City']),
      postalCode: text(['Billing Code']),
      paymentTerms: text(['Payment Terms']),
      creditLimit: money(['Credit Limit']),
      openingBalance: money(['Opening Balance']),
      notes: text(['Notes']),
      status: text(['Status']),
    },
  },

  items: {
    entity: 'items',
    label: 'Items',
    defaultFileName: 'Item.csv',
    shape: { kind: 'items' },
    groupBy: ['sourceId', 'name'],
    columns: {
      sourceId: text(['Item ID']),
      name: text(['Item Name'], true),
      code: text(['SKU']),
      description: text(['Description']),
      productType: text(['Product Type']),
      unitLabel: text(['Usage unit']),
      classificationCode: text(['HSN/SAC']),
      taxRatePct: rate(['Tax Percentage']),
      salePrice: money(['Rate']),
      purchasePrice: money(['Purchase Rate']),
      salesLedger: text(['Account']),
      purchaseLedger: text(['Purchase Account']),
      status: text(['Status']),
    },
  },

  'chart-of-accounts': {
    entity: 'chart-of-accounts',
    label: 'Chart of accounts',
    defaultFileName: 'Chart_of_Accounts.csv',
    shape: { kind: 'accounts' },
    groupBy: ['name'],
    columns: {
      code: text(['Account Code']),
      name: text(['Account Name'], true),
      sourceType: text(['Account Type']),
      description: text(['Description']),
      parentName: text(['Parent Account']),
      status: text(['Status']),
    },
  },

  invoices: {
    entity: 'invoices',
    label: 'Invoices',
    defaultFileName: 'Invoice.csv',
    shape: { kind: 'document', documentKind: 'sales-invoice' },
    groupBy: ['number'],
    columns: documentColumns({
      number: ['Invoice Number'],
      sourceId: ['Invoice ID'],
      date: ['Invoice Date'],
      status: ['Invoice Status'],
      partySourceId: ['Customer ID'],
      partyName: ['Customer Name'],
      unitPrice: ['Item Price'],
    }),
  },

  'credit-notes': {
    entity: 'credit-notes',
    label: 'Credit notes',
    defaultFileName: 'Credit_Note.csv',
    shape: { kind: 'document', documentKind: 'credit-note' },
    groupBy: ['number'],
    columns: documentColumns({
      number: ['Credit Note Number'],
      sourceId: ['CreditNotes ID', 'Credit Note ID'],
      date: ['Credit Note Date'],
      status: ['Credit Note Status'],
      partySourceId: ['Customer ID'],
      partyName: ['Customer Name'],
      unitPrice: ['Item Price'],
    }),
  },

  bills: {
    entity: 'bills',
    label: 'Bills',
    defaultFileName: 'Bill.csv',
    shape: { kind: 'document', documentKind: 'purchase-bill' },
    groupBy: ['number'],
    columns: documentColumns({
      number: ['Bill Number'],
      sourceId: ['Bill ID'],
      date: ['Bill Date'],
      status: ['Bill Status'],
      partySourceId: ['Vendor ID'],
      partyName: ['Vendor Name'],
      unitPrice: ['Item Price', 'Rate'],
    }),
  },

  'customer-payments': {
    entity: 'customer-payments',
    label: 'Customer payments',
    defaultFileName: 'Customer_Payment.csv',
    shape: { kind: 'voucher', receiptKind: 'receipt' },
    groupBy: ['number'],
    columns: voucherColumns({
      number: ['Payment Number'],
      sourceId: ['CustomerPayment ID', 'Payment ID'],
      partySourceId: ['Customer ID'],
      partyName: ['Customer Name'],
      ledger: ['Deposit To', 'Deposit To Account'],
      documentNumber: ['Invoice Number'],
      appliedAmount: ['Invoice Payment Applied Amount'],
    }),
  },

  'vendor-payments': {
    entity: 'vendor-payments',
    label: 'Vendor payments',
    defaultFileName: 'Vendor_Payment.csv',
    shape: { kind: 'voucher', receiptKind: 'payment' },
    groupBy: ['number'],
    columns: voucherColumns({
      number: ['Payment Number'],
      sourceId: ['VendorPayment ID', 'Payment ID'],
      partySourceId: ['Vendor ID'],
      partyName: ['Vendor Name'],
      ledger: ['Paid Through', 'Paid Through Account'],
      documentNumber: ['Bill Number'],
      appliedAmount: ['Bill Payment Applied Amount'],
    }),
  },
}

/** The definition for an entity. Refuses rather than returning null — see the header. */
export function zohoEntityDefinition(entity: ZohoEntity): ZohoEntityDefinition {
  const definition = ZOHO_ENTITY_DEFINITIONS[entity]
  if (definition === undefined) {
    throw new ImportError(
      'IMPORT_ENTITY_UNKNOWN',
      `Coffer does not know how to read a Zoho ${JSON.stringify(entity)} export.`,
    )
  }
  return definition
}

/**
 * Corrections to the headings above: entity -> target field -> the headings to look under.
 *
 * REPLACES the candidates for that field rather than adding to them. Adding would leave
 * the wrong default in play, and a file that has both the default and the correction would
 * then be reported as ambiguous — which is the opposite of what somebody supplying a
 * correction is asking for.
 */
export type ZohoColumnOverrides = Readonly<
  Partial<Record<ZohoEntity, Readonly<Record<string, readonly string[]>>>>
>

/**
 * The column map for one entity, with the date format settled and any corrections applied.
 *
 * @throws ImportError when a correction names a field the entity does not have, or names
 *   no headings at all. Both are the caller's mistake and both are silent otherwise: a
 *   typo in a field name would simply do nothing, and the user would be told their export
 *   was missing a column they had just supplied the heading for.
 */
export function zohoColumnMap(
  entity: ZohoEntity,
  format: DateFormat,
  overrides: ZohoColumnOverrides = {},
): ColumnMap {
  const definition = zohoEntityDefinition(entity)
  const corrections = overrides[entity] ?? {}
  const map: Record<string, FieldSpec> = {}

  for (const [field, spec] of Object.entries(definition.columns)) {
    map[field] = spec.kind === 'date' ? { ...spec, format } : spec
  }

  for (const [field, columns] of Object.entries(corrections)) {
    const spec = map[field]
    if (spec === undefined) {
      throw new ImportError(
        'IMPORT_SPEC_INVALID',
        `The Zoho ${definition.label} import has no field called ${JSON.stringify(field)}. ` +
          `It has: ${Object.keys(definition.columns).join(', ')}.`,
      )
    }
    if (columns.length === 0) {
      throw new ImportError(
        'IMPORT_SPEC_INVALID',
        `The correction for ${JSON.stringify(field)} names no columns to read from.`,
      )
    }
    map[field] = spec.kind === 'debit-credit' ? spec : { ...spec, columns }
  }

  return map
}

/** The date fields of an entity, so a caller can survey exactly those columns. */
export function zohoDateFields(entity: ZohoEntity): readonly string[] {
  return Object.entries(zohoEntityDefinition(entity).columns)
    .filter((pair): pair is [string, DateFieldSpec] => pair[1].kind === 'date')
    .map(([field]) => field)
}
