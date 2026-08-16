/*
 * The `ledger` group's boundary.
 *
 * The renderer is untrusted, so what is tested here is what happens to malformed input:
 * every method's arguments are narrowed before the service sees them, and a rejection
 * never echoes the value. What the service then does with a well-formed call is the
 * repositories' business and is tested against a real database elsewhere.
 *
 * The one rule with teeth: AMOUNTS ARE TEXT. A renderer that sends 12.34 as a JS number
 * must be refused here rather than three layers down, because by then it is a Decimal
 * built from a value that could not represent the amount exactly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { IpcError } from '../errors'
import { createLedgerHandlers, type LedgerService } from './ledger'

let service: LedgerService
let handlers: ReturnType<typeof createLedgerHandlers>

beforeEach(() => {
  service = {
    listAccounts: vi.fn(async () => []),
    createAccount: vi.fn(async () => ({}) as never),
    updateAccount: vi.fn(async () => ({}) as never),
    setAccountRole: vi.fn(async () => undefined),
    listPeriods: vi.fn(async () => []),
    closePeriod: vi.fn(async () => ({}) as never),
    reopenPeriod: vi.fn(async () => ({}) as never),
    lockPeriod: vi.fn(async () => ({}) as never),
    postEntry: vi.fn(async () => ({}) as never),
    reverseEntry: vi.fn(async () => ({}) as never),
    listEntries: vi.fn(async () => []),
    getEntry: vi.fn(async () => null),
    trialBalance: vi.fn(async () => ({}) as never),
    postOpeningBalances: vi.fn(async () => ({}) as never),
    closeFiscalYear: vi.fn(async () => ({}) as never),
  }
  handlers = createLedgerHandlers(service)
})

/** Parse a call's raw arguments as the transport would. */
const parse = (method: keyof typeof handlers, ...raw: unknown[]): unknown[] =>
  handlers[method].parseArgs(raw)

const rejects = (method: keyof typeof handlers, ...raw: unknown[]) => {
  expect(() => parse(method, ...raw)).toThrow(IpcError)
}

describe('optional arguments', () => {
  it('treats a missing argument as no filter', () => {
    expect(parse('listAccounts')).toEqual([{}])
    expect(parse('listEntries')).toEqual([{}])
    expect(parse('trialBalance')).toEqual([{}])
  })

  it('narrows the filters it is given', () => {
    expect(parse('listAccounts', { includeArchived: true })).toEqual([{ includeArchived: true }])
    expect(parse('trialBalance', { fromDate: '2026-04-01', toDate: '2027-03-31' })).toEqual([
      { fromDate: '2026-04-01', toDate: '2027-03-31' },
    ])
  })

  it('refuses a filter of the wrong type', () => {
    rejects('listAccounts', { includeArchived: 'yes' })
    rejects('trialBalance', { fromDate: 20260401 })
    rejects('listEntries', { limit: 0 })
    rejects('listEntries', { limit: 100_000 })
    rejects('listEntries', { limit: 12.5 })
  })
})

describe('accounts', () => {
  it('narrows a create', () => {
    expect(
      parse('createAccount', {
        code: '1250',
        name: 'Petty Cash',
        type: 'asset',
        parentId: null,
        isGroup: false,
      }),
    ).toEqual([
      {
        code: '1250',
        name: 'Petty Cash',
        type: 'asset',
        parentId: null,
        isGroup: false,
        description: null,
      },
    ])
  })

  it('refuses an account type the contract does not have', () => {
    const create = (type: unknown) => () =>
      parse('createAccount', { code: '1', name: 'x', type, parentId: null, isGroup: false })

    expect(create('revenue')).toThrow(/must be one of/)
    expect(create('')).toThrow(IpcError)
    expect(create(null)).toThrow(IpcError)
  })

  /*
   * `type` is absent from `UpdateAccountInput` on purpose: every figure already posted
   * was classified by it. A renderer that sends one is ignored rather than obeyed.
   */
  it('drops a type sent on an update', () => {
    const [parsed] = parse('updateAccount', { id: 'a1', name: 'Renamed', type: 'income' })

    expect(parsed).not.toHaveProperty('type')
    expect(parsed).toMatchObject({ id: 'a1', name: 'Renamed' })
  })

  it('distinguishes an absent parentId from an explicit null', () => {
    const [absent] = parse('updateAccount', { id: 'a1' }) as [{ parentId?: string | null }]
    const [cleared] = parse('updateAccount', { id: 'a1', parentId: null }) as [
      { parentId?: string | null },
    ]

    expect(absent.parentId).toBeUndefined()
    expect(cleared.parentId).toBeNull()
  })

  it('lets an empty account id clear a role', () => {
    expect(parse('setAccountRole', { role: 'cash', accountId: '' })).toEqual([
      { role: 'cash', accountId: '' },
    ])
    rejects('setAccountRole', { role: '', accountId: 'a1' })
  })
})

