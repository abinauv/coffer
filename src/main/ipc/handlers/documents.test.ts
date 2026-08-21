/*
 * The `documents` group's boundary.
 *
 * Same subject as ./parties.test.ts: the renderer is untrusted, so what is tested is what
 * happens to malformed input, and that a rejection never echoes the value back.
 *
 * THE RULE WITH TEETH IS WHAT A LINE MAY NOT CARRY. A renderer that sends a
 * `taxableAmount` or a set of tax components must not have them believed — they are the
 * regime's answer and the regime is asked in main. So the parse drops them, and there is a
 * test that says so by name: a change that widened `DocumentLineInput` to accept either
 * would otherwise pass everything else in this file.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DocumentStatusDto } from '../../../shared/dto'
import { IpcError } from '../errors'
import { createDocumentsHandlers, type DocumentsService } from './documents'

let service: DocumentsService
let handlers: ReturnType<typeof createDocumentsHandlers>

beforeEach(() => {
  service = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
    create: vi.fn(async () => ({}) as never),
    update: vi.fn(async () => ({}) as never),
    delete: vi.fn(async () => undefined),
    issue: vi.fn(async () => ({}) as never),
    cancel: vi.fn(async () => ({}) as never),
  }
  handlers = createDocumentsHandlers(service)
})

const parse = (method: keyof typeof handlers, ...raw: unknown[]): unknown[] =>
  handlers[method].parseArgs(raw)

const first = (method: keyof typeof handlers, ...raw: unknown[]): Record<string, unknown> =>
  parse(method, ...raw)[0] as Record<string, unknown>

const rejects = (method: keyof typeof handlers, ...raw: unknown[]) => {
  expect(() => parse(method, ...raw)).toThrow(IpcError)
}

const LINE = {
  description: 'Ball bearing 6203',
  quantity: '2.000',
  unitPrice: '500.00',
  ratePct: '18',
}

const CREATE = {
  kind: 'sales-invoice',
  date: '2026-04-15',
  partyId: 'party-1',
  lines: [LINE],
}

const linesOf = (input: Record<string, unknown>): Record<string, unknown>[] =>
  input['lines'] as Record<string, unknown>[]

describe('list', () => {
  it('treats a missing argument as no filter', () => {
    expect(parse('list')).toEqual([{}])
    expect(parse('list', null)).toEqual([{}])
  })

  it('narrows the filters it is given', () => {
    expect(
      first('list', { kind: 'sales-invoice', status: 'issued', partyId: 'p1', search: 'INV' }),
    ).toMatchObject({ kind: 'sales-invoice', status: 'issued', partyId: 'p1', search: 'INV' })
  })

  it('refuses a status that is not one', () => {
    rejects('list', { status: 'posted' })
    rejects('list', { status: 1 })
  })

  /* Pinned to the DTO rather than trusted to stay in step — the values are written out in
   * the handler because `expectOneOf` needs them at runtime and a type has none. */
  it('accepts exactly the statuses the contract declares', () => {
    const statuses: DocumentStatusDto[] = ['draft', 'issued', 'cancelled']
    for (const status of statuses) {
      expect(first('list', { status })['status']).toBe(status)
    }
  })

  it('refuses a page it will not allocate', () => {
    rejects('list', { limit: 0 })
    rejects('list', { limit: 5000 })
    rejects('list', { offset: -1 })
  })

  it('refuses a date that is not one', () => {
    rejects('list', { fromDate: '15-04-2026' })
    rejects('list', { toDate: 20260415 })
  })
})

