/*
 * The `units` group's boundary.
 *
 * Same subject as ./parties.test.ts: the renderer is untrusted, so what is tested is what
 * happens to malformed input, and that a rejection never echoes the value back.
 *
 * THE TWO RULES THIS LAYER OWNS OUTRIGHT are `decimalPlaces` and a blank name, and both
 * are here because the repository deliberately does not restate them (see its header).
 * Without a refusal at this layer they reach a user as a CHECK constraint wearing an
 * internal error and naming no field. So they are tested here rather than in a repository
 * test that would pass whichever layer answered first (CONVENTIONS §6, defence in depth).
 *
 * LOWER CASE IS NOT A REFUSAL, and that is the interesting assertion in this file. A
 * picker that does not hold shift sends `kg`, the repository upper-cases before it reads
 * or writes, and refusing it here would make the software look broken for typing normally.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { IpcError } from '../errors'
import { createUnitsHandlers, type UnitsService } from './units'

let service: UnitsService
let handlers: ReturnType<typeof createUnitsHandlers>

beforeEach(() => {
  service = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
    create: vi.fn(async () => ({}) as never),
    update: vi.fn(async () => ({}) as never),
    archive: vi.fn(async () => ({}) as never),
    delete: vi.fn(async () => undefined),
  }
  handlers = createUnitsHandlers(service)
})

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

  it('narrows the one filter it has', () => {
    expect(parse('list', { includeArchived: true })).toEqual([{ includeArchived: true }])
    expect(parse('list', { includeArchived: false })).toEqual([{ includeArchived: false }])
    rejects('list', { includeArchived: 'yes' })
  })
})

describe('create', () => {
  const minimal = { code: 'KGS', name: 'Kilograms' }

  it('narrows a unit', () => {
    expect(first('create', { ...minimal, decimalPlaces: 3, regimeCode: 'KGS' })).toEqual({
      code: 'KGS',
      name: 'Kilograms',
      decimalPlaces: 3,
      regimeCode: 'KGS',
    })
  })

  it('needs a code and a name', () => {
    rejects('create', { name: 'Kilograms' })
    rejects('create', { code: 'KGS' })
    rejects('create', { ...minimal, code: '' })
    rejects('create', { ...minimal, code: '   ' })
    rejects('create', { ...minimal, name: '' })
  })

  /*
   * The rule the repository leaves here on purpose: `RepoErrorCode` has no member for a
   * blank unit name, so without this refusal a user gets 0006's CHECK as an internal
   * error naming nothing.
   */
  it('refuses a name that is only whitespace', () => {
    expect(() => parse('create', { code: 'KGS', name: '   ' })).toThrow(/'name'/)
  })

  /*
   * A code prints inside a document line. The ceiling is a bound rather than a rule —
   * the database has no opinion — but a unit nobody could read on an invoice is a caller
   * bug and gets a named refusal rather than a row.
   */
  it('bounds the code', () => {
    expect(first('create', { ...minimal, code: 'SIXTEENCHARSXXX0' })['code']).toBe(
      'SIXTEENCHARSXXX0',
    )
    rejects('create', { ...minimal, code: 'x'.repeat(17) })
    rejects('create', { ...minimal, name: 'x'.repeat(101) })
  })

  /*
   * Lower case is a legitimate thing for a screen to send and the repository is what
   * upper-cases it. Asserting the value survives unchanged is the point: a boundary that
   * "helpfully" normalised would put the rule in two places, and the two would drift on
   * the day somebody discovered `кг` (SQLite's upper() leaves it alone; JavaScript's does
   * not — see migration 0006).
   */
  it('leaves the case of a code alone', () => {
    expect(first('create', { code: 'kg', name: 'Kilograms' })['code']).toBe('kg')
    expect(parse('get', 'kg')).toEqual(['kg'])
  })

  /*
   * The other rule the repository leaves here: `decimal_places` is a four-way choice in
   * the UI, so a fifth value is a caller bug. Zero is the interesting end — half a box is
   * not a quantity — and four is refused because three is the storage scale.
   */
  it('bounds the decimal places to what a quantity can hold', () => {
    for (const decimalPlaces of [0, 1, 2, 3]) {
      expect(first('create', { ...minimal, decimalPlaces })['decimalPlaces']).toBe(decimalPlaces)
    }
    rejects('create', { ...minimal, decimalPlaces: 4 })
    rejects('create', { ...minimal, decimalPlaces: -1 })
    rejects('create', { ...minimal, decimalPlaces: 1.5 })
    rejects('create', { ...minimal, decimalPlaces: '3' })
  })

  /* Absent means the repository's default of three, which is a decision it owns. This
   * layer must not invent one, or the default would live in two places. */
  it('does not default the decimal places', () => {
    expect(first('create', minimal)['decimalPlaces']).toBeUndefined()
  })

  /* A business creating BAGS has no idea yet which UQC it reports as. Phase 5 fills it in. */
  it('takes a regime code, or none', () => {
    expect(first('create', { ...minimal, regimeCode: null })['regimeCode']).toBeNull()
    expect(first('create', minimal)['regimeCode']).toBeUndefined()
  })

  it('refuses anything that is not an object', () => {
    rejects('create', 'KGS')
    rejects('create', [minimal])
    rejects('create', undefined)
  })
})

