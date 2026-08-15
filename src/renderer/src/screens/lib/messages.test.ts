import { describe, expect, it } from 'vitest'
import { describeFailure, failureDetail, failureTitle, KNOWN_ERROR_CODES } from './messages'

/*
 * The point of these tests is coverage of the *codes*, not of the prose. If the main
 * process grows a code and nobody writes copy for it, the first test here fails long
 * before a user meets an empty error box.
 */

describe('describeFailure', () => {
  it('has copy for every code the main process can send', () => {
    for (const code of KNOWN_ERROR_CODES) {
      const guidance = describeFailure({ code, message: 'main said something' })
      expect(guidance.title.length, code).toBeGreaterThan(0)
      expect(guidance.body.length, code).toBeGreaterThan(0)
    }
  })

  it('never apologises and never says something went wrong', () => {
    const banned = ['something went wrong', 'sorry', 'oops', 'unexpected error', 'unknown error']
    for (const code of KNOWN_ERROR_CODES) {
      const guidance = describeFailure({ code, message: '' })
      const text = `${guidance.title} ${guidance.body}`.toLowerCase()
      for (const phrase of banned) {
        expect(text, `${code} contains "${phrase}"`).not.toContain(phrase)
      }
    }
  })

  it('offers recovery when the passphrase did not fit', () => {
    const guidance = describeFailure({ code: 'PASSPHRASE_INVALID', message: '' }, 'unlock')
    expect(guidance.action).toBe('recover')
    expect(guidance.body).toContain('recovery codes')
  })

  it('says the keys are gone for a missing vault, not that something failed', () => {
    const guidance = describeFailure({ code: 'COMPANY_VAULT_MISSING', message: '' })
    expect(guidance.title.toLowerCase()).toContain('keys')
    expect(guidance.body).toContain('backup')
    expect(guidance.action).toBe('restore')
  })

  it('keeps a missing database and a missing vault apart', () => {
    const database = describeFailure({ code: 'COMPANY_DATABASE_MISSING', message: '' })
    const vault = describeFailure({ code: 'COMPANY_VAULT_MISSING', message: '' })
    expect(database.title).not.toBe(vault.title)
    expect(database.action).toBe('add-existing')
    expect(vault.action).toBe('restore')
  })

  it('distinguishes a mismatched pair from a wrong passphrase', () => {
    const mismatched = describeFailure({ code: 'COMPANY_KEYS_MISMATCHED', message: '' }, 'unlock')
    const wrong = describeFailure({ code: 'PASSPHRASE_INVALID', message: '' }, 'unlock')
    expect(mismatched.title).not.toBe(wrong.title)
    expect(mismatched.body).toContain('does not fit')
  })

  it('reads the current passphrase differently when changing it', () => {
    const unlock = describeFailure({ code: 'PASSPHRASE_INVALID', message: '' }, 'unlock')
    const change = describeFailure({ code: 'PASSPHRASE_INVALID', message: '' }, 'change-passphrase')
    expect(change.title).not.toBe(unlock.title)
    expect(change.body).toContain('Nothing was changed')
  })

  it('falls back to the message main sent for a code it does not know', () => {
    const guidance = describeFailure({
      code: 'SOME_FUTURE_CODE',
      message: 'The ledger is closed for that period. Reopen it first.',
    })
    expect(guidance.body).toBe('The ledger is closed for that period. Reopen it first.')
  })

  it('still says what to do when an unknown code arrives with no message', () => {
    const guidance = describeFailure({ code: 'SOME_FUTURE_CODE', message: '   ' })
    expect(guidance.body).toContain('Try it again')
  })
})

describe('failureDetail', () => {
  it("shows main's own message where it names the file", () => {
    const detail = failureDetail({
      code: 'COMPANY_DATABASE_MISSING',
      message: 'Coffer cannot find D:\\books\\Acme.coffer.',
    })
    expect(detail).toContain('Acme.coffer')
  })

  it('stays quiet for codes whose message adds nothing', () => {
    expect(failureDetail({ code: 'PASSPHRASE_INVALID', message: 'Wrong passphrase.' })).toBeNull()
  })

  it('does not repeat the body back at the reader', () => {
    const guidance = describeFailure({ code: 'COMPANY_IO_FAILED', message: '' })
    expect(failureDetail({ code: 'COMPANY_IO_FAILED', message: guidance.body })).toBeNull()
  })
})

describe('failureTitle', () => {
  it('is the one line a toast can carry', () => {
    expect(failureTitle({ code: 'NO_COMPANY_OPEN', message: '' })).toBe('No company is open.')
  })
})
