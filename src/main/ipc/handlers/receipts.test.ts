/*
 * The `receipts` group's boundary.
 *
 * Same subject as ./documents.test.ts: the renderer is untrusted, so what is tested is
 * what happens to malformed input and that a rejection never echoes the value back.
 *
 * THE RULE WITH TEETH HERE IS THE OPPOSITE OF THE DOCUMENTS ONE, and that is worth a test
 * saying so by name. A document line's `taxableAmount` is DROPPED, because it is the
 * regime's answer and an untrusted process must not supply one. A receipt's amount is
 * KEPT, because it is what the user read off a bank statement and there is nothing to
 * derive it from. Someone tidying the two boundaries into one shape would break one of
 * them, and the test below is what would stop them.
 *
 * THE SECOND ONE IS `allocate` REQUIRING ITS LIST. On a create an absent list means "not
 * matched yet"; on an allocate it would mean "un-match everything", which is a decision.
 * A malformed payload must not make that decision.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ReceiptStatusDto } from '../../../shared/dto'
import { IpcError } from '../errors'
import { createReceiptsHandlers, type ReceiptsService } from './receipts'

let service: ReceiptsService
let handlers: ReturnType<typeof createReceiptsHandlers>

beforeEach(() => {
  service = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
    create: vi.fn(async () => ({}) as never),
    allocate: vi.fn(async () => ({}) as never),
    cancel: vi.fn(async () => ({}) as never),
    settlement: vi.fn(async () => ({}) as never),
    open: vi.fn(async () => []),
  }
  handlers = createReceiptsHandlers(service)
})

const parse = (method: keyof typeof handlers, ...raw: unknown[]): unknown[] =>
  handlers[method].parseArgs(raw)

const first = (method: keyof typeof handlers, ...raw: unknown[]): Record<string, unknown> =>
  parse(method, ...raw)[0] as Record<string, unknown>

const rejects = (method: keyof typeof handlers, ...raw: unknown[]) => {
  expect(() => parse(method, ...raw)).toThrow(IpcError)
}

const CREATE = {
  kind: 'receipt',
  date: '2026-04-20',
  partyId: 'party-1',
  amount: '1180.00',
  accountId: 'account-1',
}

describe('create', () => {
  it('takes a receipt the renderer sent', () => {
    expect(first('create', CREATE)).toEqual({
      kind: 'receipt',
      date: '2026-04-20',
      partyId: 'party-1',
      amount: '1180.00',
      accountId: 'account-1',
      reference: undefined,
      narration: undefined,
      seriesId: undefined,
      allocations: undefined,
    })
  })

  /*
   * The amount CROSSES, and this test is the reason. `documents` drops `taxableAmount`
   * because it is the tax — an answer the regime gives, which an untrusted process must
   * never supply. This is what the user typed off a statement, and no layer below can
   * work it out for them. Every rule about it is enforced deeper, where the figures it
   * has to agree with are.
   */
  it('keeps the amount, unlike a document line, because it is an input and not an answer', () => {
    expect(first('create', { ...CREATE, amount: '999.50' })['amount']).toBe('999.50')
  })

  it('takes the allocations, when there are any', () => {
    const input = first('create', {
      ...CREATE,
      allocations: [{ documentId: 'doc-1', amount: '180.00' }],
    })
    expect(input['allocations']).toEqual([{ documentId: 'doc-1', amount: '180.00' }])
  })

  /* Money nobody has matched yet, which is an ordinary thing to record. */
  it('leaves the allocations absent when the renderer sent none', () => {
    expect(first('create', CREATE)['allocations']).toBeUndefined()
  })

  it('refuses a missing kind, party, account, date or amount', () => {
    for (const field of ['kind', 'partyId', 'accountId', 'date', 'amount']) {
      rejects('create', { ...CREATE, [field]: undefined })
      rejects('create', { ...CREATE, [field]: '' })
    }
  })

  it('refuses an amount that is not a decimal string', () => {
    rejects('create', { ...CREATE, amount: 1180 })
    rejects('create', { ...CREATE, amount: 'lots' })
    rejects('create', { ...CREATE, amount: null })
  })

  it('refuses a date that is not a date', () => {
    rejects('create', { ...CREATE, date: '20-04-2026' })
    rejects('create', { ...CREATE, date: 'yesterday' })
  })

  it('refuses an allocation with no document or no amount', () => {
    rejects('create', { ...CREATE, allocations: [{ amount: '10.00' }] })
    rejects('create', { ...CREATE, allocations: [{ documentId: 'doc-1' }] })
    rejects('create', { ...CREATE, allocations: ['doc-1'] })
  })

  it('refuses more allocations than any real receipt carries', () => {
    const many = Array.from({ length: 501 }, () => ({ documentId: 'doc-1', amount: '1.00' }))
    rejects('create', { ...CREATE, allocations: many })
  })

  it('refuses a reference or a narration longer than the bound', () => {
    rejects('create', { ...CREATE, reference: 'x'.repeat(201) })
    rejects('create', { ...CREATE, narration: 'x'.repeat(1001) })
  })

  it('refuses anything that is not a record at all', () => {
    rejects('create', undefined)
    rejects('create', 'a receipt')
    rejects('create', [])
  })

  /* A rejection says which field and never what was in it: an IPC error reaches a log
   * and a screen, and the value may be somebody's bank reference (CONVENTIONS §5). */
  it('names the field and never echoes the value', () => {
    try {
      parse('create', { ...CREATE, amount: 'sekrit-value-42' })
      expect.unreachable('a bad amount should be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(IpcError)
      expect((error as IpcError).message).toContain('amount')
      expect((error as IpcError).message).not.toContain('sekrit-value-42')
    }
  })
})

