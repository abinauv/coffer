/*
 * The `companyProfile` group's boundary.
 *
 * Same subject as ./parties.test.ts: the renderer is untrusted, so what is tested is what
 * happens to malformed input, and that a rejection never echoes the value back.
 *
 * The rule with teeth here is the opposite of the one in ./parties.test.ts, which is why
 * it is worth its own file. `parties.update` is a patch and absent must not mean null;
 * `companyProfile.save` is a REPLACE and absent must mean null. A screen that sends only
 * the fields it showed is clearing the rest, on purpose — there is one profile and one
 * form that owns every field of it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { IpcError } from '../errors'
import { createCompanyProfileHandlers, type CompanyProfileService } from './company-profile'

let service: CompanyProfileService
let handlers: ReturnType<typeof createCompanyProfileHandlers>

beforeEach(() => {
  service = {
    get: vi.fn(async () => null),
    save: vi.fn(async () => ({}) as never),
  }
  handlers = createCompanyProfileHandlers(service)
})

const parse = (method: keyof typeof handlers, ...raw: unknown[]): unknown[] =>
  handlers[method].parseArgs(raw)

const saved = (...raw: unknown[]): Record<string, unknown> =>
  parse('save', ...raw)[0] as Record<string, unknown>

const rejects = (method: keyof typeof handlers, ...raw: unknown[]) => {
  expect(() => parse(method, ...raw)).toThrow(IpcError)
}

const MINIMAL = { legalName: 'Acme Traders Private Limited', countryCode: 'in' }

describe('get', () => {
  it('takes no arguments and ignores any that arrive', () => {
    expect(parse('get')).toEqual([])
    expect(parse('get', 'nonsense', 42)).toEqual([])
  })

  it('passes the answer through, including the absence of a profile', async () => {
    await expect(handlers.get.handle()).resolves.toEqual({ ok: true, data: null })
    expect(service.get).toHaveBeenCalledTimes(1)
  })
})

describe('save', () => {
  it('needs an object', () => {
    rejects('save')
    rejects('save', null)
    rejects('save', 'Acme')
    rejects('save', ['Acme'])
  })

  /* The two fields a business cannot be recorded without. Neither is nullable, and a
   * whitespace-only value is not a name. */
  it('needs a legal name and a country', () => {
    rejects('save', { countryCode: 'in' })
    rejects('save', { ...MINIMAL, legalName: '   ' })
    rejects('save', { ...MINIMAL, legalName: null })
    rejects('save', { legalName: 'Acme Traders Private Limited' })
    rejects('save', { ...MINIMAL, countryCode: '' })
  })

  /*
   * ABSENT IS NULL HERE. A form that shows no e-mail box sends no e-mail field, and the
   * profile it saves has no e-mail address — which is the whole difference between a
   * replace and a patch, and the thing a reader coming from ./parties.ts will assume
   * wrongly.
   */
  it('turns every field the caller left out into a cleared field', () => {
    expect(saved(MINIMAL)).toEqual({
      legalName: 'Acme Traders Private Limited',
      countryCode: 'in',
      tradeName: null,
      registrationNumber: null,
      jurisdictionCode: null,
      addressLine1: null,
      addressLine2: null,
      city: null,
      postalCode: null,
      email: null,
      phone: null,
    })
  })

  it('passes an explicit null through as the same thing', () => {
    expect(saved({ ...MINIMAL, city: null })['city']).toBeNull()
    expect(saved({ ...MINIMAL })['city']).toBeNull()
  })

  it('keeps every optional field it is given', () => {
    expect(
      saved({
        ...MINIMAL,
        tradeName: 'Acme',
        registrationNumber: '33AABCC1234D1ZI',
        jurisdictionCode: '33',
        addressLine1: '14 Anna Salai',
        addressLine2: 'Second Floor',
        city: 'Chennai',
        postalCode: '600002',
        email: 'accounts@acme.example',
        phone: '+91 44 4000 0000',
      }),
    ).toMatchObject({
      tradeName: 'Acme',
      registrationNumber: '33AABCC1234D1ZI',
      jurisdictionCode: '33',
      city: 'Chennai',
      email: 'accounts@acme.example',
    })
  })

  it('refuses a field that is not text', () => {
    rejects('save', { ...MINIMAL, city: 42 })
    rejects('save', { ...MINIMAL, phone: { number: '1' } })
  })

  it('refuses text longer than a field can hold', () => {
    rejects('save', { ...MINIMAL, addressLine1: 'x'.repeat(501) })
  })

  /*
   * SHAPE ONLY. Whether a GSTIN is real is the regime's question and its refusal carries
   * `COMPANY_REGISTRATION_INVALID` with a sentence for the user; answering
   * `INVALID_ARGUMENT` here would tell somebody who mistyped one character that their
   * input was malformed.
   */
  it('lets a wrong-looking registration number through to the service', () => {
    expect(saved({ ...MINIMAL, registrationNumber: 'nonsense' })['registrationNumber']).toBe(
      'nonsense',
    )
  })

  it('never echoes a rejected value back', () => {
    try {
      parse('save', { ...MINIMAL, email: 'super-secret@example.com'.repeat(50) })
      expect.unreachable('the parse should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(IpcError)
      expect((error as IpcError).message).not.toContain('super-secret')
      expect((error as IpcError).message).toContain('email')
    }
  })

  it('wraps what the service answers', async () => {
    const profile = { legalName: 'Acme Traders Private Limited' } as never
    service.save = vi.fn(async () => profile)
    handlers = createCompanyProfileHandlers(service)

    await expect(handlers.save.handle(MINIMAL)).resolves.toEqual({ ok: true, data: profile })
  })
})
