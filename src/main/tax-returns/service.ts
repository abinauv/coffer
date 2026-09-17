/*
 * Tax returns, prepared from the books.
 *
 * ---------------------------------------------------------------------------
 *  WHAT THIS SERVICE DOES AND WHAT IT LEAVES TO THE REGIME
 * ---------------------------------------------------------------------------
 *
 * It reads a period's documents out of the open company and hands them to
 * `regime.returns.prepare`. It never names a form, a table or a tax — CONVENTIONS §1.6 —
 * so every word on the result, and every rule about which document goes in which table,
 * is the regime's. What belongs here is the part every regime would need: which documents
 * are in the period, what their place of supply was, and where the file goes.
 *
 * ---------------------------------------------------------------------------
 *  THE PLACE OF SUPPLY IS ASKED AGAIN, THE WAY THE DOCUMENTS SERVICE ASKED IT
 * ---------------------------------------------------------------------------
 *
 * A document stores where the supply was — a jurisdiction and a country — and not the
 * regime's full answer, which also says whether that was inside the supplier's own
 * jurisdiction and whether it left the country. So the regime is asked again with a
 * customer placed where the document says the supply was, exactly as
 * `DocumentsService` asks when a user relocates a supply. No tax is recomputed: the
 * figures on every line are what was stored.
 *
 * ---------------------------------------------------------------------------
 *  "LOOKED AT" IS REMEMBERED IN THE BOOKS, NOT IN THE BROWSER
 * ---------------------------------------------------------------------------
 *
 * The latest period a form was opened for is kept in the company's own metadata. It is
 * about these books — a second machine opening the same file should agree about it — and
 * `storage.ts` forbids company data in localStorage. It only ever moves forward: opening
 * March after August must not make August look unread again.
 */

import { correctsKind, definitionOf, isDocumentKind, type DocumentKind } from '@shared/documents'
import type {
  AsAtDateInput,
  DateString,
  Document,
  ExportTaxReturnResult,
  Party,
  TaxReturn,
  TaxReturnDue,
  TaxReturnInput,
  TaxReturnPeriod,
} from '@shared/dto'

import { OpenBooks, type OpenCompanyHandle } from '../books/open-books'
import { getCompanyProfile } from '../db/repos/company-profile'
import { documentIdsInPeriod, getDocument } from '../db/repos/documents'
import { RepoError } from '../db/repos/errors'
import { getParty } from '../db/repos/parties'
import {
  type PreparedReturn,
  RegimeRefusal,
  type RegimeReturns,
  type ReturnFormDefinition,
  type ReturnSourceDocument,
  type TaxParty,
  type TaxRegime,
} from '../regimes'

/** Where an exported file is written. The Electron half is the save dialog. */
export interface ReturnFileSaver {
  /** Answers the path written, or null when the user cancelled. */
  save(suggestedFileName: string, contents: string): Promise<string | null>
}

/** What the exported file says produced it. */
export interface ExportContext {
  appName: string
  appVersion: string
}

const SEEN_KEY_PREFIX = 'tax_returns.seen.'

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

export class TaxReturnsService {
  private readonly books: OpenBooks

  constructor(
    companies: OpenCompanyHandle,
    private readonly saver: ReturnFileSaver,
    private readonly context: ExportContext,
  ) {
    this.books = new OpenBooks(companies)
  }

  /** One form for one period, as rows. */
  async taxReturn(input: TaxReturnInput): Promise<TaxReturn> {
    const prepared = await this.prepare(input)
    return {
      form: { ...prepared.form },
      period: { ...prepared.period },
      packVersion: prepared.packVersion,
      isProvisional: prepared.isProvisional,
      notice: prepared.notice,
      rows: prepared.rows.map((row) => ({ ...row })),
      total: { ...prepared.total },
      issues: prepared.issues.map((issue) => ({ ...issue })),
    }
  }

  /**
   * The whole prepared return, as a file the user places.
   *
   * THE FILE SAYS WHAT IT IS IN ITS OWN BODY. A JSON file is read long after the screen
   * that produced it has closed, by somebody who may never have seen that screen, so the
   * provisional status and its notice are the first two keys in it — not a filename
   * suffix that a rename removes.
   */
  async exportTaxReturn(input: TaxReturnInput): Promise<ExportTaxReturnResult> {
    const prepared = await this.prepare(input)
    const contents = `${JSON.stringify(fileOf(prepared, this.context), null, 2)}\n`
    return { path: await this.saver.save(fileNameOf(prepared), contents) }
  }

  /** Remember that a form has been looked at up to `to`. Never moves backwards. */
  async markTaxReturnSeen(input: TaxReturnInput): Promise<void> {
    const period = requirePeriod(input)
    const form = requireForm(this.returns(), input.formId)
    const key = `${SEEN_KEY_PREFIX}${form.id}`
    const seen = this.books.readMetadata(key)
    if (seen === null || seen < period.to) this.books.writeMetadata(key, period.to)
  }

