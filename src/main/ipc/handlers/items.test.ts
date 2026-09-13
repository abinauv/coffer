/*
 * The `items` group's boundary.
 *
 * Same subject as ./parties.test.ts: the renderer is untrusted, so what is tested is what
 * happens to malformed input — that every method refuses it by name rather than passing
 * it to a service, and that a rejection never echoes the value back.
 *
 * TWO RULES WITH TEETH HERE. ABSENT IS NOT NULL, as it is for a party: an update that
 * never mentions the sale price must leave it alone and one that sends `null` must clear
 * it, and collapsing the two makes a screen that edits a name wipe the price. And NULL IS
 * NOT ZERO: no standard price agreed and a price of nothing are different answers, and the
 * second is a real one — a sample, a warranty replacement, a line that prints to show what
 * was supplied.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT TEST is whether a classification code is real.
 * That is the regime's question, asked in the service, and ../../items/service.test.ts is
 * where it is proved. The assertion here is the opposite one: that a bad code gets PAST
 * this layer, because collapsing it into 'INVALID_ARGUMENT' would throw away the sentence
 * the regime has written for the user.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ItemKind, ItemSide } from '../../../shared/dto'
import { IpcError } from '../errors'
import { createItemsHandlers, type ItemsService } from './items'

let service: ItemsService
let handlers: ReturnType<typeof createItemsHandlers>

beforeEach(() => {
  service = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
    create: vi.fn(async () => ({}) as never),
    update: vi.fn(async () => ({}) as never),
    archive: vi.fn(async () => ({}) as never),
    delete: vi.fn(async () => undefined),
  }
  handlers = createItemsHandlers(service)
})

/** Parse a call's raw arguments as the transport would. */
const parse = (method: keyof typeof handlers, ...raw: unknown[]): unknown[] =>
  handlers[method].parseArgs(raw)

const first = (method: keyof typeof handlers, ...raw: unknown[]): Record<string, unknown> =>
  parse(method, ...raw)[0] as Record<string, unknown>

const rejects = (method: keyof typeof handlers, ...raw: unknown[]) => {
  expect(() => parse(method, ...raw)).toThrow(IpcError)
}

const minimal = { name: 'Ball bearing 6203', kind: 'goods' }

describe('list', () => {
  it('treats a missing argument as no filter', () => {
    expect(parse('list')).toEqual([{}])
    expect(parse('list', null)).toEqual([{}])
  })

  it('narrows the filters it is given', () => {
    expect(
      parse('list', { includeArchived: true, side: 'purchased', kind: 'service', search: 'bear' }),
    ).toEqual([{ includeArchived: true, side: 'purchased', kind: 'service', search: 'bear' }])
  })

  it('refuses a side that is not one', () => {
    rejects('list', { side: 'bought' })
    rejects('list', { side: 1 })
  })

  it('refuses a kind that is not one', () => {
    rejects('list', { kind: 'stock' })
    rejects('list', { kind: true })
  })

  /* Pinned to the DTOs rather than trusted to stay in step — the values are written out
   * in the handler because `expectOneOf` needs them at runtime and a type has none. */
  it('accepts exactly the sides and kinds the contract declares', () => {
    const sides: ItemSide[] = ['sold', 'purchased']
    for (const side of sides) {
      expect(parse('list', { side })).toEqual([{ side }])
    }

    const kinds: ItemKind[] = ['goods', 'service']
    for (const kind of kinds) {
      expect(parse('list', { kind })).toEqual([{ kind }])
    }
  })
})

