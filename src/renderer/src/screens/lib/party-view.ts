/*
 * Reading a list of parties, and holding one in a form.
 *
 * Search is done here rather than by the API, for the same reason the chart of accounts
 * filters in the renderer: `parties.list` takes a `search` argument and it exists for the
 * party picker an invoice will need, where the list is long and the screen is a dropdown.
 * A masters screen holds tens to a few hundred rows, and filtering them locally is
 * instant and cannot get out of step with what was typed.
 *
 * WHAT IS SEARCHED, AND WHY THOSE THREE. Name, because that is what anybody types.
 * Registration number, because a GSTIN is what an accountant reconciling a return has in
 * front of them and a name they may not recognise. City, because it is the field that
 * tells two firms called `Sharma Enterprises` apart — which is exactly the case the
 * unique name index forces somebody to resolve, so it is the case this has to serve.
 *
 * ---------------------------------------------------------------------------
 * AND THE FORM. A `Party` has sixteen writable fields and a form holds text, so the
 * conversions between the two live here rather than in the dialog: a draft is made from a
 * record, a payload is made from a draft, and each of those is a function a test can hand
 * a value to. Nothing here computes money and nothing here decides a tax — see the notes
 * on `partyFieldsFrom` and `isPlaceOfSupplyUnknown`, which are the two places somebody
 * would be tempted to.
 */

import type {
  CompanyProfile,
  CreatePartyInput,
  Party,
  PartyRole,
  PartySummary,
  RegimeDescription,
} from '@shared/dto'

/**
 * The rows a search should show. An empty query returns everything.
 *
 * The early return is a shortcut and not a rule: every party has a name, and
 * `name.includes('')` is true, so removing it would return the same rows in a new array.
 * A mutation that deletes it survives on purpose. It stays because handing back the
 * original array when nothing was asked for is worth one line.
 */
export function filterParties(
  parties: readonly PartySummary[],
  query: string,
): readonly PartySummary[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return parties

  return parties.filter((party) =>
    [party.name, party.registrationNumber, party.city].some(
      (field) => field !== null && field.toLowerCase().includes(needle),
    ),
  )
}

/**
 * What a party is, in words.
 *
 * `Both` rather than `Customer and vendor` because it sits in a narrow column beside a
 * name, and because the long form invites reading it as two records rather than one.
 */
export function partyKindLabel(party: Pick<PartySummary, 'isCustomer' | 'isVendor'>): string {
  if (party.isCustomer && party.isVendor) return 'Both'
  if (party.isVendor) return 'Vendor'
  return 'Customer'
}

/**
 * Whether a party would still be listed under `role` after an edit.
 *
 * The Customers screen shows customers. Un-ticking `is a customer` while looking at it
 * therefore makes the party vanish from the list it was edited on, which reads as a
 * delete. The screen says so beforehand; this is the question it asks.
 */
export function leavesList(
  role: PartyRole | null,
  next: Pick<PartySummary, 'isCustomer' | 'isVendor'>,
): boolean {
  if (role === null) return false
  return role === 'customer' ? !next.isCustomer : !next.isVendor
}

/** The heading and copy for each way the screen is entered. */
export interface PartyScreenCopy {
  title: string
  lede: string
  /** The word for one of them, lower case, for use inside a sentence. */
  noun: string
  /** What a new one is called on the button and in the dialog. */
  newLabel: string
  emptyTitle: string
  emptyBody: string
}

export function copyFor(role: PartyRole | null): PartyScreenCopy {
  if (role === 'customer') {
    return {
      title: 'Customers',
      lede: 'Who these books sell to. A customer who also supplies you is one record with both boxes ticked, not two — that is what keeps a set-off honest.',
      noun: 'customer',
      newLabel: 'New customer',
      emptyTitle: 'No customers yet',
      emptyBody: 'Add the first one and an invoice can be raised against them.',
    }
  }
  if (role === 'vendor') {
    return {
      title: 'Vendors',
      lede: 'Who these books buy from. A vendor you also sell to is one record with both boxes ticked, not two — that is what keeps a set-off honest.',
      noun: 'vendor',
      newLabel: 'New vendor',
      emptyTitle: 'No vendors yet',
      emptyBody: 'Add the first one and a bill can be recorded against them.',
    }
  }
  return {
    title: 'Parties',
    lede: 'Everyone these books trade with, on either side. One record per firm, whichever way the money goes.',
    noun: 'party',
    newLabel: 'New party',
    emptyTitle: 'Nobody here yet',
    emptyBody: 'Add a customer or a vendor to begin.',
  }
}

// ---- The form ---------------------------------------------------------------

/**
 * Every editable field of a party, as strings.
 *
 * A form holds text. The DTO's nulls, its `number | null` and its decimal string are all
 * made on the way out, in `partyFieldsFrom`, so there is exactly one place where a box
 * somebody left alone becomes a value in the books.
 */
