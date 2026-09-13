/*
 * The mapper: what the application holds today, turned into what a page needs.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE HALF THAT CHANGES, WHICH IS WHY IT IS A SEPARATE FILE
 *
 * `invoice-template.ts` takes an `InvoicePrintModel` and knows nothing about `Document`,
 * `CompanyProfile` or `RegimeDescription`. Everything that is true of the shapes we
 * happen to store today lives here — including the four things a printed invoice needs
 * and `company_profile` (migration 0011) does not yet hold. When that migration lands,
 * this file reads the new columns and the template is untouched.
 *
 * ---------------------------------------------------------------------------
 * WHY `amountInWords` ARRIVES AS A FUNCTION AND NOT OFF THE REGIME DESCRIPTION
 *
 * Because `RegimeDescription` deliberately has nothing executable on it. `regime/service.ts`
 * drops every method on `TaxRegime` and there is a test asserting the description is not
 * the regime with a few fields renamed — the renderer must have no way at all to work out
 * a tax. The words on the foot of an invoice are the regime's own sentence
 * (`TaxRegime.amountInWords`), so the only way to have them without putting a method on a
 * DTO is for the caller — which is in main and does hold the regime — to pass one in.
 *
 * The alternative was to take the whole `TaxRegime` here. That would work and it would
 * make this module impossible to test against anything but the bundled adapter, which is
 * precisely how "the mapping reaches for India instead of for its argument" gets shipped.
 *
 * ---------------------------------------------------------------------------
 * THE SIDE OF THE TRADE DECIDES WHICH BOX IS WHICH, AND IT IS A TABLE
 *
 * On a sales invoice the company supplies and the party receives; on a purchase bill it
 * is the other way round. CONVENTIONS §1.9 — a choice over a closed union is a total
 * record, never a conditional — so `ENDS_ON` answers it, and a third side of the trade
 * would fail to compile rather than silently getting whatever the last branch said.
 *
 * ---------------------------------------------------------------------------
 * THE ARITHMETIC THAT IS HERE, AND WHY IT IS NOT IN THE TEMPLATE
 *
 * The two summary tables are folds over the lines: taxable value and tax per rate slab,
 * and the same again per classification code. That is money arithmetic, it runs on
 * `Decimal` from `domain/money`, and it belongs on this side of the seam — the template
 * adds nothing to anything, which is the property its tests can actually prove.
 *
 * It arguably belongs further down still, in `domain/documents`, because GSTR-1's tables
 * 6 and 12 want exactly these two folds and a return is not a document. That is a batch
 * with a caller; this one has the fold and no home for it yet. See the report.
 */

import {
  D,
  ZERO,
  compare,
  parseMoney,
  parseQuantity,
  parseRate,
  toMoneyString,
  toQuantityString,
  toRateString,
  type Decimal,
} from '@main/domain/money'
import {
  correctsKind,
  definitionOf,
  isDocumentKind,
  type DocumentKind,
  type TradeSide,
} from '@shared/documents'
import type {
  CompanyProfile,
  DecimalString,
  Document,
  DocumentLineDto,
  DocumentLineTaxDto,
  Party,
  RegimeDescription,
} from '@shared/dto'

import { PrintError } from './errors'
import type {
  InvoicePrintModel,
  PrintCorrectedDocument,
  PrintHsnRow,
  PrintLine,
  PrintParty,
  PrintRateSlab,
  PrintTax,
  PrintTaxColumn,
} from './model'

// ---- What the caller supplies ------------------------------------------------

/**
 * Everything the mapper reads. Four records and one function.
 *
 * `party` IS HERE BECAUSE `Document` DOES NOT CARRY ONE. It has `partyId` and
 * `partyName` — enough for a register, nothing like enough for the box on an invoice
 * that has to state the recipient's registration number and their state. Whoever builds
 * this model fetches the party; see the report.
 */
