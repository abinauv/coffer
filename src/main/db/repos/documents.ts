/*
 * The documents repository — drafts.
 *
 * Read migration 0008 first, and the four rules at the top of domain/documents/types.ts
 * that it enforces. This file covers the draft side of a document's life: creating one,
 * editing it, throwing it away and reading it back. Issuing and cancelling are the next
 * batch, because they are one transaction spanning the numbering counter, the posting
 * rule and the ledger, and none of that belongs in the middle of draft handling.
 *
 * ---------------------------------------------------------------------------
 * NOTHING DERIVABLE IS STORED, SO EVERY READ COMPUTES
 *
 * There is no `grand_total` column. `documentTotals` runs on the way out, over the same
 * lines the posting rule will fold, so what a screen shows and what hits the ledger are
 * the same arithmetic run twice rather than two figures maintained in step. That is what
 * makes a document whose printed total differs from its journal entry impossible rather
 * than merely unlikely.
 *
 * The cost is real and worth stating: listing a register totals every document in it. A
 * page of a hundred invoices is a hundred folds over their lines, which is nothing at
 * this scale and would need rethinking at a scale this product is not for.
 *
 * ---------------------------------------------------------------------------
 * LINES ARE REPLACED, NEVER PATCHED
 *
 * `updateDraft` with `lines` deletes every line and writes the set it was given. The grid
 * the user is looking at IS the document, so a per-line patch protocol would be a second
 * way to say the same thing with its own ordering and identity bugs — and line ids would
 * then have to be stable across an edit that reorders rows, which the user experiences as
 * dragging one line above another.
 *
 * The line ids therefore change on every edit. Nothing outside a draft may hold one:
 * `document_line_taxes` cascades, and no other table references a line.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT DO
 *
 * It does not compute tax. `taxableAmount` and the component amounts arrive from the
 * caller, because they are the regime's answer as of the document's own date and the
 * service layer is what has just asked the regime — `db/` may not name a concrete regime
 * (CONVENTIONS §1.6). What it DOES do is refuse a taxable amount that disagrees with the
 * line's own quantity, price and discount, because that is arithmetic rather than tax
 * policy, and a figure the invoice does not show is a figure nobody can check.
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'

import {
  D,
  parseMoney,
  parseQuantity,
  parseRate,
  toMoneyString,
  toQuantityString,
  toRateString,
} from '@main/domain/money'
import { documentTotals, type DocumentLine } from '@main/domain/documents'
import type {
  CreateDocumentInput,
  Document,
  DocumentLineDto,
  DocumentLineInput,
  DocumentLineTaxDto,
  DocumentStatusDto,
  DocumentSummary,
  DocumentTotalsDto,
  ListDocumentsInput,
  UpdateDocumentInput,
} from '@shared/dto'

import type { CofferDb } from '../kysely'
import { RepoError, repoErrorFrom } from './errors'
import { assertPartiesActive } from './parties'

/**
 * A page nobody asks for by accident, and small enough to bound the totalling above.
 *
 * Exported so a test can cross it. A ceiling can only be tested by exceeding it, and a
 * test that asks for ten thousand rows out of six passes whether the clamp exists or not.
 */
export const MAX_DOCUMENT_PAGE = 500

// ---- Reading ---------------------------------------------------------------

/**
 * Documents in a register, newest first.
 *
 * Ordered by date and then by number, not by when the row was written. A register is read
 * as a sequence of documents and the sequence is the one printed on them — an invoice
 * back-dated into last month belongs where its date says, not at the end.
 */
