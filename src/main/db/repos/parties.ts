/*
 * The parties repository — customers and vendors, in one table.
 *
 * Read migration 0005 first. The two decisions that shape everything here are that a
 * customer and a vendor are one record with two flags, and that a party is not an
 * account: its balance is a sum over `journal_lines.party_id`, never a stored figure and
 * never a row in the chart of accounts.
 *
 * WHAT THIS FILE DOES NOT DO. It does not validate a registration number. GSTIN is the
 * regime's business (`TaxRegime.validateRegistrationNumber`), `db/` may not import a
 * concrete regime, and threading a validator through every call would put the seam in
 * the wrong place. The service layer validates before calling; what is enforced here is
 * uniqueness, which only the database can answer.
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'

import { parseMoney, toMoneyString } from '@main/domain/money'
import type {
  CreatePartyInput,
  ListPartiesInput,
  Party,
  PartySummary,
  UpdatePartyInput,
} from '@shared/dto'

import type { CofferDb } from '../kysely'
import type { PartiesTable } from '../schema'
import { RepoError } from './errors'

type PartyRow = {
  [K in keyof PartiesTable]: PartiesTable[K]
}

// ---- Reading ---------------------------------------------------------------

/**
 * Parties, ordered by name.
 *
 * Archived parties are excluded by default. A picker offering one is a picker that lets
 * somebody raise an invoice against a customer the business has stopped dealing with,
 * and the trigger would then refuse the posting after the document was written.
 */
export async function listParties(
  db: CofferDb,
  input: ListPartiesInput = {},
): Promise<PartySummary[]> {
  let query = db.selectFrom('parties').selectAll()

  if (input.includeArchived !== true) {
    query = query.where('is_archived', '=', 0)
  }
  if (input.role === 'customer') {
    query = query.where('is_customer', '=', 1)
  }
  if (input.role === 'vendor') {
    query = query.where('is_vendor', '=', 1)
  }
  /* The blank check is not a rule either: the term is built from `.trim()`, so a search
   * of spaces becomes '%%' and matches everything with or without this guard. It is here
   * to skip three LIKEs over the table, and a mutation removing it survives. */
  if (input.search !== undefined && input.search.trim() !== '') {
    const term = `%${input.search.trim()}%`
    query = query.where((eb) =>
      eb.or([
        eb(sql<string>`name COLLATE NOCASE`, 'like', term),
        eb(sql<string>`COALESCE(registration_number, '') COLLATE NOCASE`, 'like', term),
        eb(sql<string>`COALESCE(city, '') COLLATE NOCASE`, 'like', term),
      ]),
    )
  }

  const rows = await query.orderBy(sql`name COLLATE NOCASE`).execute()
  return rows.map(toSummary)
}

export async function getParty(db: CofferDb, id: string): Promise<Party | null> {
  const row = await db.selectFrom('parties').selectAll().where('id', '=', id).executeTakeFirst()
  return row === undefined ? null : toParty(row)
}

// ---- Writing ---------------------------------------------------------------

export async function createParty(db: CofferDb, input: CreatePartyInput): Promise<Party> {
  const name = requireName(input.name)
  const registrationNumber = trimmedOrNull(input.registrationNumber)

  assertHasARole(input.isCustomer === true, input.isVendor === true)
  await assertNameFree(db, name, null)
  await assertRegistrationFree(db, registrationNumber, null)

  const now = new Date().toISOString()
  const id = randomUUID()

  await db
    .insertInto('parties')
    .values({
      id,
      name,
      legal_name: trimmedOrNull(input.legalName),
      registration_number: registrationNumber,
      jurisdiction_code: trimmedOrNull(input.jurisdictionCode),
      country_code: input.countryCode.trim().toLowerCase(),
      is_customer: input.isCustomer === true ? 1 : 0,
      is_vendor: input.isVendor === true ? 1 : 0,
      address_line1: trimmedOrNull(input.addressLine1),
      address_line2: trimmedOrNull(input.addressLine2),
      city: trimmedOrNull(input.city),
      postal_code: trimmedOrNull(input.postalCode),
      email: trimmedOrNull(input.email),
      phone: trimmedOrNull(input.phone),
      payment_terms_days: input.paymentTermsDays ?? null,
      credit_limit: creditLimitOf(input.creditLimit),
      notes: trimmedOrNull(input.notes),
      is_archived: 0,
      created_at: now,
      updated_at: now,
    })
    .execute()

  const created = await getParty(db, id)
  if (created === null) {
    throw new RepoError('PARTY_NOT_FOUND', 'The party was written but could not be read back.', {
      id,
    })
  }
  return created
}

/**
 * Change a party.
 *
 * Every field is optional and only the ones present are written, so a screen that edits
 * one thing does not have to send the whole record back and cannot blank a field it never
 * showed. `null` is a value here and means "clear it"; absent means "leave it".
 */
