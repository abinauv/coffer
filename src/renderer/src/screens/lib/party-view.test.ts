import { describe, expect, it } from 'vitest'
import type { PartySummary } from '@shared/dto'
import { copyFor, filterParties, leavesList, partyKindLabel } from './party-view'

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
