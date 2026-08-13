import { describe, expect, it } from 'vitest'

import {
  type Argon2Params,
  MAX_MEMORY_COST,
  MIN_MEMORY_COST,
  PASSPHRASE_KDF,
  RECOVERY_KDF,
  assertPassphraseNotEmpty,
  assertValidKdfParams,
  constantTimeEqual,
  deriveKey,
  hashPassphrase,
  needsRehash,
  parsePhcParams,
  verifyPassphrase,
} from './argon2'
import { SecurityError } from './errors'

/* Fast enough to run hundreds of times, still a real Argon2id derivation. */
const FAST: Argon2Params = {
  algorithm: 'argon2id',
  memoryCost: MIN_MEMORY_COST,
  timeCost: 1,
  parallelism: 1,
}

const SALT = Buffer.alloc(16, 0x2a)

describe('the chosen parameters', () => {
  /* This test exists so that weakening the KDF is never a quiet edit. If a future
   * change lowers these below the OWASP 2025 floor, it has to argue with a red test
   * first. See the header of argon2.ts for the reasoning behind the actual values. */
  it('clears the OWASP floor for the passphrase profile', () => {
    expect(PASSPHRASE_KDF.algorithm).toBe('argon2id')
    expect(PASSPHRASE_KDF.memoryCost).toBeGreaterThanOrEqual(19 * 1024)
    expect(PASSPHRASE_KDF.timeCost).toBeGreaterThanOrEqual(2)
    expect(PASSPHRASE_KDF.parallelism).toBeGreaterThanOrEqual(1)
  })

  it('gives the passphrase more memory than a random recovery code needs', () => {
    expect(PASSPHRASE_KDF.memoryCost).toBeGreaterThan(RECOVERY_KDF.memoryCost)
  })

  it('clears the OWASP floor for the recovery profile too', () => {
    expect(RECOVERY_KDF.memoryCost).toBeGreaterThanOrEqual(19 * 1024)
    expect(RECOVERY_KDF.timeCost).toBeGreaterThanOrEqual(2)
  })

  it('accepts both profiles as valid', () => {
    expect(() => assertValidKdfParams(PASSPHRASE_KDF)).not.toThrow()
    expect(() => assertValidKdfParams(RECOVERY_KDF)).not.toThrow()
  })
})

describe('assertValidKdfParams', () => {
  it.each([
    ['memory below the floor', { ...FAST, memoryCost: 1 }],
    ['memory above the ceiling', { ...FAST, memoryCost: MAX_MEMORY_COST + 1 }],
    ['zero iterations', { ...FAST, timeCost: 0 }],
    ['zero lanes', { ...FAST, parallelism: 0 }],
    ['a fractional memory cost', { ...FAST, memoryCost: 8192.5 }],
    ['another algorithm', { ...FAST, algorithm: 'argon2i' as 'argon2id' }],
  ])('rejects %s', (_label, params) => {
    expect(() => assertValidKdfParams(params)).toThrow(SecurityError)
    expect(() => assertValidKdfParams(params)).toThrow(
      expect.objectContaining({ code: 'KDF_PARAMS_INVALID' }),
    )
  })

  /* The ceiling is not tidiness. KDF parameters are read from a file, and a file that
   * asks for terabytes of memory must be rejected rather than attempted. */
  it('refuses a memory cost large enough to be a denial of service', () => {
    expect(() => assertValidKdfParams({ ...FAST, memoryCost: 64 * 1024 * 1024 })).toThrow(
      SecurityError,
    )
  })
})

describe('deriveKey', () => {
  it('is deterministic for the same secret, salt and parameters', async () => {
    const first = await deriveKey(Buffer.from('open sesame'), SALT, FAST)
    const second = await deriveKey(Buffer.from('open sesame'), SALT, FAST)
    expect(first.equals(second)).toBe(true)
    expect(first).toHaveLength(32)
  })

  it('gives a different key for a different salt', async () => {
    const first = await deriveKey(Buffer.from('open sesame'), SALT, FAST)
    const second = await deriveKey(Buffer.from('open sesame'), Buffer.alloc(16, 0x2b), FAST)
    expect(first.equals(second)).toBe(false)
  })

  it('gives a different key for a different secret', async () => {
    const first = await deriveKey(Buffer.from('open sesame'), SALT, FAST)
    const second = await deriveKey(Buffer.from('open sesamf'), SALT, FAST)
    expect(first.equals(second)).toBe(false)
  })

  it('gives a different key when the parameters change', async () => {
    const first = await deriveKey(Buffer.from('open sesame'), SALT, FAST)
    const second = await deriveKey(Buffer.from('open sesame'), SALT, { ...FAST, timeCost: 2 })
    expect(first.equals(second)).toBe(false)
  })

  it('honours the requested length', async () => {
    expect(await deriveKey(Buffer.from('x'), SALT, FAST, 64)).toHaveLength(64)
  })

  it('rejects a salt that is too short', async () => {
    await expect(deriveKey(Buffer.from('x'), Buffer.alloc(4), FAST)).rejects.toThrow(
      expect.objectContaining({ code: 'KEY_MATERIAL_INVALID' }),
    )
  })

  it('rejects an empty secret', async () => {
    await expect(deriveKey(Buffer.alloc(0), SALT, FAST)).rejects.toThrow(
      expect.objectContaining({ code: 'KEY_MATERIAL_INVALID' }),
    )
  })

  it('rejects invalid parameters before touching Argon2', async () => {
    await expect(deriveKey(Buffer.from('x'), SALT, { ...FAST, memoryCost: 2 })).rejects.toThrow(
      expect.objectContaining({ code: 'KDF_PARAMS_INVALID' }),
    )
  })
})