  /**
   * Forms for the month before `date` that have documents in them and have not been
   * looked at.
   *
   * THE MONTH MUST HAVE DOCUMENTS. A company opened yesterday has no business being told
   * about last month's returns, and a month with nothing issued in it has nothing on
   * screen worth opening — the list is a prompt to look at work that exists, not a filing
   * calendar.
   */
  async taxReturnsDue(input: AsAtDateInput): Promise<TaxReturnDue[]> {
    const returns = this.books.regime().returns
    if (returns === undefined || returns.forms.length === 0) return []

    const period = previousMonth(input.asAtDate)
    const documentCount = await this.postingDocumentCount(period)
    if (documentCount === 0) return []

    return returns.forms
      .filter((form) => {
        const seen = this.books.readMetadata(`${SEEN_KEY_PREFIX}${form.id}`)
        return seen === null || seen < period.to
      })
      .map((form) => ({ form: { ...form }, period, documentCount }))
  }

  // ---- Reading the books ---------------------------------------------------

  private returns(): RegimeReturns {
    const returns = this.books.regime().returns
    if (returns === undefined) {
      throw new RegimeRefusal(
        'RETURN_FORM_UNKNOWN',
        'The tax rules these books follow do not prepare any returns in Coffer.',
      )
    }
    return returns
  }

  private async prepare(input: TaxReturnInput): Promise<PreparedReturn> {
    const period = requirePeriod(input)
    const returns = this.returns()
    const form = requireForm(returns, input.formId)
    const documents = await this.documentsIn(period)
    return returns.prepare(form.id, { period, documents })
  }

  private async postingDocumentCount(period: TaxReturnPeriod): Promise<number> {
    const db = this.books.db()
    const rows = await documentIdsInPeriod(db, period)
    return rows.filter((row) => postsToLedger(row.kind)).length
  }

  /** Every issued or cancelled document in the period whose kind posts, as a regime reads it. */
  private async documentsIn(period: TaxReturnPeriod): Promise<ReturnSourceDocument[]> {
    const db = this.books.db()
    const regime = this.books.regime()
    const supplier = await this.supplier()

    const parties = new Map<string, Party>()
    const documents: ReturnSourceDocument[] = []

    for (const row of await documentIdsInPeriod(db, period)) {
      if (!postsToLedger(row.kind)) continue
      const document = await getDocument(db, row.id)
      if (document === null) continue
      let party = parties.get(document.partyId)
      if (party === undefined) {
        const found = await getParty(db, document.partyId)
        if (found === null) {
          throw new RepoError(
            'PARTY_NOT_FOUND',
            'A document names a party that is not in these books.',
            {
              partyId: document.partyId,
            },
          )
        }
        party = found
        parties.set(party.id, party)
      }
      documents.push(sourceOf(document, party, supplier, regime))
    }
    return documents
  }

  private async supplier(): Promise<TaxParty> {
    const profile = await getCompanyProfile(this.books.db())
    if (profile === null) {
      throw new RepoError(
        'COMPANY_PROFILE_MISSING',
        'These books do not say who they belong to yet, and a return is filed by somebody. ' +
          'Fill in Business details under Company first.',
      )
    }
    return {
      registrationNumber: profile.registrationNumber,
      jurisdictionCode: profile.jurisdictionCode,
      countryCode: profile.countryCode,
    }
  }
}

export function createTaxReturnsService(
  companies: OpenCompanyHandle,
  saver: ReturnFileSaver,
  context: ExportContext,
): TaxReturnsService {
  return new TaxReturnsService(companies, saver, context)
}

// ---- Small, checkable pieces ---------------------------------------------------

function postsToLedger(kind: string): boolean {
  return isDocumentKind(kind) && definitionOf(kind).postsToLedger
}

function requireForm(returns: RegimeReturns, formId: string): ReturnFormDefinition {
  const form = returns.forms.find((candidate) => candidate.id === formId)
  if (form === undefined) {
    throw new RegimeRefusal(
      'RETURN_FORM_UNKNOWN',
      `There is no return called '${formId}' under the tax rules these books follow.`,
    )
  }
  return form
}

/** The period asked for, with its label. Refused when it ends before it starts. */
export function requirePeriod(input: { from: DateString; to: DateString }): TaxReturnPeriod {
  if (input.from > input.to) {
    throw new RegimeRefusal(
      'RETURN_PERIOD_INVALID',
      `A return period cannot end (${input.to}) before it starts (${input.from}).`,
    )
  }
  return { from: input.from, to: input.to, label: periodLabel(input.from, input.to) }
}