export async function listDocuments(
  db: CofferDb,
  input: ListDocumentsInput = {},
): Promise<DocumentSummary[]> {
  let query = db
    .selectFrom('documents')
    .innerJoin('parties', 'parties.id', 'documents.party_id')
    .select([
      'documents.id as id',
      'documents.kind as kind',
      'documents.status as status',
      'documents.number as number',
      'documents.document_date as document_date',
      'documents.party_id as party_id',
      'documents.rounding_policy as rounding_policy',
      'parties.name as party_name',
    ])

  if (input.kind !== undefined) query = query.where('documents.kind', '=', input.kind)
  if (input.status !== undefined) query = query.where('documents.status', '=', input.status)
  if (input.partyId !== undefined) query = query.where('documents.party_id', '=', input.partyId)
  if (input.fromDate !== undefined) {
    query = query.where('documents.document_date', '>=', input.fromDate)
  }
  if (input.toDate !== undefined) {
    query = query.where('documents.document_date', '<=', input.toDate)
  }

  /* The blank guard is not a rule: the term is built from `.trim()`, so an all-space
   * search would become '%%' and match everything anyway. It saves three LIKEs. */
  if (input.search !== undefined && input.search.trim() !== '') {
    const term = `%${input.search.trim()}%`
    query = query.where((eb) =>
      eb.or([
        eb(sql<string>`COALESCE(documents.number, '') COLLATE NOCASE`, 'like', term),
        eb(sql<string>`parties.name COLLATE NOCASE`, 'like', term),
        eb(sql<string>`documents.narration COLLATE NOCASE`, 'like', term),
      ]),
    )
  }

  const rows = await query
    .orderBy('documents.document_date', 'desc')
    .orderBy('documents.number', 'desc')
    .orderBy('documents.created_at', 'desc')
    .limit(Math.min(input.limit ?? MAX_DOCUMENT_PAGE, MAX_DOCUMENT_PAGE))
    .offset(input.offset ?? 0)
    .execute()

  /* One query for every line of every document on the page, rather than one per document.
   * The totals still have to be folded per document, but the reading is not N+1. */
  const linesByDocument = await linesFor(
    db,
    rows.map((row) => row.id),
  )

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status as DocumentStatusDto,
    number: row.number,
    date: row.document_date,
    partyId: row.party_id,
    partyName: row.party_name,
    /* Folded per document, because there is no stored total to read instead. The
     * rounding policy is the document's own, so two invoices on one page may round
     * differently and each is right. */
    grandTotal: totalsFor(
      linesByDocument.get(row.id) ?? [],
      row.rounding_policy as 'whole-unit' | 'none',
    ).grandTotal,
  }))
}

/** One document, with its lines and everything they add up to. */
export async function getDocument(db: CofferDb, id: string): Promise<Document | null> {
  const row = await db
    .selectFrom('documents')
    .innerJoin('parties', 'parties.id', 'documents.party_id')
    .selectAll('documents')
    .select('parties.name as party_name')
    .where('documents.id', '=', id)
    .executeTakeFirst()
  if (row === undefined) return null

  const lines = (await linesFor(db, [id])).get(id) ?? []
  const roundingPolicy = row.rounding_policy as 'whole-unit' | 'none'
  const totals = totalsFor(lines, roundingPolicy)

  return {
    id: row.id,
    kind: row.kind,
    status: row.status as DocumentStatusDto,
    number: row.number,
    date: row.document_date,
    partyId: row.party_id,
    partyName: row.party_name,
    seriesId: row.series_id,
    partyReference: row.party_reference,
    placeOfSupplyJurisdiction: row.place_of_supply_jurisdiction,
    placeOfSupplyCountry: row.place_of_supply_country,
    roundingPolicy,
    narration: row.narration,
    entryId: row.entry_id,
    lines,
    totals,
    grandTotal: totals.grandTotal,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    issuedAt: row.issued_at,
    cancelledAt: row.cancelled_at,
  }
}

// ---- Writing ---------------------------------------------------------------

/**
 * A new draft.
 *
 * Created with no number, no entry and whatever lines it was given — which may be none.
 * A draft is made empty and filled in, and a rule refusing an empty one would refuse the
 * first thing every user does (see the closing note in 0008).
 */
export async function createDocument(
  db: CofferDb,
  input: CreateDocumentInput,
  now: string,
): Promise<Document> {
  const id = randomUUID()
  const lines = normaliseLines(input.lines ?? [])

  await assertPartiesActive(db, [input.partyId])

  await db
    .transaction()
    .execute(async (trx) => {
      await trx
        .insertInto('documents')
        .values({
          id,
          kind: input.kind,
          status: 'draft',
          number: null,
          series_id: null,
          document_date: input.date,
          party_id: input.partyId,
          party_reference: trimmedOrNull(input.partyReference),
          place_of_supply_jurisdiction: trimmedOrNull(input.placeOfSupplyJurisdiction),
          place_of_supply_country: input.placeOfSupplyCountry.trim().toLowerCase(),
          rounding_policy: input.roundingPolicy ?? 'none',
          narration: (input.narration ?? '').trim(),
          entry_id: null,
          created_at: now,
          updated_at: now,
          issued_at: null,
          cancelled_at: null,
        })
        .execute()

      await writeLines(trx, id, lines)
    })
    .catch((error: unknown) => {
      throw repoErrorFrom(error, 'INVALID_LINE_AMOUNT')
    })

  return (await getDocument(db, id))!
}