export interface InvoicePrintSources {
  document: Document
  /** Null until somebody has entered one, which is a refusal rather than a blank box. */
  company: CompanyProfile | null
  /** The document's own party — the customer on a sale, the vendor on a purchase. */
  party: Party | null
  regime: RegimeDescription
  /**
   * The grand total in the regime's words. `TaxRegime.amountInWords`, curried.
   *
   * Required, and deliberately not defaulted. An invoice whose words disagree with its
   * numerals is disputed rather than paid, so there is no sensible fallback — a caller
   * with no regime to ask should fail to compile rather than print a total in English
   * that the books were never kept in.
   */
  amountInWords: (amount: DecimalString) => string
  /**
   * The logo, the bank details, the terms, the declaration and the signatory.
   *
   * ABSENT TODAY, ALWAYS. Nothing in `company_profile` holds any of it (migration 0011
   * is identity and its own header argues that a preference does not go in it), so every
   * caller in this build passes nothing and every one of these blocks stays off the page.
   * The parameter exists so that the batch which adds the storage changes this file and
   * this file only.
   */
  branding?: InvoiceBranding
}

/** The group of fields that awaits a migration. See `InvoicePrintSources.branding`. */
export interface InvoiceBranding {
  logo?: InvoicePrintModel['logo']
  bank?: InvoicePrintModel['bank']
  terms?: InvoicePrintModel['terms']
  declaration?: InvoicePrintModel['declaration']
  signatory?: Omit<NonNullable<InvoicePrintModel['signatory']>, 'forLine'>
}

// ---- Small rules -------------------------------------------------------------

/**
 * Which end of the supply each party is, by side of the trade.
 *
 * A total record over `TradeSide`, per CONVENTIONS §1.9. The two are genuinely opposite:
 * a purchase bill printed from these books is the vendor's document, so the vendor heads
 * the supplier box and this company is the recipient.
 */
interface SupplyEnds {
  supplier: PrintParty
  customer: PrintParty
}

const ENDS_ON: Readonly<Record<TradeSide, (company: PrintParty, party: PrintParty) => SupplyEnds>> =
  {
    sales: (company, party) => ({ supplier: company, customer: party }),
    purchase: (company, party) => ({ supplier: party, customer: company }),
  }

/**
 * What the party's own number for this document is called ON THE PAGE.
 *
 * Different words from `partyReferenceLabel` in `screens/lib/document-view.ts`, and the
 * difference is who is being addressed: the editor talks to the user, so a customer's
 * purchase order is "their reference"; the printed invoice is handed to that customer, to
 * whom it is "your reference". The purchase side reads the same either way because a
 * vendor's invoice number is what a GSTR-2B reconciliation matches on and the phrase has
 * to say so.
 */
const REFERENCE_LABELS: Readonly<Record<TradeSide, string>> = {
  sales: 'Your reference',
  purchase: 'Their invoice no.',
}

/*
 * `isDocumentKind` is `@shared/documents`'s. `Document.kind` is a string on the wire, and
 * a cast would let a kind written by a newer build reach `definitionOf` — which throws a
 * message about the file needing a newer Coffer, correctly, but from three frames deeper
 * and without saying which document.
 */

/*
 * Code-point order, not locale order. A summary rendered on one machine and read on
 * another must be in the same order on both, and `localeCompare` is a function of which
 * machine ran it.
 */