export async function updateParty(db: CofferDb, input: UpdatePartyInput): Promise<Party> {
  const existing = await requireParty(db, input.id)

  const update: Partial<PartyRow> = { updated_at: new Date().toISOString() }

  if (input.name !== undefined) {
    const name = requireName(input.name)
    await assertNameFree(db, name, existing.id)
    update.name = name
  }
  if (input.registrationNumber !== undefined) {
    const registrationNumber = trimmedOrNull(input.registrationNumber)
    await assertRegistrationFree(db, registrationNumber, existing.id)
    update.registration_number = registrationNumber
  }

  const nextIsCustomer = input.isCustomer ?? existing.isCustomer
  const nextIsVendor = input.isVendor ?? existing.isVendor
  assertHasARole(nextIsCustomer, nextIsVendor)
  if (input.isCustomer !== undefined) {
    update.is_customer = input.isCustomer ? 1 : 0
  }
  if (input.isVendor !== undefined) {
    update.is_vendor = input.isVendor ? 1 : 0
  }

  if (input.legalName !== undefined) update.legal_name = trimmedOrNull(input.legalName)
  if (input.jurisdictionCode !== undefined) {
    update.jurisdiction_code = trimmedOrNull(input.jurisdictionCode)
  }
  if (input.countryCode !== undefined) update.country_code = input.countryCode.trim().toLowerCase()
  if (input.addressLine1 !== undefined) update.address_line1 = trimmedOrNull(input.addressLine1)
  if (input.addressLine2 !== undefined) update.address_line2 = trimmedOrNull(input.addressLine2)
  if (input.city !== undefined) update.city = trimmedOrNull(input.city)
  if (input.postalCode !== undefined) update.postal_code = trimmedOrNull(input.postalCode)
  if (input.email !== undefined) update.email = trimmedOrNull(input.email)
  if (input.phone !== undefined) update.phone = trimmedOrNull(input.phone)
  if (input.paymentTermsDays !== undefined) update.payment_terms_days = input.paymentTermsDays
  if (input.creditLimit !== undefined) update.credit_limit = creditLimitOf(input.creditLimit)
  if (input.notes !== undefined) update.notes = trimmedOrNull(input.notes)

  await db.updateTable('parties').set(update).where('id', '=', existing.id).execute()

  const updated = await getParty(db, existing.id)
  if (updated === null) {
    throw new RepoError('PARTY_NOT_FOUND', 'That party is no longer in these books.', {
      id: existing.id,
    })
  }
  return updated
}

/**
 * Stop offering a party without losing what they owe.
 *
 * Archiving rather than deleting is the answer for anyone who has ever been posted to,
 * and the foreign key makes that a rule rather than a convention. Reversible, because
 * businesses come back.
 */
export async function archiveParty(db: CofferDb, id: string, archived: boolean): Promise<Party> {
  await requireParty(db, id)
  await db
    .updateTable('parties')
    .set({ is_archived: archived ? 1 : 0, updated_at: new Date().toISOString() })
    .where('id', '=', id)
    .execute()

  const party = await getParty(db, id)
  if (party === null) {
    throw new RepoError('PARTY_NOT_FOUND', 'That party is no longer in these books.', { id })
  }
  return party
}

/**
 * Remove a party entirely.
 *
 * Only one nothing has been posted against — `ON DELETE RESTRICT` on
 * `journal_lines.party_id` would refuse it anyway, and the check here exists so the
 * caller gets a sentence rather than a constraint name. A party with history is
 * archived, never deleted: their invoices name them, and a set of books that has
 * forgotten who an invoice was to is not a set of books.
 */
export async function deleteParty(db: CofferDb, id: string): Promise<void> {
  await requireParty(db, id)

  const posted = await db
    .selectFrom('journal_lines')
    .select('id')
    .where('party_id', '=', id)
    .executeTakeFirst()
  if (posted !== undefined) {
    throw new RepoError(
      'PARTY_IN_USE',
      'That party has entries posted against them. Archive them instead.',
      { id },
    )
  }

  await db.deleteFrom('parties').where('id', '=', id).execute()
}

// ---- Guards ----------------------------------------------------------------

/**
 * Load a party and refuse a missing one.
 *
 * Returns the DTO rather than the row, so a caller that needs the current state — as
 * `updateParty` does for the customer/vendor flags — reads it through one code path.
 */
async function requireParty(db: CofferDb, id: string): Promise<Party> {
  const party = await getParty(db, id)
  if (party === null) {
    throw new RepoError('PARTY_NOT_FOUND', 'That party is not in these books.', { id })
  }
  return party
}

/**
 * A party is a customer, a vendor, or both. Never neither.
 *
 * Also a CHECK in 0005, and checked here so the message says what to do. A party who is
 * neither cannot appear in any picker in the application and cannot be posted to, which
 * makes it a row that exists only to be confusing.
 */
function assertHasARole(isCustomer: boolean, isVendor: boolean): void {
  if (!isCustomer && !isVendor) {
    throw new RepoError(
      'PARTY_HAS_NO_ROLE',
      'A party must be a customer, a vendor, or both. Tick at least one.',
      { isCustomer, isVendor },
    )
  }
}