describe('allocate', () => {
  it('takes the whole set', () => {
    expect(
      first('allocate', {
        id: 'r-1',
        allocations: [{ documentId: 'doc-1', amount: '180.00' }],
      }),
    ).toEqual({ id: 'r-1', allocations: [{ documentId: 'doc-1', amount: '180.00' }] })
  })

  /* An empty list is how everything is un-allocated, so it has to be accepted. */
  it('takes an empty list, which is how money goes back on account', () => {
    expect(first('allocate', { id: 'r-1', allocations: [] })['allocations']).toEqual([])
  })

  /*
   * REQUIRED, where a create's is optional, and the difference is the whole meaning. An
   * absent list on a create is "nobody has matched it yet"; an absent list here would be
   * "un-match everything", which is a decision a malformed payload must not take.
   */
  it('refuses an absent list rather than treating it as un-allocate everything', () => {
    rejects('allocate', { id: 'r-1' })
    rejects('allocate', { id: 'r-1', allocations: null })
  })

  it('refuses a receipt with no id', () => {
    rejects('allocate', { allocations: [] })
    rejects('allocate', { id: '', allocations: [] })
  })
})

describe('cancel', () => {
  it('takes an id, and a date and a narration when they are given', () => {
    expect(first('cancel', { id: 'r-1' })).toEqual({
      id: 'r-1',
      date: undefined,
      narration: undefined,
    })
    expect(first('cancel', { id: 'r-1', date: '2026-04-25', narration: 'Bounced' })).toEqual({
      id: 'r-1',
      date: '2026-04-25',
      narration: 'Bounced',
    })
  })

  it('refuses a cancel with no id', () => {
    rejects('cancel', {})
    rejects('cancel', { id: 42 })
  })
})

describe('list', () => {
  it('defaults to everything when the renderer sends nothing', () => {
    expect(parse('list')).toEqual([{}])
    expect(parse('list', null)).toEqual([{}])
  })

  it('takes every filter the contract offers', () => {
    expect(
      first('list', {
        kind: 'payment',
        status: 'cancelled',
        partyId: 'party-1',
        fromDate: '2026-04-01',
        toDate: '2026-04-30',
        search: 'UTR',
        limit: 25,
        offset: 50,
      }),
    ).toMatchObject({ kind: 'payment', status: 'cancelled', limit: 25, offset: 50 })
  })

  it('refuses a status that is not one of the two', () => {
    rejects('list', { status: 'draft' })
    rejects('list', { status: 'issued' })
  })

  /* `RECEIPT_STATUSES` is a runtime copy of a type, so this is what pins the two
   * together — the same guard ./documents.test.ts keeps over its own list. */
  it('accepts exactly the statuses the DTO declares', () => {
    const statuses: readonly ReceiptStatusDto[] = ['posted', 'cancelled']
    for (const status of statuses) {
      expect(first('list', { status })['status']).toBe(status)
    }
  })

  it('refuses a page larger than the bound, and an offset below zero', () => {
    rejects('list', { limit: 501 })
    rejects('list', { limit: 0 })
    rejects('list', { offset: -1 })
  })
})

describe('settlement and open', () => {
  it('takes a document id', () => {
    expect(parse('settlement', 'doc-1')).toEqual(['doc-1'])
  })

  it('refuses a settlement with no document', () => {
    rejects('settlement', undefined)
    rejects('settlement', '')
  })

  it('takes a party, a kind, and the receipt being edited', () => {
    expect(first('open', { partyId: 'party-1', kind: 'receipt', exceptReceiptId: 'r-1' })).toEqual({
      partyId: 'party-1',
      kind: 'receipt',
      exceptReceiptId: 'r-1',
    })
  })

  it('leaves the exception absent when there is none', () => {
    expect(
      first('open', { partyId: 'party-1', kind: 'receipt' })['exceptReceiptId'],
    ).toBeUndefined()
  })

  it('refuses an open with no party or no kind', () => {
    rejects('open', { kind: 'receipt' })
    rejects('open', { partyId: 'party-1' })
  })
})

describe('the group as a whole', () => {
  it('passes what it parsed straight to the service', async () => {
    await handlers.create.handle(CREATE as never)
    expect(service.create).toHaveBeenCalledWith(CREATE)
  })

  /*
   * There is no `issue` and no `delete`, and both absences are the contract. A receipt
   * posts the moment it is created, so there is no draft to issue; a number handed out is
   * never released, so there is nothing to delete. A channel for either would exist only
   * to return an error while suggesting to the next reader that one is possible — the
   * same assertion the `ledger` group keeps about `updateEntry`.
   */
  it('offers no way to issue a receipt or to delete one', () => {
    expect(Object.keys(handlers).sort()).toEqual([
      'allocate',
      'cancel',
      'create',
      'get',
      'list',
      'open',
      'settlement',
    ])
  })
})
