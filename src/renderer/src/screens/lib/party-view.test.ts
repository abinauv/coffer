import { describe, expect, it } from 'vitest'
import type { Party, PartySummary } from '@shared/dto'
import {
  blankDraft,
  copyFor,
  defaultCountryCode,
  draftOf,
  filterParties,
  isPlaceOfSupplyUnknown,
  leavesList,
  parsePaymentTerms,
  partyFieldsFrom,
  partyKindLabel,
} from './party-view'

function party(over: Partial<PartySummary> & Pick<PartySummary, 'name'>): PartySummary {
  return {
    id: over.name,
    registrationNumber: null,
    jurisdictionCode: null,
    countryCode: 'in',
    isCustomer: true,
    isVendor: false,
    city: null,
    isArchived: false,
    ...over,
  }
}

function whole(over: Partial<Party> & Pick<Party, 'name'>): Party {
  return {
    ...party(over),
    legalName: null,
    addressLine1: null,
    addressLine2: null,
    postalCode: null,
    email: null,
    phone: null,
    paymentTermsDays: null,
    creditLimit: null,
    notes: null,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    ...over,
  }
}

const LIST: PartySummary[] = [
  party({ name: 'Sharma Enterprises', city: 'Chennai', registrationNumber: '33AABCC1234D1ZI' }),
  party({ name: 'Sharma Enterprises (Kochi)', city: 'Kochi' }),
  party({ name: 'Bharat Steel', city: 'Coimbatore', isVendor: true }),
]

const names = (rows: readonly PartySummary[]) => rows.map((row) => row.name)

describe('filterParties', () => {
  it('returns everything for an empty query', () => {
    expect(filterParties(LIST, '')).toHaveLength(3)
    expect(filterParties(LIST, '   ')).toHaveLength(3)
  })

  it('matches a name, ignoring case', () => {
    expect(names(filterParties(LIST, 'bharat'))).toEqual(['Bharat Steel'])
  })

  /* The case the unique name index deliberately forces on somebody: two firms with the
   * same name, told apart by where they are. If the city were not searched, the screen
   * would offer no way to resolve what the database insisted they resolve. */
  it('matches a city, which is what separates two firms of the same name', () => {
    expect(names(filterParties(LIST, 'kochi'))).toEqual(['Sharma Enterprises (Kochi)'])
    expect(names(filterParties(LIST, 'sharma'))).toHaveLength(2)
  })

  /* An accountant reconciling a return has the GSTIN in front of them and quite possibly
   * not the trading name. */
  it('matches a registration number', () => {
    expect(names(filterParties(LIST, '33AABCC'))).toEqual(['Sharma Enterprises'])
  })

  it('matches nothing rather than everything when nothing matches', () => {
    expect(filterParties(LIST, 'zzz')).toHaveLength(0)
  })

  it('does not trip over a party with no city or number', () => {
    expect(filterParties([party({ name: 'Plain' })], 'chennai')).toHaveLength(0)
  })
})

describe('partyKindLabel', () => {
  it('says which side a party is on, and says Both when they are on two', () => {
    expect(partyKindLabel({ isCustomer: true, isVendor: false })).toBe('Customer')
    expect(partyKindLabel({ isCustomer: false, isVendor: true })).toBe('Vendor')
    expect(partyKindLabel({ isCustomer: true, isVendor: true })).toBe('Both')
  })
})

describe('leavesList', () => {
  /* Un-ticking `is a customer` on the Customers screen makes the row disappear, which
   * reads as a delete unless the screen says so first. */
  it('is true when the edit removes the role the list is filtered by', () => {
    expect(leavesList('customer', { isCustomer: false, isVendor: true })).toBe(true)
    expect(leavesList('vendor', { isCustomer: true, isVendor: false })).toBe(true)
  })

  it('is false when the party keeps the role, or gains the other one', () => {
    expect(leavesList('customer', { isCustomer: true, isVendor: true })).toBe(false)
    expect(leavesList('vendor', { isCustomer: true, isVendor: true })).toBe(false)
  })

  it('is false on an unfiltered list, where nothing can leave it', () => {
    expect(leavesList(null, { isCustomer: false, isVendor: false })).toBe(false)
  })
})

describe('copyFor', () => {
  it('names the side it was entered from', () => {
    expect(copyFor('customer').title).toBe('Customers')
    expect(copyFor('vendor').title).toBe('Vendors')
    expect(copyFor(null).title).toBe('Parties')
  })

  /* One record per firm is the decision behind the whole table, so both filtered screens
   * have to say it — a user who only ever opens Vendors would otherwise never be told. */
  it('says on both sides that one firm is one record', () => {
    expect(copyFor('customer').lede).toMatch(/one record/i)
    expect(copyFor('vendor').lede).toMatch(/one record/i)
  })

  it('names the thing being added in the words of that screen', () => {
    expect(copyFor('customer').newLabel).toBe('New customer')
    expect(copyFor('vendor').newLabel).toBe('New vendor')
    expect(copyFor(null).newLabel).toBe('New party')
  })
})