export interface PartyDraft {
  name: string
  legalName: string
  registrationNumber: string
  jurisdictionCode: string
  countryCode: string
  isCustomer: boolean
  isVendor: boolean
  addressLine1: string
  addressLine2: string
  city: string
  postalCode: string
  email: string
  phone: string
  /** Text, because the box is text. `parsePaymentTerms` is what turns it into days. */
  paymentTermsDays: string
  /** Text, and NOT a number: the renderer never computes money (CONVENTIONS §1.7). */
  creditLimit: string
  notes: string
}

/**
 * The country a new party starts in.
 *
 * THE COMPANY'S PROFILE WINS, and the reason is that it is the only one of the two that
 * is a country. `companyProfile.get` returns `countryCode` — a fact about this business,
 * entered by whoever set the books up, and the same field the regime compares against
 * when it decides whether a supply leaves the country. `regime.describe()` returns an
 * `id`, and an id is a REGIME: it happens to read `in` for India, and a regime named
 * `eu-vat` would put `eu-vat` in a two-letter column.
 *
 * So the regime is a fallback, and only where its id already looks like an ISO 3166-1
 * alpha-2 code — the same test `CompanyProfile.tsx` applies to seed its own blank form,
 * and it is here for the same window: books whose profile nobody has filled in yet still
 * take parties. Where neither answers, this returns `''` and the dialog asks, because
 * `country_code` is NOT NULL (migration 0005) and a default nobody notices is a default
 * that gets saved wrong.
 *
 * Hard-coding `'in'` here would be the bug 2.2e-2 took out of number formatting: right
 * for one country, silently wrong for every other, and invisible in both.
 */
export function defaultCountryCode(
  profile: Pick<CompanyProfile, 'countryCode'> | null,
  regime: Pick<RegimeDescription, 'id'> | null,
): string {
  const fromProfile = profile?.countryCode.trim().toLowerCase() ?? ''
  if (fromProfile !== '') return fromProfile

  const regimeId = regime?.id.trim().toLowerCase() ?? ''
  return regimeId.length === 2 ? regimeId : ''
}

/**
 * A new party, on the side the screen was opened from.
 *
 * A party that is neither a customer nor a vendor is refused by the table, so defaulting
 * to neither would make the first save fail for everybody; and defaulting to customer on
 * the Vendors screen would quietly create the wrong thing.
 */
export function blankDraft(role: PartyRole | null, countryCode: string): PartyDraft {
  return {
    name: '',
    legalName: '',
    registrationNumber: '',
    jurisdictionCode: '',
    countryCode,
    isCustomer: role !== 'vendor',
    isVendor: role === 'vendor',
    addressLine1: '',
    addressLine2: '',
    city: '',
    postalCode: '',
    email: '',
    phone: '',
    paymentTermsDays: '',
    creditLimit: '',
    notes: '',
  }
}

/**
 * An existing party, in the form.
 *
 * `paymentTermsDays` and `creditLimit` are shown as what main stored rather than as what
 * was typed: a limit sent as `1000` comes back `1000.00`, and redrawing the form's own
 * copy instead would be the renderer deciding how money is written.
 */
export function draftOf(party: Party): PartyDraft {
  return {
    name: party.name,
    legalName: party.legalName ?? '',
    registrationNumber: party.registrationNumber ?? '',
    jurisdictionCode: party.jurisdictionCode ?? '',
    countryCode: party.countryCode,
    isCustomer: party.isCustomer,
    isVendor: party.isVendor,
    addressLine1: party.addressLine1 ?? '',
    addressLine2: party.addressLine2 ?? '',
    city: party.city ?? '',
    postalCode: party.postalCode ?? '',
    email: party.email ?? '',
    phone: party.phone ?? '',
    paymentTermsDays: party.paymentTermsDays === null ? '' : String(party.paymentTermsDays),
    creditLimit: party.creditLimit ?? '',
    notes: party.notes ?? '',
  }
}

/** Days from the invoice date to the due date, or what to tell somebody who mistyped it. */
export type PaymentTerms =
  | { readonly ok: true; readonly days: number | null }
  | { readonly ok: false; readonly message: string }

const WHOLE_NUMBER = /^[0-9]+$/

/**
 * The number of days in the terms box.
 *
 * BLANK IS AN ANSWER, and it is `null`: nothing has been agreed. That is not the same as
 * `0`, which is terms of nought days. Both reach the same due date today, because
 * `dueDateAtIssue` reads a party with no terms as due on the document's own date, but
 * they are different sentences about the customer and the column keeps them apart —
 * migration 0005 allows NULL and separately requires `>= 0`.
 *
 * THIS IS NOT A BUSINESS RULE BEING DUPLICATED. Nothing above the table has an opinion
 * about the figure — the service passes it through and the CHECK is the floor — and what
 * is refused here is narrower than that anyway: this is the form saying that a box of
 * text has to spell a whole number of days before it can be one. A negative and a
 * fraction are both refused by the single condition that the text is digits, which is why
 * there is one regular expression here and not three comparisons. `Number.isSafeInteger`
 * answers the separate case of twenty digits, which are digits and are not a number.
 */