/**
 * Refuse a name another party already holds, ignoring case.
 *
 * `COLLATE NOCASE` to match the unique index exactly. A case-sensitive check here would
 * leave the index as the only thing catching `Acme Traders` against `ACME TRADERS`, and
 * the index reports a constraint name rather than the name that clashed — the same trap
 * `assertCodeFree` fell into for account codes in batch 1.1A.
 */
async function assertNameFree(db: CofferDb, name: string, exceptId: string | null): Promise<void> {
  let query = db
    .selectFrom('parties')
    .select(['id', 'name'])
    .where((eb) => eb(sql<string>`name COLLATE NOCASE`, '=', name))
  if (exceptId !== null) {
    query = query.where('id', '!=', exceptId)
  }
  const clash = await query.executeTakeFirst()
  if (clash !== undefined) {
    throw new RepoError(
      'PARTY_NAME_TAKEN',
      `${clash.name} is already in these books. Add the city or an initial to tell the two apart.`,
      {
        name,
        existingName: clash.name,
      },
    )
  }
}

/**
 * Two parties carrying one registration number are one party entered twice.
 *
 * The null guard is an early return and not a rule: `registration_number = NULL` matches
 * no row in SQL, so removing it would still admit every unregistered party. Measured —
 * the mutation survives on purpose, and the guard stays because a query nobody needs is
 * a query nobody should run.
 */
async function assertRegistrationFree(
  db: CofferDb,
  registrationNumber: string | null,
  exceptId: string | null,
): Promise<void> {
  if (registrationNumber === null) {
    return
  }
  let query = db
    .selectFrom('parties')
    .select(['id', 'name'])
    .where((eb) => eb(sql<string>`registration_number COLLATE NOCASE`, '=', registrationNumber))
  if (exceptId !== null) {
    query = query.where('id', '!=', exceptId)
  }
  const clash = await query.executeTakeFirst()
  if (clash !== undefined) {
    throw new RepoError(
      'PARTY_REGISTRATION_TAKEN',
      `${clash.name} already carries that registration number. One firm is one record — open ${clash.name} instead.`,
      { registrationNumber, existingName: clash.name },
    )
  }
}

/**
 * Refuse a posting to an archived party.
 *
 * A repository check and NOT a trigger, which is the archived-account decision in 0004
 * arriving at the same answer for the same reason: reversing an old entry re-inserts its
 * lines with the party id they already carry, so a trigger would make every entry
 * involving a party unreversible the moment that party was archived. Exported because
 * `postEntry` is where a line's party is known.
 */
export async function assertPartiesActive(
  db: CofferDb,
  partyIds: readonly string[],
): Promise<void> {
  const wanted = [...new Set(partyIds)]
  if (wanted.length === 0) {
    return
  }

  const rows = await db
    .selectFrom('parties')
    .select(['id', 'name', 'is_archived'])
    .where('id', 'in', wanted)
    .execute()

  const found = new Map(rows.map((row) => [row.id, row]))
  for (const id of wanted) {
    const row = found.get(id)
    if (row === undefined) {
      throw new RepoError('PARTY_NOT_FOUND', 'A line names a party that does not exist.', {
        partyId: id,
      })
    }
    if (row.is_archived === 1) {
      throw new RepoError(
        'PARTY_ARCHIVED',
        `${row.name} is archived and takes nothing new. Put them back in use from their list under Sales or Purchases first.`,
        {
          partyId: id,
          name: row.name,
        },
      )
    }
  }
}

// ---- Conversion ------------------------------------------------------------

function toSummary(row: PartyRow): PartySummary {
  return {
    id: row.id,
    name: row.name,
    registrationNumber: row.registration_number,
    jurisdictionCode: row.jurisdiction_code,
    countryCode: row.country_code,
    isCustomer: row.is_customer === 1,
    isVendor: row.is_vendor === 1,
    city: row.city,
    isArchived: row.is_archived === 1,
  }
}

function toParty(row: PartyRow): Party {
  return {
    ...toSummary(row),
    legalName: row.legal_name,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    postalCode: row.postal_code,
    email: row.email,
    phone: row.phone,
    paymentTermsDays: row.payment_terms_days,
    creditLimit: row.credit_limit,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function requireName(value: string): string {
  const name = value.trim()
  if (name === '') {
    throw new RepoError('PARTY_NAME_REQUIRED', 'A party needs a name.', {})
  }
  return name
}

function trimmedOrNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null
  }
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * A credit limit at money scale, or null for no limit.
 *
 * Null and '0.00' are different answers and both are meaningful: no limit, versus a limit
 * of nothing — which is how a business says "this one pays up front". Coercing one into
 * the other would quietly extend credit to somebody who was cut off.
 */
function creditLimitOf(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === '') {
    return null
  }
  try {
    const amount = parseMoney(value.trim(), 'credit limit')
    if (amount.isNegative()) {
      throw new RepoError('INVALID_AMOUNT', 'A credit limit cannot be negative.', { value })
    }
    return toMoneyString(amount)
  } catch (error) {
    if (error instanceof RepoError) {
      throw error
    }
    throw new RepoError(
      'INVALID_AMOUNT',
      `${JSON.stringify(value)} is not an amount.`,
      { value },
      { cause: error },
    )
  }
}