describe('hashPassphrase and verifyPassphrase', () => {
  /* One test pays for the real production profile end to end, so the parameters we ship
   * are known to work and not only the fast ones the other tests use. */
  it('round-trips with the production parameters', async () => {
    const stored = await hashPassphrase('correct horse battery staple')
    expect(await verifyPassphrase(stored, 'correct horse battery staple')).toBe(true)
    expect(await verifyPassphrase(stored, 'correct horse battery stapl')).toBe(false)
  })

  it('embeds argon2id and the chosen parameters', async () => {
    const parsed = parsePhcParams(await hashPassphrase('a passphrase'))
    expect(parsed).not.toBeNull()
    expect(parsed?.algorithm).toBe('argon2id')
    expect(parsed?.version).toBe(19)
    expect(parsed?.memoryCost).toBe(PASSPHRASE_KDF.memoryCost)
    expect(parsed?.timeCost).toBe(PASSPHRASE_KDF.timeCost)
    expect(parsed?.parallelism).toBe(PASSPHRASE_KDF.parallelism)
  })

  it('salts every hash, so two hashes of one passphrase differ', async () => {
    const [first, second] = await Promise.all([hashPassphrase('same'), hashPassphrase('same')])
    expect(first).not.toBe(second)
  })

  it('refuses to hash an empty or blank passphrase', async () => {
    await expect(hashPassphrase('')).rejects.toThrow(
      expect.objectContaining({ code: 'PASSPHRASE_EMPTY' }),
    )
    await expect(hashPassphrase('   ')).rejects.toThrow(
      expect.objectContaining({ code: 'PASSPHRASE_EMPTY' }),
    )
  })

  it('treats an unreadable stored hash as an error, not as a mismatch', async () => {
    await expect(verifyPassphrase('not a hash at all', 'x')).rejects.toThrow(
      expect.objectContaining({ code: 'PASSPHRASE_HASH_MALFORMED' }),
    )
    await expect(verifyPassphrase('', 'x')).rejects.toThrow(
      expect.objectContaining({ code: 'PASSPHRASE_HASH_MALFORMED' }),
    )
  })

  it('does not accept an empty passphrase against a real hash', async () => {
    const stored = await hashPassphrase('something')
    expect(await verifyPassphrase(stored, '')).toBe(false)
  })
})

describe('needsRehash', () => {
  it('is false for a hash at the current profile', async () => {
    expect(needsRehash(await hashPassphrase('current'))).toBe(false)
  })

  it('is true for a hash written with weaker parameters', () => {
    expect(needsRehash('$argon2id$v=19$m=8192,t=1,p=1$c2FsdHNhbHQ$ZGlnZXN0')).toBe(true)
  })

  it('is true for an unreadable hash', () => {
    expect(needsRehash('nonsense')).toBe(true)
    expect(needsRehash('$argon2id$v=19$m=notanumber,t=3,p=4$s$d')).toBe(true)
  })
})

describe('constantTimeEqual', () => {
  it('matches identical buffers', () => {
    expect(constantTimeEqual(Buffer.from('abcd'), Buffer.from('abcd'))).toBe(true)
  })

  it('rejects a one-bit difference', () => {
    expect(constantTimeEqual(Buffer.from([0b0000_0001]), Buffer.from([0b0000_0000]))).toBe(false)
  })

  it('returns false rather than throwing on a length mismatch', () => {
    expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('abcd'))).toBe(false)
  })
})

describe('assertPassphraseNotEmpty', () => {
  it('accepts a real passphrase', () => {
    expect(() => assertPassphraseNotEmpty('a')).not.toThrow()
  })

  it.each(['', ' ', '\t\n'])('rejects %j', (value) => {
    expect(() => assertPassphraseNotEmpty(value)).toThrow(
      expect.objectContaining({ code: 'PASSPHRASE_EMPTY' }),
    )
  })
})