describe('update', () => {
  it('needs the code of the unit being changed', () => {
    rejects('update', { name: 'Kilograms' })
    rejects('update', { code: '' })
    rejects('update', { code: 42 })
  })

  it('leaves absent fields absent', () => {
    const parsed = first('update', { code: 'KGS', name: 'Kilogrammes' })

    expect(parsed['name']).toBe('Kilogrammes')
    expect(parsed['decimalPlaces']).toBeUndefined()
    expect(parsed['regimeCode']).toBeUndefined()
    expect(parsed['isArchived']).toBeUndefined()
  })

  it('passes a null regime code through as a clear', () => {
    expect(first('update', { code: 'KGS', regimeCode: null })['regimeCode']).toBeNull()
  })

  /* A unit with no name is not one, and 0006 CHECKs it. Optional on an update, never
   * nullable — the same rule `parties.update` applies to a party's name. */
  it('refuses to clear the name', () => {
    rejects('update', { code: 'KGS', name: null })
    rejects('update', { code: 'KGS', name: '' })
  })

  it('takes the archive flag as an ordinary field', () => {
    expect(first('update', { code: 'KGS', isArchived: true })['isArchived']).toBe(true)
    rejects('update', { code: 'KGS', isArchived: 'yes' })
  })
})

describe('archive and delete', () => {
  it('narrows an archive, keyed by code', () => {
    expect(parse('archive', { code: 'KGS', archived: true })).toEqual([
      { code: 'KGS', archived: true },
    ])
    expect(parse('archive', { code: 'KGS', archived: false })).toEqual([
      { code: 'KGS', archived: false },
    ])
  })

  /* The difference from every other group in the contract, asserted rather than assumed:
   * a unit is named by its code, so an archive carrying an id names nothing. */
  it('will not take an id where a code belongs', () => {
    rejects('archive', { id: 'KGS', archived: true })
  })

  it('will not guess which way to archive', () => {
    rejects('archive', { code: 'KGS' })
    rejects('archive', { code: 'KGS', archived: 'yes' })
  })

  it('takes a code for get and delete', () => {
    expect(parse('get', 'KGS')).toEqual(['KGS'])
    expect(parse('delete', 'KGS')).toEqual(['KGS'])
    rejects('get', '')
    rejects('get', undefined)
    rejects('delete', 42)
    rejects('delete', 'x'.repeat(17))
  })
})

describe('the envelope', () => {
  it('wraps what the service returns', async () => {
    expect(await handlers.list.handle({})).toEqual({ ok: true, data: [] })
    expect(await handlers.get.handle('KGS')).toEqual({ ok: true, data: null })
  })

  it('wraps a delete that returns nothing', async () => {
    expect(await handlers.delete.handle('KGS')).toEqual({ ok: true, data: undefined })
    expect(service.delete).toHaveBeenCalledWith('KGS')
  })

  it('hands the service exactly what was parsed', async () => {
    await handlers.archive.handle({ code: 'KGS', archived: true })
    expect(service.archive).toHaveBeenCalledWith({ code: 'KGS', archived: true })
  })
})

describe('nothing malformed reaches the service', () => {
  it('refuses every method by name and calls nothing', () => {
    rejects('list', 'everything')
    rejects('get', null)
    rejects('create', { code: 'KGS' })
    rejects('update', {})
    rejects('archive', { code: 'KGS', archived: null })
    rejects('delete', {})

    expect(service.list).not.toHaveBeenCalled()
    expect(service.get).not.toHaveBeenCalled()
    expect(service.create).not.toHaveBeenCalled()
    expect(service.update).not.toHaveBeenCalled()
    expect(service.archive).not.toHaveBeenCalled()
    expect(service.delete).not.toHaveBeenCalled()
  })

  it('never echoes the value it rejected', () => {
    const long = 'BUNDLESOFTENDOZEN'
    expect(() => parse('create', { code: long, name: 'Bundles' })).toThrow(/'code'/)
    expect(() => parse('create', { code: long, name: 'Bundles' })).not.toThrow(/BUNDLES/)
  })
})