describe('posting', () => {
  const line = (over: Record<string, unknown> = {}) => ({
    accountId: 'a1',
    debit: '100.00',
    credit: '0.00',
    ...over,
  })

  it('narrows an entry', () => {
    const [parsed] = parse('postEntry', {
      date: '2026-04-15',
      narration: 'Sale',
      lines: [line(), line({ accountId: 'a2', debit: '0.00', credit: '100.00' })],
    }) as [{ lines: unknown[] }]

    expect(parsed.lines).toHaveLength(2)
  })

  /* The rule with teeth. A JS number cannot represent 12.34 exactly, and everything
   * below this line assumes the amount arrived as text. */
  it('refuses an amount sent as a number', () => {
    const post = (debit: unknown) => () =>
      parse('postEntry', { date: '2026-04-15', narration: 'x', lines: [line({ debit })] })

    /* A number never gets as far as the decimal check — it is not text at all, which is
     * the more direct thing to tell whoever sent it. */
    expect(post(100)).toThrow(/must be text/)
    expect(post(100.5)).toThrow(/must be text/)

    /* Text that is not a decimal fails on the shape. '1e5' is the one worth naming:
     * `Number('1e5')` is a perfectly good 100000, and every layer below here would have
     * accepted a value the storage format cannot round-trip. */
    expect(post('1e5')).toThrow(/decimal amount as text/)
    expect(post('one hundred')).toThrow(/decimal amount as text/)
    expect(post('100,00')).toThrow(/decimal amount as text/)
    expect(post('')).toThrow(IpcError)
  })

  it('accepts a negative amount as text, and lets the domain refuse it', () => {
    /* NEGATIVE_AMOUNT is a ledger error with its own sentence. Collapsing it into
     * INVALID_ARGUMENT here would tell the user nothing about which line to fix. */
    expect(() =>
      parse('postEntry', { date: '2026-04-15', narration: 'x', lines: [line({ debit: '-1.00' })] }),
    ).not.toThrow()
  })

  it('refuses a date that is not YYYY-MM-DD', () => {
    const post = (date: unknown) => () =>
      parse('postEntry', { date, narration: 'x', lines: [line()] })

    expect(post('15/04/2026')).toThrow(/YYYY-MM-DD/)
    expect(post('2026-4-15')).toThrow(IpcError)
    expect(post(20260415)).toThrow(IpcError)
  })

  it('refuses more lines than any real journal has', () => {
    const lines = Array.from({ length: 501 }, () => line())
    rejects('postEntry', { date: '2026-04-15', narration: 'x', lines })
  })

  it('refuses lines that are not a list', () => {
    rejects('postEntry', { date: '2026-04-15', narration: 'x', lines: 'none' })
    rejects('postEntry', { date: '2026-04-15', narration: 'x' })
  })

  it('narrows a reversal', () => {
    expect(
      parse('reverseEntry', { entryId: 'e1', date: '2026-05-01', narration: 'Cancelled' }),
    ).toEqual([{ entryId: 'e1', date: '2026-05-01', narration: 'Cancelled' }])
    rejects('reverseEntry', { entryId: '', date: '2026-05-01', narration: 'x' })
  })
})

describe('opening balances and the year end', () => {
  it('narrows opening balances', () => {
    expect(
      parse('postOpeningBalances', {
        date: '2026-04-01',
        lines: [{ accountId: 'a1', amount: '-500.00' }],
      }),
    ).toEqual([{ date: '2026-04-01', lines: [{ accountId: 'a1', amount: '-500.00' }] }])
  })

  it('refuses an opening balance sent as a number', () => {
    rejects('postOpeningBalances', {
      date: '2026-04-01',
      lines: [{ accountId: 'a1', amount: 500 }],
    })
  })

  it('bounds the fiscal year', () => {
    expect(parse('closeFiscalYear', { startYear: 2026 })).toEqual([{ startYear: 2026 }])
    rejects('closeFiscalYear', { startYear: 1200 })
    rejects('closeFiscalYear', { startYear: 99999 })
    rejects('closeFiscalYear', { startYear: '2026' })
  })
})

describe('period ids', () => {
  it('requires one', () => {
    for (const method of ['closePeriod', 'reopenPeriod', 'lockPeriod', 'getEntry'] as const) {
      expect(parse(method, 'p1')).toEqual(['p1'])
      rejects(method, '')
      rejects(method, undefined)
      rejects(method, 42)
    }
  })
})

describe('the envelope', () => {
  it('wraps a result and calls the service once', async () => {
    const result = await handlers.listAccounts.handle({})

    expect(result).toEqual({ ok: true, data: [] })
    expect(service.listAccounts).toHaveBeenCalledTimes(1)
  })

  it('wraps a void method as ok(undefined)', async () => {
    await expect(
      handlers.setAccountRole.handle({ role: 'cash', accountId: 'a1' }),
    ).resolves.toEqual({ ok: true, data: undefined })
  })

  it('never echoes the value it rejected', () => {
    try {
      parse('postEntry', {
        date: '2026-04-15',
        narration: 'x',
        lines: [{ accountId: 'a1', debit: 'a-secret-looking-string', credit: '0.00' }],
      })
      throw new Error('expected a rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(IpcError)
      expect((error as IpcError).message).not.toContain('a-secret-looking-string')
    }
  })
})