describe('defaultCountryCode', () => {
  /*
   * THE FIXTURES DISAGREE ON PURPOSE. A profile in Portugal under a regime whose id is
   * `in` is the only pair that can tell the two sources apart — with both saying `in`,
   * a function that read the wrong one, or that hard-coded India as this screen did,
   * would pass.
   */
  it('takes the company profile over the regime id', () => {
    expect(defaultCountryCode({ countryCode: 'pt' }, { id: 'in' })).toBe('pt')
  })

  /* Books whose profile nobody has filled in yet still take parties, and the regime's id
   * is documented as an ISO 3166-1 alpha-2 code. */
  it('falls back to the regime id where there is no profile', () => {
    expect(defaultCountryCode(null, { id: 'in' })).toBe('in')
  })

  /*
   * A regime is not a country. `eu-vat` in a two-letter column would be a default the
   * user has to notice and correct, which is a default that gets saved wrong — the same
   * test `CompanyProfile.tsx` applies when it seeds its own blank form.
   */
  it('refuses a regime id that is not shaped like a country', () => {
    expect(defaultCountryCode(null, { id: 'eu-vat' })).toBe('')
  })

  it('answers nothing when neither source has anything to say', () => {
    expect(defaultCountryCode(null, null)).toBe('')
    expect(defaultCountryCode({ countryCode: '   ' }, null)).toBe('')
  })

  /* `country_code` is stored lower case. A profile saved as `IN` must not seed a party
   * with a country that differs from the company's by case alone. */
  it('normalises what it found', () => {
    expect(defaultCountryCode({ countryCode: ' PT ' }, null)).toBe('pt')
    expect(defaultCountryCode(null, { id: 'IN' })).toBe('in')
  })
})

describe('blankDraft', () => {
  it('starts a record on the side the screen was opened from', () => {
    expect(blankDraft('vendor', 'in')).toMatchObject({ isCustomer: false, isVendor: true })
    expect(blankDraft('customer', 'in')).toMatchObject({ isCustomer: true, isVendor: false })
  })

  /* Defaulting to neither would make the first save fail for everybody — the table
   * refuses a party who is neither. The unfiltered screen picks a customer. */
  it('makes an unfiltered new record a customer rather than nothing', () => {
    expect(blankDraft(null, 'in')).toMatchObject({ isCustomer: true, isVendor: false })
  })

  it('carries the country it was handed rather than choosing one', () => {
    expect(blankDraft('customer', 'pt').countryCode).toBe('pt')
    expect(blankDraft('customer', '').countryCode).toBe('')
  })
})

describe('draftOf', () => {
  it('turns every absent field into an empty box', () => {
    expect(draftOf(whole({ name: 'Walk-in' }))).toEqual({
      name: 'Walk-in',
      legalName: '',
      registrationNumber: '',
      jurisdictionCode: '',
      countryCode: 'in',
      isCustomer: true,
      isVendor: false,
      addressLine1: '',
      addressLine2: '',
      city: '',
      postalCode: '',
      email: '',
      phone: '',
      paymentTermsDays: '',
      creditLimit: '',
      notes: '',
    })
  })

  /* The round trip the whole product's due dates hang on: a party on thirty days has to
   * come back reading thirty, or the next save silently clears the terms. */
  it('shows the terms a party is on', () => {
    expect(draftOf(whole({ name: 'Bharat Steel', paymentTermsDays: 30 })).paymentTermsDays).toBe(
      '30',
    )
  })

  /*
   * NOUGHT IS NOT NOTHING, on either field. Terms of nought days is due on issue and no
   * terms at all is nothing agreed; a limit of `0.00` is a customer who pays up front and
   * no limit is a customer with none. A falsy check would turn both into a blank box and
   * the next save would clear them.
   */
  it('keeps a nought apart from an absence', () => {
    expect(draftOf(whole({ name: 'Cash', paymentTermsDays: 0 })).paymentTermsDays).toBe('0')
    expect(draftOf(whole({ name: 'Cash', creditLimit: '0.00' })).creditLimit).toBe('0.00')
  })

  /* Money is shown as main stored it, not as it was typed: `1000` comes back `1000.00`
   * and the form has no business rewriting either one. */
  it('shows the credit limit at the scale main sent it', () => {
    expect(draftOf(whole({ name: 'Bharat Steel', creditLimit: '1000.00' })).creditLimit).toBe(
      '1000.00',
    )
  })
})

describe('parsePaymentTerms', () => {
  /* Blank is an answer: nothing was agreed. It is not zero, which is terms of no days. */
  it('reads an empty box as nothing agreed', () => {
    expect(parsePaymentTerms('')).toEqual({ ok: true, days: null })
    expect(parsePaymentTerms('   ')).toEqual({ ok: true, days: null })
  })

  it('reads a whole number of days, trimmed', () => {
    expect(parsePaymentTerms('30')).toEqual({ ok: true, days: 30 })
    expect(parsePaymentTerms('  45  ')).toEqual({ ok: true, days: 45 })
  })

  it('reads nought as nought rather than as nothing', () => {
    expect(parsePaymentTerms('0')).toEqual({ ok: true, days: 0 })
  })

  /* One condition refuses all three, which is why there is one regular expression here
   * and not a chain of comparisons. */
  it('refuses anything that is not a whole number of days', () => {
    for (const typed of ['-5', '14.5', 'thirty', '30 days', '1e3']) {
      const result = parsePaymentTerms(typed)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toMatch(/whole number of days/)
    }
  })

  /* Twenty digits are digits and are not a number: `Number` rounds them and the value
   * that reached the column would not be the value that was typed. */
  it('refuses a run of digits too long to be a number', () => {
    expect(parsePaymentTerms('99999999999999999999').ok).toBe(false)
  })
})