/**
 * Change a draft.
 *
 * Absent means "leave it"; `null` clears the fields that may be cleared. `lines`, when
 * present, replaces the whole set — see the header.
 */
export async function updateDocument(
  db: CofferDb,
  input: UpdateDocumentInput,
  now: string,
): Promise<Document> {
  const existing = await requireDocument(db, input.id)
  assertDraft(existing)

  if (input.partyId !== undefined) {
    await assertPartiesActive(db, [input.partyId])
  }
  const lines = input.lines === undefined ? null : normaliseLines(input.lines)

  await db
    .transaction()
    .execute(async (trx) => {
      const update: Record<string, unknown> = { updated_at: now }
      if (input.date !== undefined) update['document_date'] = input.date
      if (input.partyId !== undefined) update['party_id'] = input.partyId
      if (input.partyReference !== undefined) {
        update['party_reference'] = trimmedOrNull(input.partyReference)
      }
      if (input.placeOfSupplyJurisdiction !== undefined) {
        update['place_of_supply_jurisdiction'] = trimmedOrNull(input.placeOfSupplyJurisdiction)
      }
      if (input.placeOfSupplyCountry !== undefined) {
        update['place_of_supply_country'] = input.placeOfSupplyCountry.trim().toLowerCase()
      }
      if (input.roundingPolicy !== undefined) update['rounding_policy'] = input.roundingPolicy
      if (input.narration !== undefined) update['narration'] = input.narration.trim()

      await trx.updateTable('documents').set(update).where('id', '=', input.id).execute()

      if (lines !== null) {
        /* The taxes go with them: `document_line_taxes` cascades from the line. */
        await trx.deleteFrom('document_lines').where('document_id', '=', input.id).execute()
        await writeLines(trx, input.id, lines)
      }
    })
    .catch((error: unknown) => {
      throw repoErrorFrom(error, 'INVALID_LINE_AMOUNT')
    })

  return (await getDocument(db, input.id))!
}

/**
 * Throw a draft away.
 *
 * Only a draft. An issued document is cancelled, which keeps its number, and 0008's
 * trigger refuses the delete outright rather than trusting this check — the cascade to
 * its lines would otherwise be a way to silently unpick a posted invoice.
 */
export async function deleteDocument(db: CofferDb, id: string): Promise<void> {
  const existing = await requireDocument(db, id)
  assertDraft(existing)

  await db.deleteFrom('documents').where('id', '=', id).execute()
}

// ---- Internals -------------------------------------------------------------

interface DocumentRow {
  id: string
  status: string
  number: string | null
}

async function requireDocument(db: CofferDb, id: string): Promise<DocumentRow> {
  const row = await db
    .selectFrom('documents')
    .select(['id', 'status', 'number'])
    .where('id', '=', id)
    .executeTakeFirst()
  if (row === undefined) {
    throw new RepoError('DOCUMENT_NOT_FOUND', 'That document is not in these books.', { id })
  }
  return row
}

function assertDraft(row: DocumentRow): void {
  if (row.status === 'draft') return
  throw new RepoError(
    'DOCUMENT_NOT_DRAFT',
    row.status === 'cancelled'
      ? `${row.number ?? 'That document'} has been cancelled, and a cancelled document is a record rather than a thing to edit.`
      : `${row.number ?? 'That document'} has been issued. Correct it with a credit note — the customer holds a copy of it.`,
    { id: row.id, status: row.status },
  )
}

/** A line with every figure normalised and checked. */
interface NormalisedLine {
  lineNumber: number
  input: DocumentLineInput
  quantity: string
  unitPrice: string
  discount: string
  taxableAmount: string
  ratePct: string
  taxes: readonly DocumentLineTaxDto[]
}