describe('create', () => {
  it('needs an object with a kind, a date and a party', () => {
    rejects('create')
    rejects('create', null)
    rejects('create', { date: '2026-04-15', partyId: 'p1' })
    rejects('create', { kind: 'sales-invoice', partyId: 'p1' })
    rejects('create', { kind: 'sales-invoice', date: '2026-04-15' })
    rejects('create', { ...CREATE, date: 'the fifteenth' })
  })

  it('keeps the lines it is given', () => {
    expect(linesOf(first('create', CREATE))[0]).toMatchObject({
      description: 'Ball bearing 6203',
      quantity: '2.000',
      unitPrice: '500.00',
      ratePct: '18',
    })
  })

  /*
   * THE ASSERTION THIS FILE EXISTS FOR. Both fields are the regime's answer. A renderer
   * that sends them — buggy, or hostile, or a screen somebody wired to the wrong DTO —
   * gets them dropped rather than trusted, and the service asks the regime as it always
   * would. An amount from an untrusted process must never be the amount in the books.
   */
  it('drops a taxable amount and tax components a renderer tries to send', () => {
    const line = linesOf(
      first('create', {
        ...CREATE,
        lines: [
          {
            ...LINE,
            taxableAmount: '1.00',
            taxes: [{ code: 'CGST', label: 'CGST @ 9%', ratePct: '9.000', amount: '0.01' }],
          },
        ],
      }),
    )[0]

    expect(line).not.toHaveProperty('taxableAmount')
    expect(line).not.toHaveProperty('taxes')
  })

  it('refuses a line with no description', () => {
    rejects('create', { ...CREATE, lines: [{ ...LINE, description: '   ' }] })
    rejects('create', { ...CREATE, lines: [{ ...LINE, description: undefined }] })
  })

  it('refuses a figure that is not a decimal string', () => {
    rejects('create', { ...CREATE, lines: [{ ...LINE, quantity: 2 }] })
    rejects('create', { ...CREATE, lines: [{ ...LINE, unitPrice: 'five hundred' }] })
    rejects('create', { ...CREATE, lines: [{ ...LINE, discount: 50 }] })
  })

  it('refuses lines that are not an array, and more than any document has', () => {
    rejects('create', { ...CREATE, lines: 'one line' })
    rejects('create', { ...CREATE, lines: Array.from({ length: 501 }, () => LINE) })
  })

  it('treats an absent place of supply as absent rather than null', () => {
    const input = first('create', CREATE)

    expect(input['placeOfSupplyJurisdiction']).toBeUndefined()
    expect(input['placeOfSupplyCountry']).toBeUndefined()
  })

  it('keeps a place of supply the caller states', () => {
    expect(
      first('create', { ...CREATE, placeOfSupplyJurisdiction: '29', placeOfSupplyCountry: 'in' }),
    ).toMatchObject({ placeOfSupplyJurisdiction: '29', placeOfSupplyCountry: 'in' })
  })

  it('refuses a rounding policy that is not one', () => {
    rejects('create', { ...CREATE, roundingPolicy: 'nearest-rupee' })
    expect(first('create', { ...CREATE, roundingPolicy: 'whole-unit' })['roundingPolicy']).toBe(
      'whole-unit',
    )
  })
})

describe('update', () => {
  it('needs an id', () => {
    rejects('update', {})
    rejects('update', { id: '' })
  })

  /*
   * ABSENT IS NOT NULL here, unlike `companyProfile.save`. An edit that never mentions the
   * lines must leave them alone; one that sends an empty array is clearing them.
   */
  it('leaves out what the caller did not send', () => {
    const input = first('update', { id: 'd1', narration: 'Against PO 4471' })

    expect(input['lines']).toBeUndefined()
    expect(input['date']).toBeUndefined()
    expect(input['partyId']).toBeUndefined()
    expect(input['narration']).toBe('Against PO 4471')
  })

  it('takes an empty set of lines as an instruction to clear them', () => {
    expect(first('update', { id: 'd1', lines: [] })['lines']).toEqual([])
  })

  it('drops a taxable amount here too', () => {
    const line = linesOf(
      first('update', { id: 'd1', lines: [{ ...LINE, taxableAmount: '1.00' }] }),
    )[0]

    expect(line).not.toHaveProperty('taxableAmount')
  })
})

describe('issue and cancel', () => {
  it('issues by id, with an optional series', () => {
    expect(first('issue', { id: 'd1' })).toEqual({ id: 'd1', seriesId: undefined })
    expect(first('issue', { id: 'd1', seriesId: 's1' })['seriesId']).toBe('s1')
    rejects('issue', { seriesId: 's1' })
  })

  it('cancels by id, with an optional date and narration', () => {
    expect(first('cancel', { id: 'd1' })['id']).toBe('d1')
    expect(first('cancel', { id: 'd1', date: '2026-04-20' })['date']).toBe('2026-04-20')
    rejects('cancel', { id: 'd1', date: 'yesterday' })
  })

  it('wraps what the service answers', async () => {
    const document = { id: 'd1', number: 'INV/2026-27/0001' } as never
    service.issue = vi.fn(async () => document)
    handlers = createDocumentsHandlers(service)

    await expect(handlers.issue.handle({ id: 'd1' })).resolves.toEqual({
      ok: true,
      data: document,
    })
  })
})

describe('get and delete', () => {
  it('take an id and nothing else', () => {
    expect(parse('get', 'd1')).toEqual(['d1'])
    expect(parse('delete', 'd1')).toEqual(['d1'])
    rejects('get', '')
    rejects('delete', 42)
  })

  it('answers with an empty envelope after a delete', async () => {
    await expect(handlers.delete.handle('d1')).resolves.toEqual({ ok: true, data: undefined })
    expect(service.delete).toHaveBeenCalledWith('d1')
  })
})

describe('what a rejection says', () => {
  it('never echoes the value back', () => {
    try {
      parse('create', { ...CREATE, narration: 'super-secret'.repeat(200) })
      expect.unreachable('the parse should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(IpcError)
      expect((error as IpcError).message).not.toContain('super-secret')
      expect((error as IpcError).message).toContain('narration')
    }
  })

  it('says which line it was unhappy with', () => {
    try {
      parse('create', { ...CREATE, lines: [LINE, { ...LINE, quantity: 'two' }] })
      expect.unreachable('the parse should have thrown')
    } catch (error) {
      expect((error as IpcError).message).toContain('lines[1].quantity')
    }
  })
})