describe('isPlaceOfSupplyUnknown', () => {
  const draft = (over: Partial<Parameters<typeof isPlaceOfSupplyUnknown>[0]> = {}) => ({
    registrationNumber: '',
    jurisdictionCode: '',
    countryCode: 'in',
    ...over,
  })

  /*
   * The gap this batch exists to close. An unregistered walk-in customer with no state
   * gives `jurisdictionOf` nothing to answer with, and every supply to them resolves as
   * crossing a state line — silently, on every document.
   */
  it('is true for an unregistered party with no state', () => {
    expect(isPlaceOfSupplyUnknown(draft(), 'in')).toBe(true)
  })

  it('is false once a state has been picked', () => {
    expect(isPlaceOfSupplyUnknown(draft({ jurisdictionCode: '33' }), 'in')).toBe(false)
  })

  /* Main derives the state from the number, so warning about a registered party would be
   * warning about a field that is about to be filled in for us. */
  it('is false for a registered party, whose number carries the state', () => {
    expect(isPlaceOfSupplyUnknown(draft({ registrationNumber: '33AABCC1234D1ZI' }), 'in')).toBe(
      false,
    )
  })

  /* A supply across a border does not turn on a sub-national code, so an empty box is
   * not a gap. */
  it('is false for a party in another country', () => {
    expect(isPlaceOfSupplyUnknown(draft({ countryCode: 'sg' }), 'in')).toBe(false)
  })

  /* Two blanks are not a disagreement. Books with no profile must still be told that a
   * party says nothing about where it is. */
  it('is true when there is nothing to compare the country against', () => {
    expect(isPlaceOfSupplyUnknown(draft({ countryCode: '' }), 'in')).toBe(true)
    expect(isPlaceOfSupplyUnknown(draft(), '')).toBe(true)
  })

  it('does not read case or spacing as a different country', () => {
    expect(isPlaceOfSupplyUnknown(draft({ countryCode: ' IN ' }), 'in')).toBe(true)
  })
})

describe('partyFieldsFrom', () => {
  it('sends every writable field, trimmed', () => {
    const draft = {
      name: '  Bharat Steel  ',
      legalName: ' Bharat Steel Private Limited ',
      registrationNumber: ' 33AABCC1234D1ZI ',
      jurisdictionCode: ' 33 ',
      countryCode: ' in ',
      isCustomer: true,
      isVendor: true,
      addressLine1: ' 14 Anna Salai ',
      addressLine2: ' Teynampet ',
      city: ' Chennai ',
      postalCode: ' 600018 ',
      email: ' accounts@bharat.example ',
      phone: ' +91 44 4000 0000 ',
      paymentTermsDays: ' 30 ',
      creditLimit: ' 1000 ',
      notes: ' Pays by cheque. ',
    }

    expect(partyFieldsFrom(draft, 30)).toEqual({
      name: 'Bharat Steel',
      legalName: 'Bharat Steel Private Limited',
      registrationNumber: '33AABCC1234D1ZI',
      jurisdictionCode: '33',
      countryCode: 'in',
      isCustomer: true,
      isVendor: true,
      addressLine1: '14 Anna Salai',
      addressLine2: 'Teynampet',
      city: 'Chennai',
      postalCode: '600018',
      email: 'accounts@bharat.example',
      phone: '+91 44 4000 0000',
      paymentTermsDays: 30,
      creditLimit: '1000',
      notes: 'Pays by cheque.',
    })
  })

  /*
   * THE RENDERER NEVER COMPUTES MONEY (CONVENTIONS §1.7). `1000` crosses as `1000`, not
   * as `1000.00`: parsing it, scaling it to two places and refusing a negative are all
   * main's, and a screen that scaled it here would be a second implementation of the
   * money rules that could only ever drift from the first.
   */
  it('sends the credit limit as typed and does not scale it', () => {
    const fields = partyFieldsFrom(
      { ...blankDraft('customer', 'in'), name: 'X', creditLimit: '1000' },
      null,
    )
    expect(fields.creditLimit).toBe('1000')
  })

  /* An empty box is a user saying there is nothing there, and `parties.update` is a
   * patch: the field has to cross for the clear to happen. */
  it('sends an empty box rather than leaving the field out', () => {
    const fields = partyFieldsFrom({ ...blankDraft('customer', 'in'), name: 'X' }, null)
    expect(fields).toHaveProperty('notes', '')
    expect(fields).toHaveProperty('creditLimit', '')
    expect(fields.paymentTermsDays).toBeNull()
  })
})