/**
 * 'August 2026' for a whole calendar month, the two dates otherwise.
 *
 * A partial month is named by its dates rather than by the month it falls in: a return
 * labelled 'August 2026' that covered the 1st to the 15th would be believed.
 */
export function periodLabel(from: DateString, to: DateString): string {
  const [year, month, day] = from.split('-').map(Number)
  if (year === undefined || month === undefined || day === undefined) return `${from} to ${to}`
  const monthName = MONTHS[month - 1]
  if (day === 1 && to === lastDayOf(year, month) && monthName !== undefined) {
    return `${monthName} ${year}`
  }
  return `${from} to ${to}`
}

/** The calendar month before the one `date` falls in. */
export function previousMonth(date: DateString): TaxReturnPeriod {
  const [year = 1970, month = 1] = date.split('-').map(Number)
  const previousYear = month === 1 ? year - 1 : year
  const previous = month === 1 ? 12 : month - 1
  const from = `${previousYear}-${pad(previous)}-01`
  const to = lastDayOf(previousYear, previous)
  return { from, to, label: periodLabel(from, to) }
}

function lastDayOf(year: number, month: number): DateString {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${pad(month)}-${pad(days)}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * A stored document, as a regime reads one for a return.
 *
 * The place of supply is the regime's answer for a customer placed where the document
 * says the supply was. Every figure is copied as stored.
 */
export function sourceOf(
  document: Document,
  party: Party,
  supplier: TaxParty,
  regime: TaxRegime,
): ReturnSourceDocument {
  if (!isDocumentKind(document.kind) || document.number === null) {
    throw new RepoError(
      'DOCUMENT_NOT_FOUND',
      'A document in the period has no number or a kind this build does not know.',
      { id: document.id },
    )
  }
  const placeOfSupply = regime.placeOfSupply(supplier, {
    registrationNumber: party.registrationNumber,
    jurisdictionCode: document.placeOfSupplyJurisdiction,
    countryCode: document.placeOfSupplyCountry,
  })
  const original =
    document.originalDocumentId !== null &&
    document.originalDocumentNumber !== null &&
    document.originalDocumentDate !== null
      ? {
          documentId: document.originalDocumentId,
          kind: correctedKindOf(document.kind),
          number: document.originalDocumentNumber,
          date: document.originalDocumentDate,
        }
      : null

  return {
    id: document.id,
    kind: document.kind,
    number: document.number,
    date: document.date,
    isCancelled: document.status === 'cancelled',
    counterparty: {
      partyId: party.id,
      name: party.name,
      registrationNumber: party.registrationNumber,
      jurisdictionCode: party.jurisdictionCode,
      countryCode: party.countryCode,
    },
    placeOfSupply,
    corrects: original,
    exportTaxPayment: document.exportTaxPayment ?? null,
    roundOff: document.totals.roundOff,
    isReverseCharge: document.isReverseCharge ?? false,
    lines: document.lines.map((line) => ({
      lineNumber: line.lineNumber,
      classificationCode: line.classificationCode,
      quantity: line.quantity,
      unitCode: line.unitCode,
      taxableValue: line.taxableAmount,
      ratePct: line.ratePct,
      isCharge: line.isCharge,
      itcEligibility: line.itcEligibility ?? null,
      taxes: line.taxes.map((tax) => ({
        code: tax.code,
        ratePct: tax.ratePct,
        amount: tax.amount,
      })),
    })),
  }
}

/**
 * The kind a correction's original is, off the kind table rather than written here. A
 * kind that corrects nothing never has an original, so the fallback is never reached.
 */
function correctedKindOf(kind: DocumentKind): DocumentKind {
  return correctsKind(kind) ?? kind
}

/** What goes in the exported file. Status first, so nobody has to scroll to find it. */
function fileOf(prepared: PreparedReturn, context: ExportContext): Record<string, unknown> {
  return {
    provisional: prepared.isProvisional,
    notice: prepared.notice,
    form: prepared.form.label,
    period: prepared.period,
    packVersion: prepared.packVersion,
    preparedBy: `${context.appName} ${context.appVersion}`,
    /* Not a portal upload file. The layout is this build's reading of the return, and
     * `provisional` says whether that reading has been checked. */
    return: prepared.artefact,
  }
}

/** '<form id>-2026-08.json' for a month, the two dates otherwise. */
export function fileNameOf(prepared: { form: { id: string }; period: TaxReturnPeriod }): string {
  const { from, to } = prepared.period
  const month = /^(\d{4})-(\d{2})-01$/.exec(from)
  const span =
    month !== null && to === lastDayOf(Number(month[1]), Number(month[2]))
      ? `${month[1]}-${month[2]}`
      : `${from}-to-${to}`
  const stem = prepared.form.id.replace(/[^A-Za-z0-9-]+/g, '-')
  return `${stem}-${span}.json`
}
