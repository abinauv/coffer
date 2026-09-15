/*
 * The `parties` group's boundary.
 *
 * Same subject as ./ledger.test.ts: the renderer is untrusted, so what is tested is what
 * happens to malformed input, and that a rejection never echoes the value back.
 *
 * The rule with teeth here is ABSENT IS NOT NULL. An update that never mentions a field
 * must leave it alone, and one that sends `null` must clear it. Collapse the two and a
 * screen that edits a party's phone number wipes their address — silently, and only for
 * the fields it did not happen to show.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PartyRole } from '../../../shared/dto'
import { IpcError } from '../errors'
import { createPartiesHandlers, type PartiesService } from './parties'

let service: PartiesService
let handlers: ReturnType<typeof createPartiesHandlers>

beforeEach(() => {
  service = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
    create: vi.fn(async () => ({}) as never),
    update: vi.fn(async () => ({}) as never),
    archive: vi.fn(async () => ({}) as never),
    delete: vi.fn(async () => undefined),
  }
  handlers = createPartiesHandlers(service)
})

/** Parse a call's raw arguments as the transport would. */
const parse = (method: keyof typeof handlers, ...raw: unknown[]): unknown[] =>
  handlers[method].parseArgs(raw)

const first = (method: keyof typeof handlers, ...raw: unknown[]): Record<string, unknown> =>
  parse(method, ...raw)[0] as Record<string, unknown>

const rejects = (method: keyof typeof handlers, ...raw: unknown[]) => {
  expect(() => parse(method, ...raw)).toThrow(IpcError)
}

describe('list', () => {
  it('treats a missing argument as no filter', () => {
    expect(parse('list')).toEqual([{}])
    expect(parse('list', null)).toEqual([{}])
  })

  it('narrows the filters it is given', () => {
    expect(parse('list', { includeArchived: true, role: 'vendor', search: 'acme' })).toEqual([
      { includeArchived: true, role: 'vendor', search: 'acme' },
    ])
  })

  it('refuses a role that is not one', () => {
    rejects('list', { role: 'supplier' })
    rejects('list', { role: 1 })
  })

  /* Pinned to the DTO rather than trusted to stay in step — the values are written out
   * in the handler because `expectOneOf` needs them at runtime and a type has none. */
  it('accepts exactly the roles the contract declares', () => {
    const roles: PartyRole[] = ['customer', 'vendor']
    for (const role of roles) {
      expect(parse('list', { role })).toEqual([{ role }])
    }
  })
})