/**
 * Number the lines, normalise every figure, and refuse the ones that do not add up.
 *
 * Line numbers are assigned here from the order the caller sent rather than taken from
 * the input. The order on the screen IS the order, and letting a caller supply its own
 * numbering would admit a document with two line 3s and no line 2 — which the unique
 * index would catch, but with an error about a constraint rather than about the invoice.
 */
function normaliseLines(lines: readonly DocumentLineInput[]): NormalisedLine[] {
  return lines.map((input, index) => {
    const lineNumber = index + 1
    const at = (field: string) => `Line ${String(lineNumber)}: ${field}`

    const quantity = figureAt('quantity', input.quantity, at('quantity'))
    const unitPrice = figureAt('money', input.unitPrice, at('price'))
    const discount = figureAt('money', input.discount ?? '0.00', at('discount'))
    const taxableAmount = figureAt('money', input.taxableAmount, at('amount'))
    const ratePct = figureAt('rate', input.ratePct ?? '0.000', at('rate'))

    if (input.description.trim() === '') {
      throw new RepoError(
        'INVALID_LINE_AMOUNT',
        `${at('description')} is empty. A line has to say what it is for — it is what prints.`,
        { lineNumber },
      )
    }

    /*
     * The arithmetic, checked rather than trusted. This is not tax policy — it is
     * `quantity x price - discount`, and a taxable amount that disagrees with it is a
     * figure the invoice does not show and nobody can check. The caller computed it
     * because the caller asked the regime; this is what stops a bug there reaching the
     * books silently.
     */
    const expected = D(quantity).times(D(unitPrice)).minus(D(discount))
    if (!D(taxableAmount).equals(expected)) {
      throw new RepoError(
        'LINE_TOTAL_MISMATCH',
        `${at('amount')} is ${taxableAmount}, but ${quantity} x ${unitPrice} less ${discount} ` +
          `comes to ${toMoneyString(expected)}.`,
        { lineNumber, taxableAmount, expected: toMoneyString(expected) },
      )
    }

    /* A discount bigger than the line is a line worth less than nothing for a reason
     * nobody meant. A deliberate negative line says so in its price. */
    if (D(discount).greaterThan(D(quantity).times(D(unitPrice))) && D(discount).greaterThan(0)) {
      throw new RepoError(
        'DISCOUNT_EXCEEDS_LINE',
        `${at('discount')} of ${discount} is more than the line is worth.`,
        { lineNumber, discount },
      )
    }

    return {
      lineNumber,
      input,
      quantity,
      unitPrice,
      discount,
      taxableAmount,
      ratePct,
      taxes: (input.taxes ?? []).map((component) => ({
        code: component.code.trim().toUpperCase(),
        label: component.label.trim(),
        ratePct: figureAt('rate', component.ratePct, at(`${component.code} rate`)),
        amount: figureAt('money', component.amount, at(component.code)),
      })),
    }
  })
}

async function writeLines(
  trx: CofferDb,
  documentId: string,
  lines: readonly NormalisedLine[],
): Promise<void> {
  for (const line of lines) {
    const id = randomUUID()
    await trx
      .insertInto('document_lines')
      .values({
        id,
        document_id: documentId,
        line_number: line.lineNumber,
        item_id: line.input.itemId ?? null,
        description: line.input.description.trim(),
        quantity: line.quantity,
        unit_code: trimmedOrNull(line.input.unitCode)?.toUpperCase() ?? null,
        unit_price: line.unitPrice,
        discount: line.discount,
        taxable_amount: line.taxableAmount,
        rate_pct: line.ratePct,
        classification_code: trimmedOrNull(line.input.classificationCode),
        is_charge: line.input.isCharge === true ? 1 : 0,
        account_id: line.input.accountId ?? null,
      })
      .execute()

    for (const component of line.taxes) {
      await trx
        .insertInto('document_line_taxes')
        .values({
          document_line_id: id,
          code: component.code,
          label: component.label,
          rate_pct: component.ratePct,
          amount: component.amount,
        })
        .execute()
    }
  }
}

