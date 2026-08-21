/*
 * 0011 — company_profile.
 *
 * Who these books belong to: the legal name, the registration number, the jurisdiction
 * and the address. Promised in writing since Phase 1 — 0001's header and data-model.md
 * both say the company profile is "a Phase 1 table with its own columns and its own
 * constraints" — and built now because tax cannot be computed without it.
 *
 * `TaxRegime.computeTax` takes a SUPPLIER and a customer, and decides CGST+SGST against
 * IGST from whether their two jurisdictions match. Coffer has had the customer since
 * 0005 and has had nowhere to put the supplier, so the seam has been carrying a
 * parameter nothing could fill. This is the column it comes from.
 *
 * ---------------------------------------------------------------------------
 * ONE ROW, AND WHY THAT IS NOT THE `settings` TABLE CONVENTIONS §9 FORBIDS
 *
 * A company is one encrypted file (ARCHITECTURE §6.3). There is no `company_id` column
 * anywhere and there will not be one, so "which company" is answered by which file is
 * open — and a profile keyed by anything would be a second answer to a question the file
 * has already answered. Hence `CHECK (id = 'company')`: at most one row, enforced by a
 * constraint rather than by every caller remembering.
 *
 * CONVENTIONS §9 lists "the single-row `settings` company profile" among the reference
 * project's bugs not to port, and this table is single-row, so the distinction has to be
 * stated rather than assumed. What was wrong there was not the row count. It was that
 * the row had no subject: the company profile, the invoice defaults, the e-mail
 * configuration and the print preferences all lived in it, so every screen wrote to it,
 * no constraint could describe it, and every new field was a migration that rewrote the
 * table.
 *
 * THIS TABLE HAS A SUBJECT, AND IT IS IDENTITY — who the business is, as a tax
 * authority and a customer would recognise it. Nothing that is a preference belongs
 * here. When invoice defaults arrive they get their own table, and so does anything to
 * do with sending mail, because they change for different reasons and by different
 * hands: a profile changes when the business re-registers or moves, and a default
 * changes because somebody found it inconvenient. The pressure to put
 * `default_payment_terms` in this table will be real, and the reference project is what
 * happens after the third time somebody gives in to it.
 *
 * The name is singular against CONVENTIONS §2, deliberately. Plural table names exist so
 * that a row reads as one of many; `company_profiles` would promise a set the CHECK
 * above forbids.
 *
 * ---------------------------------------------------------------------------
 * THE TABLE STARTS EMPTY, AND EMPTY IS A LEGAL STATE
 *
 * No row is seeded. A migration cannot know a company's legal name or its state code,
 * and seeding a placeholder — `''`, `'Unknown'`, the display name from the registry —
 * would be a fact this file invented, which the CHECKs would then have to be loosened to
 * permit. It would also be indistinguishable afterwards from a profile somebody filled
 * in, which is the part that matters: the whole value of this table is that what is in it
 * was put there by a person who knows.
 *
 * So reads answer null until it is filled in, and what that costs is one error at the
 * point tax is computed, saying the books do not know who they are for. That is a
 * sentence a user can act on. Books without a profile still work — a chart, periods,
 * parties, drafts and the ledger itself neither know nor care.
 *
 * ---------------------------------------------------------------------------
 * COLUMNS THAT MATCH `parties`, ON PURPOSE
 *
 * `registration_number`, `jurisdiction_code`, `country_code` and the address are spelled
 * exactly as 0005 spells them, because to a regime the supplier and the customer are the
 * same shape — `TaxParty` — and a translation step between two tables that mean the same
 * thing is a place for them to drift.
 *
 * `registration_number` is nullable for the same reason it is on a party: a business
 * below the registration threshold is not registered, still raises invoices, and is
 * exactly the kind of business Coffer is for.
 *
 * A blank is not a value. `''` and NULL both mean "no registration number" to a person
 * and are two different rows to a query, so the CHECKs below leave only one way to say
 * it. The repository trims on the way in; these constraints are what hold when it does
 * not run.
 *
 * NOT NULL AND THE BLANK CHECK ARE TWO RULES, and a required column needs both.
 * `length(trim(NULL))` is NULL, a CHECK whose expression evaluates to NULL PASSES, and so
 * `CHECK (length(trim(legal_name)) > 0)` says nothing at all about a legal name that is
 * missing rather than empty. Measured on a scratch table, not read. It is the same shape
 * as the un-IFNULLed comparison 2.2c found in a freeze trigger, where a NULL `WHEN` meant
 * the trigger simply did not fire.
 *
 * WHICH MAKES THE `IS NULL OR` ARM ON EACH NULLABLE COLUMN'S CHECK REDUNDANT, AND IT
 * STAYS. A DELIBERATE MUTATION SURVIVOR: deleting it changes nothing and cannot, because
 * the shorter form admits a null by the rule above rather than by saying so. It is kept
 * because the shorter form reads as a bug in the other direction — a required-value check
 * written on a column that is not required — and the next reader would have to rediscover
 * the NULL rule to know whether it was one. Six words is a cheap price for not making
 * them.
 *
 * ---------------------------------------------------------------------------
 * TWO RULES CONSIDERED HERE AND DELIBERATELY NOT WRITTEN
 *
 * THE JURISDICTION FROZEN ONCE A DOCUMENT IS ISSUED. Tempting, because the company's
 * jurisdiction is half of what decided the tax on every invoice already raised. It is
 * wrong twice over. Businesses relocate and re-register, and a book that refuses to
 * record it is a book somebody keeps outside Coffer. And the history is already safe
 * without it: every document stores the tax it was raised with in `document_line_taxes`
 * and the place of supply it was decided from in its own columns, so changing this row
 * changes the next invoice and can never reach a past one. A trigger would trade a real
 * capability for a protection that is already in place.
 *
 * `CHECK (length(country_code) = 2)`. ISO 3166-1 alpha-2 is two letters and the check
 * would hold. It is not written because `parties.country_code` carries no such check and
 * cannot be given one now (§1.5), and a country code that is acceptable for a customer
 * and refused for the company would be a rule with no reason behind it. Normalisation is
 * the repository's job on both sides.
 */

import type { Migration } from '../migrate'

/** The only value `company_profile.id` may take. One file, one company, one row. */
export const COMPANY_PROFILE_ID = 'company'

export const m0011: Migration = {
  id: '0011',
  name: 'company_profile',

  up(db) {
    db.exec(
      `CREATE TABLE company_profile (
        id TEXT PRIMARY KEY CHECK (id = '${COMPANY_PROFILE_ID}'),
        legal_name TEXT NOT NULL,
        trade_name TEXT,
        registration_number TEXT,
        jurisdiction_code TEXT,
        country_code TEXT NOT NULL,
        address_line1 TEXT,
        address_line2 TEXT,
        city TEXT,
        postal_code TEXT,
        email TEXT,
        phone TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (length(trim(legal_name)) > 0),
        CHECK (length(trim(country_code)) > 0),
        CHECK (trade_name IS NULL OR length(trim(trade_name)) > 0),
        CHECK (registration_number IS NULL OR length(trim(registration_number)) > 0),
        CHECK (jurisdiction_code IS NULL OR length(trim(jurisdiction_code)) > 0)
      ) STRICT`,
    )

    /*
     * No index. One row cannot be searched, sorted or scanned expensively, and the
     * primary key is the only way in.
     */
  },

  down(db) {
    db.exec(`DROP TABLE company_profile`)
  },
}