describe('create', () => {
  it('narrows an item', () => {
    expect(first('create', { ...minimal, code: 'BB-6203', unitCode: 'NOS' })).toMatchObject({
      name: 'Ball bearing 6203',
      kind: 'goods',
      code: 'BB-6203',
      unitCode: 'NOS',
    })
  })

  it('needs a name and a kind', () => {
    rejects('create', { kind: 'goods' })
    rejects('create', { name: 'Ball bearing 6203' })
    rejects('create', { ...minimal, name: '' })
    rejects('create', { ...minimal, name: 'x'.repeat(600) })
    rejects('create', { ...minimal, kind: 'widget' })
  })

  it('refuses anything that is not an object', () => {
    rejects('create', 'Ball bearing 6203')
    rejects('create', [minimal])
    rejects('create', undefined)
  })

  /*
   * An item is sold, purchased, or both, and the repository is what refuses one that is
   * neither. What matters here is that the boundary does not INVENT an answer: a form
   * that forgot the flags would otherwise quietly produce sellable items, and nobody
   * notices until a purchase picker is empty.
   */
  it('does not default the sides', () => {
    const parsed = first('create', minimal)
    expect(parsed['isSold']).toBeUndefined()
    expect(parsed['isPurchased']).toBeUndefined()
    expect(parsed['isCharge']).toBeUndefined()
  })

  /* Money crosses as text or not at all (CONVENTIONS §1.1). Whole rupees are legitimate
   * text and are normalised to two places by the repository, so '5000' is accepted and
   * 5000 is not. */
  it('refuses a price sent as a number', () => {
    expect(() => parse('create', { ...minimal, salePrice: 5000 })).toThrow(/must be text/)
    expect(() => parse('create', { ...minimal, purchasePrice: 4000.5 })).toThrow(/must be text/)
    expect(first('create', { ...minimal, salePrice: '5000' })['salePrice']).toBe('5000')
    rejects('create', { ...minimal, salePrice: 'five thousand' })
  })

  /*
   * A rate is not money and is refused as a number for a different reason: India's 0.25%
   * slab halves into 0.125%, so a rate that has been through a JS number can already be
   * wrong in the third place the tax was computed from.
   */
  it('refuses a tax rate sent as a number', () => {
    expect(() => parse('create', { ...minimal, taxRatePct: 18 })).toThrow(/must be text/)
    expect(first('create', { ...minimal, taxRatePct: '0.125' })['taxRatePct']).toBe('0.125')
  })

  /* Null is not '0.00'. Nothing agreed, versus agreed at nothing — a free issue. */
  it('takes a price of nothing, and no price at all', () => {
    expect(first('create', { ...minimal, salePrice: '0.00' })['salePrice']).toBe('0.00')
    expect(first('create', { ...minimal, salePrice: null })['salePrice']).toBeNull()
    expect(first('create', minimal)['salePrice']).toBeUndefined()
  })

  /* Whether it is a real HSN is the regime's question, asked in the service. This layer
   * only sees text — see the header note on why that is not laziness. */
  it('does not judge a classification code', () => {
    expect(first('create', { ...minimal, classificationCode: '99' })).toMatchObject({
      classificationCode: '99',
    })
    expect(first('create', { ...minimal, classificationCode: 'not a code' })).toMatchObject({
      classificationCode: 'not a code',
    })
  })
})

describe('update', () => {
  it('needs an id', () => {
    rejects('update', { name: 'Ball bearing 6203' })
    rejects('update', { id: '' })
    rejects('update', { id: 42 })
  })

  it('leaves absent fields absent', () => {
    const parsed = first('update', { id: 'i1', name: 'Ball bearing 6203 ZZ' })

    expect(parsed['name']).toBe('Ball bearing 6203 ZZ')
    for (const field of [
      'code',
      'description',
      'unitCode',
      'classificationCode',
      'taxRatePct',
      'salePrice',
      'purchasePrice',
      'salesAccountId',
      'purchaseAccountId',
      'isStockTracked',
      'reorderLevel',
      'kind',
    ]) {
      expect(parsed[field]).toBeUndefined()
    }
  })

  /*
   * THE FIELDS THE STOCK BATCH WITHHELD, now that both ends of them exist. Their absence
   * from `parseOptionalFields` would not have failed a typecheck — every field there is
   * optional, so a parser that dropped them still satisfies `Omit<CreateItemInput, …>` —
   * and the renderer would have had a DTO field it could set and nothing would carry.
   * That is the same "looks as though it works" the stock batch refused to ship, one
   * layer up, which is why it is asserted rather than assumed.
   */
  it('carries the stock fields across, and does not invent them', () => {
    const parsed = first('update', { id: 'i1', isStockTracked: true, reorderLevel: '25.000' })

    expect(parsed['isStockTracked']).toBe(true)
    expect(parsed['reorderLevel']).toBe('25.000')

    /* Null clears the level; a quantity sent as a number is refused like any other
     * decimal on this boundary. */
    expect(first('update', { id: 'i1', reorderLevel: null })['reorderLevel']).toBeNull()
    expect(() => parse('update', { id: 'i1', reorderLevel: 25 })).toThrow(/must be text/)
    expect(() => parse('update', { id: 'i1', isStockTracked: 'yes' })).toThrow()
  })

  it('passes null through as a clear', () => {
    const parsed = first('update', {
      id: 'i1',
      code: null,
      salePrice: null,
      classificationCode: null,
      unitCode: null,
    })
    expect(parsed['code']).toBeNull()
    expect(parsed['salePrice']).toBeNull()
    expect(parsed['classificationCode']).toBeNull()
    expect(parsed['unitCode']).toBeNull()
  })

  /* An item with no name is not an item, and a thing that is neither goods nor a service
   * classifies as nothing. Both are optional on an update and neither may be cleared. */
  it('refuses to clear the name or the kind', () => {
    rejects('update', { id: 'i1', name: null })
    rejects('update', { id: 'i1', name: '' })
    rejects('update', { id: 'i1', kind: null })
    rejects('update', { id: 'i1', kind: 'widget' })
  })
})