describe('create', () => {
  const minimal = { name: 'Acme Traders', countryCode: 'in', isCustomer: true }

  it('narrows a party', () => {
    expect(first('create', { ...minimal, city: 'Chennai' })).toMatchObject({
      name: 'Acme Traders',
      countryCode: 'in',
      isCustomer: true,
      city: 'Chennai',
    })
  })

  it('needs a name and a country', () => {
    rejects('create', { countryCode: 'in' })
    rejects('create', { name: 'Acme Traders' })
    rejects('create', { ...minimal, name: '' })
    rejects('create', { ...minimal, name: 'x'.repeat(600) })
  })

  /*
   * A party must be a customer, a vendor or both, and the repository is what refuses one
   * that is neither. What matters here is that the boundary does not INVENT an answer:
   * a form that forgot the flags would otherwise quietly produce customers.
   */
  it('does not default the roles', () => {
    const parsed = first('create', { name: 'Acme Traders', countryCode: 'in' })
    expect(parsed['isCustomer']).toBeUndefined()
    expect(parsed['isVendor']).toBeUndefined()
  })

  /* The rule with teeth, the same one ./ledger.test.ts pins for a posting amount: money
   * crosses as text or not at all. Whole rupees are legitimate text and are normalised
   * to two places by the repository, so '50000' is accepted and 50000 is not. */
  it('refuses a credit limit sent as a number', () => {
    expect(() => parse('create', { ...minimal, creditLimit: 50000 })).toThrow(/must be text/)
    expect(first('create', { ...minimal, creditLimit: '50000' })['creditLimit']).toBe('50000')
    rejects('create', { ...minimal, creditLimit: 'lots' })
  })

  it('takes a credit limit of nothing, and no limit at all', () => {
    expect(first('create', { ...minimal, creditLimit: '0.00' })['creditLimit']).toBe('0.00')
    expect(first('create', { ...minimal, creditLimit: null })['creditLimit']).toBeNull()
    expect(first('create', minimal)['creditLimit']).toBeUndefined()
  })

  /*
   * B21. The party dialog sends every field as typed, so a limit left empty arrives as ''.
   * It was refused here, and no party could be added without a credit limit — every
   * screen test passed, because they stub the bridge. Blank is no limit, as the repository
   * has always read it.
   */
  it('reads a blank credit limit as no limit, on a create and an update', () => {
    expect(first('create', { ...minimal, creditLimit: '' })['creditLimit']).toBeNull()
    expect(first('create', { ...minimal, creditLimit: '   ' })['creditLimit']).toBeNull()
    expect(first('update', { id: 'p1', creditLimit: '' })['creditLimit']).toBeNull()
  })

  /* The shape `partyFieldsFrom` builds for a firm with nothing optional filled in: every
   * field present, the empty ones as empty strings. Through the parse, as the app sends it. */
  it('accepts what the party dialog sends for a firm with nothing optional filled in', () => {
    const fromDialog = {
      name: 'Kaveri Polymers',
      countryCode: 'in',
      isCustomer: true,
      isVendor: false,
      legalName: '',
      registrationNumber: '',
      jurisdictionCode: '29',
      addressLine1: '',
      addressLine2: '',
      city: '',
      postalCode: '',
      email: '',
      phone: '',
      paymentTermsDays: 30,
      creditLimit: '',
      notes: '',
    }
    expect(() => parse('create', fromDialog)).not.toThrow()
  })

  it('bounds the payment terms', () => {
    expect(first('create', { ...minimal, paymentTermsDays: 30 })['paymentTermsDays']).toBe(30)
    rejects('create', { ...minimal, paymentTermsDays: -1 })
    rejects('create', { ...minimal, paymentTermsDays: 1.5 })
    rejects('create', { ...minimal, paymentTermsDays: 99999 })
  })

  /* Whether it is a real GSTIN is the regime's question, asked in the service. This
   * layer only sees text — see the header note on why that is not laziness. */
  it('does not judge a registration number', () => {
    expect(first('create', { ...minimal, registrationNumber: 'not a gstin' })).toMatchObject({
      registrationNumber: 'not a gstin',
    })
  })
})

describe('update', () => {
  it('needs an id', () => {
    rejects('update', { name: 'Acme' })
    rejects('update', { id: '' })
  })

  it('leaves absent fields absent', () => {
    const parsed = first('update', { id: 'p1', name: 'Acme Traders' })

    expect(parsed['name']).toBe('Acme Traders')
    for (const field of ['city', 'email', 'phone', 'notes', 'creditLimit', 'legalName']) {
      expect(parsed[field]).toBeUndefined()
    }
  })

  it('passes null through as a clear', () => {
    const parsed = first('update', { id: 'p1', city: null, creditLimit: null })
    expect(parsed['city']).toBeNull()
    expect(parsed['creditLimit']).toBeNull()
  })

  /* A party with no name is not a party, and a blank country is not a place. Both are
   * optional on an update and neither may be cleared. */
  it('refuses to clear the name or the country', () => {
    rejects('update', { id: 'p1', name: null })
    rejects('update', { id: 'p1', name: '' })
    rejects('update', { id: 'p1', countryCode: null })
  })
})

describe('archive and delete', () => {
  it('narrows an archive', () => {
    expect(parse('archive', { id: 'p1', archived: true })).toEqual([{ id: 'p1', archived: true }])
    expect(parse('archive', { id: 'p1', archived: false })).toEqual([{ id: 'p1', archived: false }])
  })

  it('will not guess which way to archive', () => {
    rejects('archive', { id: 'p1' })
    rejects('archive', { id: 'p1', archived: 'yes' })
  })

  it('takes an id for get and delete', () => {
    expect(parse('get', 'p1')).toEqual(['p1'])
    expect(parse('delete', 'p1')).toEqual(['p1'])
    rejects('get', '')
    rejects('delete', 42)
  })
})

describe('the envelope', () => {
  it('wraps what the service returns', async () => {
    expect(await handlers.list.handle({})).toEqual({ ok: true, data: [] })
    expect(await handlers.get.handle('p1')).toEqual({ ok: true, data: null })
  })

  /* A delete answers with nothing, and nothing still has to arrive inside an envelope —
   * the renderer's whole error story rests on it always being there. */
  it('wraps a delete that returns nothing', async () => {
    expect(await handlers.delete.handle('p1')).toEqual({ ok: true, data: undefined })
    expect(service.delete).toHaveBeenCalledWith('p1')
  })
})
