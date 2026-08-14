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
    expect(API_GROUPS).toEqual(['system', 'companies'])
  })

  it('lists the system methods', () => {
    expect(apiMethods('system')).toEqual([
      'getAppInfo',
      'chooseDirectory',
      'chooseBackupArchive',
      'revealInFileManager',
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
})

describe('apiChannels', () => {
  it('derives channels exactly as the renderer proxy does', () => {
    const channels = apiChannels()

    expect(channels).toContain(toChannelName('companies', 'open'))
    expect(channels).toContain(toChannelName('system', 'getAppInfo'))
    expect(channels).toHaveLength(apiMethods('system').length + apiMethods('companies').length)
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
    expect(isApiChannel('ledger:postEntry')).toBe(false)
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