describe('archive and delete', () => {
  it('narrows an archive', () => {
    expect(parse('archive', { id: 'i1', archived: true })).toEqual([{ id: 'i1', archived: true }])
    expect(parse('archive', { id: 'i1', archived: false })).toEqual([{ id: 'i1', archived: false }])
  })

  it('will not guess which way to archive', () => {
    rejects('archive', { id: 'i1' })
    rejects('archive', { id: 'i1', archived: 'yes' })
    rejects('archive', { archived: true })
  })

  it('takes an id for get and delete', () => {
    expect(parse('get', 'i1')).toEqual(['i1'])
    expect(parse('delete', 'i1')).toEqual(['i1'])
    rejects('get', '')
    rejects('get', undefined)
    rejects('delete', 42)
  })
})

describe('the envelope', () => {
  it('wraps what the service returns', async () => {
    expect(await handlers.list.handle({})).toEqual({ ok: true, data: [] })
    expect(await handlers.get.handle('i1')).toEqual({ ok: true, data: null })
  })

  /* A delete answers with nothing, and nothing still has to arrive inside an envelope —
   * the renderer's whole error story rests on it always being there. */
  it('wraps a delete that returns nothing', async () => {
    expect(await handlers.delete.handle('i1')).toEqual({ ok: true, data: undefined })
    expect(service.delete).toHaveBeenCalledWith('i1')
  })

  it('hands the service exactly what was parsed', async () => {
    await handlers.archive.handle({ id: 'i1', archived: true })
    expect(service.archive).toHaveBeenCalledWith({ id: 'i1', archived: true })
  })
})

/*
 * The whole point of a boundary test: a malformed call must be a refusal that names the
 * field, not something the service is asked to deal with. Every method, because the audit
 * found four of five `reports` methods with no boundary test at all.
 */
describe('nothing malformed reaches the service', () => {
  it('refuses every method by name and calls nothing', () => {
    rejects('list', 'everything')
    rejects('get', null)
    rejects('create', { kind: 'goods' })
    rejects('update', {})
    rejects('archive', { id: 'i1', archived: null })
    rejects('delete', {})

    expect(service.list).not.toHaveBeenCalled()
    expect(service.get).not.toHaveBeenCalled()
    expect(service.create).not.toHaveBeenCalled()
    expect(service.update).not.toHaveBeenCalled()
    expect(service.archive).not.toHaveBeenCalled()
    expect(service.delete).not.toHaveBeenCalled()
  })

  /* A rejected argument may be anything the user typed. The message names the field and
   * describes what was expected, and that is all. */
  it('never echoes the value it rejected', () => {
    expect(() => parse('create', { ...minimal, salePrice: 'seventeen rupees' })).toThrow(
      /'salePrice'/,
    )
    expect(() => parse('create', { ...minimal, salePrice: 'seventeen rupees' })).not.toThrow(
      /seventeen/,
    )
  })
})
