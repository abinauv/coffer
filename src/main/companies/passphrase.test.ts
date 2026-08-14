import { describe, expect, it } from 'vitest'

import { scorePassphrase } from './passphrase'

/** Every field of the DTO, checked for shape rather than for a particular verdict. */
function assertWellFormed(passphrase: string): void {
  const strength = scorePassphrase(passphrase)
  expect([0, 1, 2, 3, 4]).toContain(strength.score)
  expect(strength.label.length).toBeGreaterThan(0)
  expect(typeof strength.isWeak).toBe('boolean')
  if (strength.suggestion !== null) {
    expect(strength.suggestion.length).toBeGreaterThan(0)
    /* A suggestion that quotes the passphrase back is a passphrase in a log file. */
    if (passphrase.trim().length >= 4) {
      expect(strength.suggestion).not.toContain(passphrase)
    }
  }
}

describe('scorePassphrase', () => {
  it('answers for anything at all, including the things a text box actually receives', () => {
    for (const value of [
      '',
      ' ',
      '\n\t',
      'a',
      '🙂🙂🙂🙂',
      'ünïcödé påssphrase with accents',
      'x'.repeat(100_000),
      'a b c d e f g h i j k l m n o p',
    ]) {
      assertWellFormed(value)
    }
  })

  it('rates an empty passphrase at zero and says what to do', () => {
    const strength = scorePassphrase('')
    expect(strength.score).toBe(0)
    expect(strength.isWeak).toBe(true)
    expect(strength.suggestion).toMatch(/word/i)
  })

  it('rates the passwords everybody picks as weak, dressed up or not', () => {
    for (const value of ['password', 'Password1!', 'p@ssw0rd', 'qwerty', 'letmein123', 'coffer']) {
      const strength = scorePassphrase(value)
      expect(strength.isWeak).toBe(true)
      expect(strength.score).toBeLessThanOrEqual(1)
    }
  })

  it('is not fooled by length alone when the length is one character repeated', () => {
    const strength = scorePassphrase('aaaaaaaaaaaaaaaaaaaaaaaa')
    expect(strength.isWeak).toBe(true)
    expect(strength.suggestion).not.toBeNull()
  })

  it('marks keyboard and alphabet runs down', () => {
    expect(scorePassphrase('qwertyuiopasdfgh').isWeak).toBe(true)
    expect(scorePassphrase('abcdefghijklmnopqr').isWeak).toBe(true)
    expect(scorePassphrase('123456789012345678').isWeak).toBe(true)
  })

  it('holds short passphrases below the warning threshold however complicated they are', () => {
    const strength = scorePassphrase('Tr0&b4d!')
    expect(strength.isWeak).toBe(true)
    expect(strength.suggestion).toMatch(/longer/i)
  })

  it('rates a real passphrase as strong and has nothing to suggest', () => {
    const strength = scorePassphrase('correct horse battery staple')
    expect(strength.score).toBe(4)
    expect(strength.isWeak).toBe(false)
    expect(strength.suggestion).toBeNull()
  })

  it('rewards length above punctuation', () => {
    const long = scorePassphrase('the ledger balances at the end of every single month')
    const short = scorePassphrase('L3dg3r!')
    expect(long.score).toBeGreaterThan(short.score)
  })

  it('never gets weaker when a passphrase grows', () => {
    const base = 'unhurried marmalade '
    let previous = 0
    for (let words = 1; words <= 4; words += 1) {
      const score = scorePassphrase(base.repeat(words)).score
      expect(score).toBeGreaterThanOrEqual(previous)
      previous = score
    }
  })
})