/** Every line of every named document, with its taxes, in line order. */
async function linesFor(
  db: CofferDb,
  documentIds: readonly string[],
): Promise<Map<string, DocumentLineDto[]>> {
  const byDocument = new Map<string, DocumentLineDto[]>()
  if (documentIds.length === 0) return byDocument

  const lineRows = await db
    .selectFrom('document_lines')
    .selectAll()
    .where('document_id', 'in', [...documentIds])
    .orderBy('document_id')
    .orderBy('line_number')
    .execute()

  const taxRows =
    lineRows.length === 0
      ? []
      : await db
          .selectFrom('document_line_taxes')
          .selectAll()
          .where(
            'document_line_id',
            'in',
            lineRows.map((row) => row.id),
          )
          .execute()

  const taxesByLine = new Map<string, DocumentLineTaxDto[]>()
  for (const row of taxRows) {
    const list = taxesByLine.get(row.document_line_id) ?? []
    list.push({ code: row.code, label: row.label, ratePct: row.rate_pct, amount: row.amount })
    taxesByLine.set(row.document_line_id, list)
  }

  for (const row of lineRows) {
    const list = byDocument.get(row.document_id) ?? []
    list.push({
      id: row.id,
      lineNumber: row.line_number,
      itemId: row.item_id,
      description: row.description,
      quantity: row.quantity,
      unitCode: row.unit_code,
      unitPrice: row.unit_price,
      discount: row.discount,
      taxableAmount: row.taxable_amount,
      ratePct: row.rate_pct,
      classificationCode: row.classification_code,
      isCharge: row.is_charge === 1,
      accountId: row.account_id,
      taxes: taxesByLine.get(row.id) ?? [],
    })
    byDocument.set(row.document_id, list)
  }

  return byDocument
}

/**
 * The foot of a document, computed from its lines.
 *
 * Straight through `documentTotals` in the domain — the same function the posting rule
 * folds, which is what makes the printed total and the journal entry the same arithmetic
 * rather than two figures kept in step.
 */
function totalsFor(
  lines: readonly DocumentLineDto[],
  roundingPolicy: 'whole-unit' | 'none',
): DocumentTotalsDto {
  const totals = documentTotals({
    roundingPolicy,
    lines: lines.map(toDomainLine),
  })

  return {
    taxableValue: toMoneyString(totals.taxableValue),
    totalDiscount: toMoneyString(totals.totalDiscount),
    totalTax: toMoneyString(totals.totalTax),
    netTotal: toMoneyString(totals.netTotal),
    roundOff: toMoneyString(totals.roundOff),
    grandTotal: toMoneyString(totals.grandTotal),
    taxSummary: totals.taxSummary.map((row) => ({
      code: row.code,
      label: row.label,
      ratePct: toRateString(row.ratePct),
      amount: toMoneyString(row.amount),
    })),
  }
}

/** A stored line, as the domain sees it. */
export function toDomainLine(line: DocumentLineDto): DocumentLine {
  return {
    id: line.id,
    lineNumber: line.lineNumber,
    itemId: line.itemId,
    description: line.description,
    quantity: D(line.quantity),
    unitCode: line.unitCode,
    unitPrice: D(line.unitPrice),
    discount: D(line.discount),
    taxableAmount: D(line.taxableAmount),
    ratePct: D(line.ratePct),
    classificationCode: line.classificationCode,
    isCharge: line.isCharge,
    accountId: line.accountId,
    taxes: line.taxes.map((component) => ({
      code: component.code,
      label: component.label,
      ratePct: D(component.ratePct),
      amount: D(component.amount),
    })),
  }
}

/**
 * Read a figure at its own scale, and say which line it was on when it will not read.
 *
 * Parsed AND rendered, so what reaches the column is always the canonical form: '5' for a
 * quantity becomes '5.000', which is what the CHECK in 0008 insists on. A caller sending
 * a shorter string is being helpful, not wrong, and the storage shape is this layer's
 * business rather than theirs.
 */
function figureAt(scale: 'money' | 'quantity' | 'rate', value: string, field: string): string {
  const read = { money: parseMoney, quantity: parseQuantity, rate: parseRate }[scale]
  const write = { money: toMoneyString, quantity: toQuantityString, rate: toRateString }[scale]
  try {
    return write(read(value))
  } catch (error) {
    throw new RepoError(
      'INVALID_LINE_AMOUNT',
      `${field}: ${JSON.stringify(value)} is not a number at ${scale} scale.`,
      { field, value, scale },
      { cause: error },
    )
  }
}

function trimmedOrNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
