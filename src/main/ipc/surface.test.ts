import { describe, expect, it } from 'vitest'
import { toChannelName } from '../../shared/ipc'
import {
  API_GROUPS,
  API_SURFACE,
  apiChannels,
  apiMethods,
  isApiChannel,
  isResultEnvelope,
  ok,
} from './surface'

describe('API_SURFACE', () => {
  it('lists every group in the contract', () => {
    expect(API_GROUPS).toEqual([
      'system',
      'companies',
      'ledger',
      'parties',
      'documents',
      'companyProfile',
      'reports',
    ])
  })

  it('lists the system methods', () => {
    expect(apiMethods('system')).toEqual([
      'getAppInfo',
      'chooseDirectory',
      'chooseBackupArchive',
      'chooseCompanyFile',
      'revealInFileManager',
      'setTitleBarOverlay',
    ])
  })

  it('lists the companies methods', () => {
    expect(apiMethods('companies')).toEqual([
      'list',
      'create',
      'open',
      'recover',
      'close',
      'changePassphrase',
      'backup',
      'restore',
      'addExisting',
      'forget',
      'rename',
      'checkPassphrase',
    ])
  })

  it('lists the ledger methods', () => {
    expect(apiMethods('ledger')).toEqual([
      'listAccounts',
      'createAccount',
      'updateAccount',
      'setAccountRole',
      'listPeriods',
      'closePeriod',
      'reopenPeriod',
      'lockPeriod',
      'postEntry',
      'reverseEntry',
      'listEntries',
      'getEntry',
      'trialBalance',
      'postOpeningBalances',
      'closeFiscalYear',
    ])
  })

  it('lists the parties methods', () => {
    expect(apiMethods('parties')).toEqual(['list', 'get', 'create', 'update', 'archive', 'delete'])
  })

  /*
   * A posted entry is immutable (invariant 3) and the database refuses an UPDATE or a
   * DELETE outright. A channel for either would exist only to return an error, and its
   * presence in the contract would suggest to a future reader that one is possible.
   */
  it('offers no way to edit or delete a posted entry', () => {
    const methods: readonly string[] = apiMethods('ledger')

    expect(methods).not.toContain('updateEntry')
    expect(methods).not.toContain('deleteEntry')
    expect(methods).not.toContain('editEntry')
    expect(methods).toContain('reverseEntry')
  })
})

describe('apiChannels', () => {
  it('derives channels exactly as the renderer proxy does', () => {
    const channels = apiChannels()

    expect(channels).toContain(toChannelName('companies', 'open'))
    expect(channels).toContain(toChannelName('system', 'getAppInfo'))
    expect(channels).toContain(toChannelName('ledger', 'postEntry'))
    expect(channels).toContain(toChannelName('reports', 'balanceSheet'))
    expect(channels).toContain(toChannelName('parties', 'create'))

    /* Summed over API_GROUPS rather than over a list of groups written out here. The
     * hand-written version silently stopped covering a group the day one was added,
     * which is the only day it mattered. */
    expect(channels).toHaveLength(
      API_GROUPS.reduce((total, group) => total + apiMethods(group).length, 0),
    )
  })

  it('produces no duplicates', () => {
    const channels = apiChannels()
    expect(new Set(channels).size).toBe(channels.length)
  })

  it('every channel is group:method', () => {
    for (const channel of apiChannels()) {
      const [group, method, ...rest] = channel.split(':')
      expect(rest).toHaveLength(0)
      expect(group).toBeTruthy()
      expect(method).toBeTruthy()
      expect(Object.keys(API_SURFACE)).toContain(group)
    }
  })
})

describe('isApiChannel', () => {
  it('accepts a declared method', () => {
    expect(isApiChannel('companies:backup')).toBe(true)
  })

  it('rejects a method the contract does not declare', () => {
    expect(isApiChannel('companies:deleteEverything')).toBe(false)
  })

  it('rejects an unknown group', () => {
    expect(isApiChannel('inventory:adjustStock')).toBe(false)
  })

  it('accepts a method the ledger group really declares', () => {
    expect(isApiChannel('ledger:postEntry')).toBe(true)
    expect(isApiChannel('ledger:deleteEntry')).toBe(false)
  })

  it('rejects a bare group name', () => {
    expect(isApiChannel('companies')).toBe(false)
  })
})

describe('ok', () => {
  it('wraps a value in a success envelope', () => {
    expect(ok(['a'])).toEqual({ ok: true, data: ['a'] })
  })

  it('keeps `data` present for a void result', () => {
    expect(isResultEnvelope(ok(undefined))).toBe(true)
  })
})

describe('isResultEnvelope', () => {
  it('accepts a success envelope', () => {
    expect(isResultEnvelope({ ok: true, data: null })).toBe(true)
  })

  it('accepts a failure envelope', () => {
    expect(isResultEnvelope({ ok: false, error: { code: 'X', message: 'y' } })).toBe(true)
  })

  it('accepts a failure envelope carrying details', () => {
    const value = { ok: false, error: { code: 'X', message: 'y', details: { field: 'id' } } }
    expect(isResultEnvelope(value)).toBe(true)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'ok'],
    ['a number', 1],
    ['a bare object', {}],
    ['a success with no data key', { ok: true }],
    ['a truthy non-boolean ok', { ok: 1, data: null }],
    ['a failure with no error', { ok: false }],
    ['a failure with a string error', { ok: false, error: 'boom' }],
    ['a failure with no code', { ok: false, error: { message: 'y' } }],
    ['a failure with a non-string code', { ok: false, error: { code: 7, message: 'y' } }],
    ['a failure with no message', { ok: false, error: { code: 'X' } }],
  ])('rejects %s', (_label, value) => {
    expect(isResultEnvelope(value)).toBe(false)
  })
})