function compareText(a: string, b: string): -1 | 0 | 1 {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function textOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** Address, city and postcode with the blanks closed up. See the model's header. */
function addressLines(parts: readonly (string | null)[]): readonly string[] {
  const kept: string[] = []
  for (const part of parts) {
    const text = textOrNull(part)
    if (text !== null) kept.push(text)
  }
  return kept
}

function cityLine(city: string | null, postalCode: string | null): string | null {
  return textOrNull([textOrNull(city), textOrNull(postalCode)].filter((x) => x !== null).join(' '))
}

/**
 * The regime's name for a jurisdiction code: 'Tamil Nadu (33)'.
 *
 * A code the regime does not list still prints — as the bare code, because a company file
 * carrying a state this build's pack has not heard of is a real situation and dropping the
 * place of supply off the face of a tax invoice is not an acceptable response to it.
 */
function jurisdictionLabel(code: string | null, regime: RegimeDescription): string | null {
  const trimmed = textOrNull(code)
  if (trimmed === null) return null
  const named = regime.jurisdictions.filter((option) => option.code === trimmed)
  const [only, ...rest] = named
  if (only === undefined || rest.length > 0) return trimmed
  return `${only.name} (${only.code})`
}

// ---- The two ends ------------------------------------------------------------

function companyParty(company: CompanyProfile, regime: RegimeDescription): PrintParty {
  const trade = textOrNull(company.tradeName)
  const legal = company.legalName.trim()
  return {
    /* The name it trades under heads the box, because that is the name the customer
     * recognises. The registered name goes underneath when the two differ — a tax invoice
     * has to carry it, and printing it twice reads as a mistake. */
    name: trade ?? legal,
    legalName: trade === null ? null : legal,
    addressLines: addressLines([
      company.addressLine1,
      company.addressLine2,
      cityLine(company.city, company.postalCode),
    ]),
    registrationNumber: textOrNull(company.registrationNumber),
    jurisdiction: jurisdictionLabel(company.jurisdictionCode, regime),
    email: textOrNull(company.email),
    phone: textOrNull(company.phone),
  }
}

function tradingParty(party: Party, regime: RegimeDescription): PrintParty {
  const legal = textOrNull(party.legalName)
  const name = party.name.trim()
  return {
    name,
    legalName: legal === null || legal === name ? null : legal,
    addressLines: addressLines([
      party.addressLine1,
      party.addressLine2,
      cityLine(party.city, party.postalCode),
    ]),
    registrationNumber: textOrNull(party.registrationNumber),
    jurisdiction: jurisdictionLabel(party.jurisdictionCode, regime),
    email: textOrNull(party.email),
    phone: textOrNull(party.phone),
  }
}

// ---- The tax columns ---------------------------------------------------------

/**
 * Which pairs of tax columns the line table has, and in which order.
 *
 * THE ORDER IS THE REGIME'S, NOT THE DOCUMENT'S. `taxComponents` is documented as being
 * "in the order a return lists them", so CGST sits left of SGST because the Act puts it
 * there — not because whichever line happened to be first built its array that way. A
 * document ordered the other way round is exactly what the fixture does, so the test can
 * tell the two apart.
 *
 * A component the regime has not declared still gets a column, appended after the known
 * ones. That is a company file written under a newer compliance pack, and a figure with
 * no column would be tax charged and not shown.
 */
export function taxColumnsFor(
  lines: readonly DocumentLineDto[],
  regime: RegimeDescription,
): readonly PrintTaxColumn[] {
  const present = new Set<string>()
  for (const line of lines) {
    for (const tax of line.taxes) present.add(tax.code)
  }

  const columns: PrintTaxColumn[] = []
  const take = (code: string): void => {
    if (!present.has(code)) return
    present.delete(code)
    /* The CODE is the heading, not `TaxComponentOption.label`: that field is what the
     * chart of accounts calls the component ('Central GST'), which is the right words for
     * an account name and three times too wide for a column on A4. */
    columns.push({ code, label: code })
  }

  for (const component of regime.taxComponents) take(component.code)
  for (const line of lines) {
    for (const tax of line.taxes) take(tax.code)
  }
  return columns
}

// ---- The folds ---------------------------------------------------------------

/*
 * NUL, which cannot occur in a classification code, a rate or a unit code — so no two
 * different keys can collide by running into each other. Not decoration: 'A1' at 8% and
 * 'A' at 18% both concatenate to 'A18.000', which would silently become one summary row
 * carrying two rates. A test builds that pair, and the mutation that joins with '' dies.
 */
const KEY_SEPARATOR = '\u0000'

interface Bucket {
  ratePct: DecimalString
  classificationCode: string | null
  unitCode: string | null
  quantity: Decimal
  taxableValue: Decimal
  taxes: Map<string, { label: string; ratePct: DecimalString; amount: Decimal }>
}

function emptyBucket(line: DocumentLineDto, ratePct: DecimalString): Bucket {
  return {
    ratePct,
    classificationCode: textOrNull(line.classificationCode),
    unitCode: textOrNull(line.unitCode),
    quantity: ZERO,
    taxableValue: ZERO,
    taxes: new Map(),
  }
}

function absorb(bucket: Bucket, line: DocumentLineDto): void {
  bucket.quantity = bucket.quantity.plus(parseQuantity(line.quantity, 'line quantity'))
  bucket.taxableValue = bucket.taxableValue.plus(
    parseMoney(line.taxableAmount, 'line taxable amount'),
  )
  for (const tax of line.taxes) {
    const running = bucket.taxes.get(tax.code)
    bucket.taxes.set(tax.code, {
      /* The wording is the regime's and every line in one bucket carries the same one,
       * because a bucket is one component at one rate. The first is kept rather than the
       * last only so that the choice is stated; they do not differ. */
      label: running?.label ?? tax.label,
      ratePct: running?.ratePct ?? tax.ratePct,
      amount: (running?.amount ?? ZERO).plus(parseMoney(tax.amount, 'line tax amount')),
    })
  }
}

/**
 * A bucket's components, in the order the tax COLUMNS are in.
 *
 * NOT IN THE ORDER THE LINES HAPPENED TO LIST THEM. A map keyed by code preserves
 * insertion order, so without this a slab's components would come out in whatever order
 * the first line of that slab was built in — SGST before CGST, if one line's array was
 * assembled the other way round. The rendered table looks the same either way, because
 * the template looks a cell up by code rather than by position, which is exactly what
 * makes the wrong order invisible until somebody reads the model.
 *
 * A code the order does not mention keeps its insertion position at the end, which is the
 * same rule `taxColumnsFor` follows for a component the regime never declared.
 */
function bucketTaxes(
  bucket: Bucket,
  componentOrder: readonly string[],
): { taxes: readonly PrintTax[]; totalTax: DecimalString } {
  let total = ZERO
  const taxes: PrintTax[] = []
  for (const [code, running] of bucket.taxes) {
    total = total.plus(running.amount)
    taxes.push({
      code,
      label: running.label,
      ratePct: running.ratePct,
      amount: toMoneyString(running.amount),
    })
  }

  const rank = (code: string): number => {
    const index = componentOrder.indexOf(code)
    return index === -1 ? componentOrder.length : index
  }
  const ordered = taxes
    .map((tax, index) => ({ tax, index }))
    .sort((a, b) => rank(a.tax.code) - rank(b.tax.code) || a.index - b.index)
    .map((entry) => entry.tax)

  return { taxes: ordered, totalTax: toMoneyString(total) }
}

/** The rate as the key and as it prints, normalised so '18' and '18.0' are one slab. */
function slabRate(line: DocumentLineDto): DecimalString {
  return toRateString(parseRate(line.ratePct, 'line tax rate'))
}

/**
 * Taxable value and tax, per rate slab, ascending.
 *
 * ASCENDING BY RATE AND NOT BY FIRST APPEARANCE. A reader checking an invoice reads the
 * slabs in order, and a fixture whose lines are 18%, then 5%, then 12% is what tells a
 * sorted summary from an unsorted one — CONVENTIONS §6 on ordering fixtures so they
 * disagree with the expected output.
 */
export function rateSummaryOf(
  lines: readonly DocumentLineDto[],
  componentOrder: readonly string[] = [],
): readonly PrintRateSlab[] {
  const buckets = new Map<string, Bucket>()
  for (const line of lines) {
    const rate = slabRate(line)
    const bucket = buckets.get(rate) ?? emptyBucket(line, rate)
    buckets.set(rate, bucket)
    absorb(bucket, line)
  }

  return [...buckets.values()]
    .sort((a, b) => compare(D(a.ratePct), D(b.ratePct)))
    .map((bucket) => {
      const { taxes, totalTax } = bucketTaxes(bucket, componentOrder)
      return {
        ratePct: bucket.ratePct,
        taxableValue: toMoneyString(bucket.taxableValue),
        taxes,
        totalTax,
      }
    })
}

/**
 * The same fold, keyed by classification code — table 12 of GSTR-1 in miniature.
 *
 * THE UNIT IS PART OF THE KEY. A total quantity across two units is not a quantity: ten
 * metres and two boxes do not make twelve of anything. So an HSN sold in two units is two
 * rows, which is honest, rather than one row with a figure nobody can act on.
 *
 * The rate is in the key too, because the tax columns on the row have to mean something:
 * one row covering 12% and 18% supplies would carry a CGST figure at no rate at all.
 */
export function hsnSummaryOf(
  lines: readonly DocumentLineDto[],
  componentOrder: readonly string[] = [],
): readonly PrintHsnRow[] {
  const buckets = new Map<string, Bucket>()
  for (const line of lines) {
    const rate = slabRate(line)
    const key = [
      textOrNull(line.classificationCode) ?? '',
      rate,
      textOrNull(line.unitCode) ?? '',
    ].join(KEY_SEPARATOR)
    const bucket = buckets.get(key) ?? emptyBucket(line, rate)
    buckets.set(key, bucket)
    absorb(bucket, line)
  }

  return [...buckets.values()]
    .sort((a, b) => {
      /* A line with no classification code sorts last, whichever way the codes compare —
       * it is the row a reader checks after the ones that are classified, not before. */
      if (a.classificationCode === null && b.classificationCode !== null) return 1
      if (a.classificationCode !== null && b.classificationCode === null) return -1
      if (a.classificationCode !== null && b.classificationCode !== null) {
        const byCode = compareText(a.classificationCode, b.classificationCode)
        if (byCode !== 0) return byCode
      }
      const byRate = compare(D(a.ratePct), D(b.ratePct))
      if (byRate !== 0) return byRate
      return compareText(a.unitCode ?? '', b.unitCode ?? '')
    })
    .map((bucket) => {
      const { taxes, totalTax } = bucketTaxes(bucket, componentOrder)
      return {
        classificationCode: bucket.classificationCode,
        ratePct: bucket.ratePct,
        quantity: toQuantityString(bucket.quantity),
        unitCode: bucket.unitCode,
        taxableValue: toMoneyString(bucket.taxableValue),
        taxes,
        totalTax,
      }
    })
}

// ---- The mapping ------------------------------------------------------------

function printLine(line: DocumentLineDto): PrintLine {
  return {
    lineNumber: line.lineNumber,
    description: line.description,
    classificationCode: textOrNull(line.classificationCode),
    quantity: line.quantity,
    unitCode: textOrNull(line.unitCode),
    unitPrice: line.unitPrice,
    discount: line.discount,
    taxableAmount: line.taxableAmount,
    ratePct: line.ratePct,
    isCharge: line.isCharge,
    taxes: line.taxes.map(printTax),
  }
}

function printTax(tax: DocumentLineTaxDto): PrintTax {
  return { code: tax.code, label: tax.label, ratePct: tax.ratePct, amount: tax.amount }
}

/**
 * The invoice a credit note corrects, as it must be named on its face.
 *
 * THE LABEL IS DERIVED AND NOT CARRIED. `correctsKind` says which kind this kind may
 * correct, and the kind table says what that is called — so the block reads "Against
 * sales invoice" on a credit note and "Against purchase bill" on a debit note without a
 * word being written here. It is the same argument the heading makes: no batch can put
 * the wrong noun on a document by typing it into a string.
 *
 * `undefined` ON A KIND THAT CORRECTS NOTHING, and on a correction whose original has no
 * number yet — an original in draft has none, and a block reading "Against sales invoice
 * — · 04 Nov 2027" is worse than no block. The two nulls are checked together because
 * both halves are the legal reference and half of one is not a reference.
 */
function correctedDocument(
  document: Document,
  kind: DocumentKind,
): PrintCorrectedDocument | undefined {
  const corrected = correctsKind(kind)
  const number = document.originalDocumentNumber
  const date = document.originalDocumentDate
  if (corrected === null || number === null || date === null) return undefined
  return { label: definitionOf(corrected).label, number, date }
}

/**
 * A document, a profile and a regime, as a page.
 *
 * @throws PrintError `DOCUMENT_KIND_UNKNOWN`, `COMPANY_PROFILE_MISSING`, `PARTY_MISSING`
 */
export function buildInvoicePrintModel(sources: InvoicePrintSources): InvoicePrintModel {
  const { document, company, party, regime, amountInWords, branding } = sources

  if (!isDocumentKind(document.kind)) {
    throw new PrintError(
      'DOCUMENT_KIND_UNKNOWN',
      `This build does not know a document of kind '${document.kind}', so it cannot say ` +
        'what to head the page with. The company file may need a newer Coffer.',
    )
  }
  if (company === null) {
    throw new PrintError(
      'COMPANY_PROFILE_MISSING',
      'These books do not say who they belong to yet, and an invoice has to name its ' +
        'supplier. Fill in the company profile and print again.',
    )
  }
  if (party === null) {
    throw new PrintError(
      'PARTY_MISSING',
      `The ${document.partyName} record could not be read, and a tax invoice has to ` +
        'carry the other side of the supply. Reopen the document and try again.',
    )
  }

  const definition = definitionOf(document.kind)
  const ends = ENDS_ON[definition.side](companyParty(company, regime), tradingParty(party, regime))

  /* Sorted here rather than trusted, and the mapper's test hands it lines out of order.
   * The repository returns them by line number today; a print that silently reordered
   * itself if that ever changed would be discovered by a customer, not by us. */
  const lines = [...document.lines].sort((a, b) => a.lineNumber - b.lineNumber)

  /* One list, used three times: the columns the table draws and the order the two
   * summaries put their components in. Derived once so they cannot disagree. */
  const taxColumns = taxColumnsFor(lines, regime)
  const componentOrder = taxColumns.map((column) => column.code)

  const reference = textOrNull(document.partyReference)

  return {
    kind: document.kind,
    status: document.status,
    number: document.number,
    date: document.date,
    dueDate: document.dueDate,
    reference:
      reference === null ? null : { label: REFERENCE_LABELS[definition.side], value: reference },
    placeOfSupply:
      jurisdictionLabel(document.placeOfSupplyJurisdiction, regime) ??
      textOrNull(document.placeOfSupplyCountry)?.toUpperCase() ??
      null,
    narration: textOrNull(document.narration),
    corrects: correctedDocument(document, document.kind),

    supplier: ends.supplier,
    customer: ends.customer,
    registrationLabel: regime.registrationLabel,
    classificationLabel: regime.classification.label,

    taxColumns,
    lines: lines.map(printLine),
    rateSummary: rateSummaryOf(lines, componentOrder),
    hsnSummary: hsnSummaryOf(lines, componentOrder),

    totals: {
      taxableValue: document.totals.taxableValue,
      totalDiscount: document.totals.totalDiscount,
      totalTax: document.totals.totalTax,
      netTotal: document.totals.netTotal,
      roundOff: document.totals.roundOff,
      grandTotal: document.totals.grandTotal,
      taxes: document.totals.taxSummary.map(printTax),
      grandTotalInWords: amountInWords(document.totals.grandTotal),
    },

    numberFormat: regime.numberFormat,

    logo: branding?.logo,
    bank: branding?.bank,
    terms: branding?.terms,
    declaration: branding?.declaration,
    /* Signed for whoever the supplier is, which on a purchase bill is not this company.
     * Assembled here so the block cannot end up signed for a company the document is
     * not from. */
    signatory:
      branding?.signatory === undefined
        ? undefined
        : { ...branding.signatory, forLine: `For ${ends.supplier.name}` },
  }
}