export function parsePaymentTerms(text: string): PaymentTerms {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, days: null }

  const refusal = {
    ok: false,
    message:
      'Payment terms are a whole number of days — 30 for net 30. Leave it blank if nothing has been agreed.',
  } as const

  if (!WHOLE_NUMBER.test(trimmed)) return refusal

  const days = Number(trimmed)
  if (!Number.isSafeInteger(days)) return refusal

  return { ok: true, days }
}

/**
 * Whether nothing in this record says where a supply to or from them takes place.
 *
 * WHAT THIS DECIDES IS WHICH QUESTION TO ASK, NEVER WHAT THE TAX IS. It is the shape of
 * `jurisdictionOf` in src/main/regimes/in-gst/place-of-supply.ts read backwards: that
 * function takes the explicit code where there is one and falls back to the state a
 * registration number encodes, so a party with neither has no jurisdiction at all — and
 * `placeOfSupply` then resolves the supply as crossing a state line, because an unknown
 * state on either side is not evidence that the two match. That is the right answer for a
 * regime to give and a bad thing for a screen to leave unsaid: it is silent, it is on
 * every document raised against that party, and until this batch NO SCREEN COULD SET THE
 * FIELD AT ALL. Most small customers are unregistered, so this is the ordinary case and
 * not the edge one.
 *
 * The three ways it is answered, in the order the regime reads them:
 *
 *   - A country that is not the company's own. A sub-national code is not what a supply
 *     across a border turns on, so an empty box is not a gap. Two blanks are treated as
 *     the same country, because two blanks are not a disagreement.
 *   - An explicit code. What a user can see and correct wins — the regime's rule, not
 *     this one.
 *   - A registration number. Main derives the code from it and refuses a pair that
 *     disagree, so warning here would be warning about a field that is about to be filled
 *     in for us.
 *
 * It applies on both sides of the trade. A vendor's state decides a purchase exactly as a
 * customer's decides a sale: `placeOfSupply` compares the supplier's jurisdiction with
 * the recipient's, and on a bill the vendor is the supplier.
 */
export function isPlaceOfSupplyUnknown(
  party: Pick<PartyDraft, 'registrationNumber' | 'jurisdictionCode' | 'countryCode'>,
  homeCountryCode: string,
): boolean {
  const home = homeCountryCode.trim().toLowerCase()
  const theirs = party.countryCode.trim().toLowerCase()
  if (home !== '' && theirs !== '' && home !== theirs) return false

  if (party.jurisdictionCode.trim() !== '') return false
  return party.registrationNumber.trim() === ''
}

/**
 * What a save sends.
 *
 * EVERY FIELD, EVERY TIME, and that is safe here for one reason: this dialog holds every
 * writable field of a party. `parties.update` is a patch — absent means "leave it", null
 * means "clear it" — so a form showing six fields would have to send six; a form showing
 * all of them sends all of them, and an empty box is a user saying there is nothing
 * there. Written out field by field rather than spread, so a field added to
 * `CreatePartyInput` is a compile error here rather than a value nobody ever writes,
 * which is the state this whole screen was in.
 *
 * TRIMMED AND OTHERWISE UNTOUCHED. `creditLimit` in particular crosses as the characters
 * that were typed: parsing it, scaling it to two places and refusing a negative are all
 * main's (`creditLimitOf`, in db/repos/parties.ts), because the renderer never computes
 * money. `registrationNumber` is the same bargain one layer up and for the same reason —
 * whether a GSTIN is real is the regime's question.
 */
export function partyFieldsFrom(
  draft: PartyDraft,
  paymentTermsDays: number | null,
): CreatePartyInput {
  return {
    name: draft.name.trim(),
    countryCode: draft.countryCode.trim(),
    isCustomer: draft.isCustomer,
    isVendor: draft.isVendor,
    legalName: draft.legalName.trim(),
    registrationNumber: draft.registrationNumber.trim(),
    jurisdictionCode: draft.jurisdictionCode.trim(),
    addressLine1: draft.addressLine1.trim(),
    addressLine2: draft.addressLine2.trim(),
    city: draft.city.trim(),
    postalCode: draft.postalCode.trim(),
    email: draft.email.trim(),
    phone: draft.phone.trim(),
    paymentTermsDays,
    creditLimit: draft.creditLimit.trim(),
    notes: draft.notes.trim(),
  }
}
