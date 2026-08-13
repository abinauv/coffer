import { describe, expect, it } from 'vitest'

import { type Argon2Params, MIN_MEMORY_COST } from './argon2'
import {
  DEK_BYTES,
  NONCE_BYTES,
  TAG_BYTES,
  assertValidDek,
  dekFromHex,
  dekToHex,
  deriveSlotKeys,
  deriveSubkey,
  generateDek,
  isValidDek,
  sqlcipherRawKey,
  unwrapDekWithKek,
  unwrapDekWithSecret,
  withSecret,
  wrapDek,
  wrapDekWithSecret,
  zeroize,
} from './dek'
import { SecurityError } from './errors'

const FAST: Argon2Params = {
  algorithm: 'argon2id',
  memoryCost: MIN_MEMORY_COST,
  timeCost: 1,
  parallelism: 1,
}

const AAD = Buffer.from('coffer.test|slot=1')
const wrapOptions = { kdf: FAST, aad: () => AAD }

describe('generateDek', () => {
  it('produces a 32-byte key', () => {
    expect(generateDek()).toHaveLength(DEK_BYTES)
  })

  it('never produces the same key twice', () => {
    const keys = new Set(Array.from({ length: 64 }, () => generateDek().toString('hex')))
    expect(keys.size).toBe(64)
  })

  it('is not all zeros or otherwise obviously unrandom', () => {
    const dek = generateDek()
    expect(dek.every((byte) => byte === 0)).toBe(false)
    expect(new Set(dek).size).toBeGreaterThan(8)
  })
})

describe('isValidDek and assertValidDek', () => {
  it('accepts a real DEK', () => {
    expect(isValidDek(generateDek())).toBe(true)
    expect(() => assertValidDek(generateDek())).not.toThrow()
  })

  it.each([0, 16, 31, 33, 64])('rejects a %i-byte key', (length) => {
    expect(isValidDek(Buffer.alloc(length))).toBe(false)
    expect(() => assertValidDek(Buffer.alloc(length))).toThrow(
      expect.objectContaining({ code: 'KEY_MATERIAL_INVALID' }),
    )
  })
})

describe('deriveSubkey', () => {
  it('is deterministic', () => {
    const master = Buffer.alloc(32, 7)
    expect(deriveSubkey(master, 'label').equals(deriveSubkey(master, 'label'))).toBe(true)
  })

  it('gives unrelated keys for different labels', () => {
    const master = Buffer.alloc(32, 7)
    expect(deriveSubkey(master, 'one').equals(deriveSubkey(master, 'two'))).toBe(false)
  })

  it('gives different keys for different master keys', () => {
    expect(
      deriveSubkey(Buffer.alloc(32, 7), 'label').equals(deriveSubkey(Buffer.alloc(32, 8), 'label')),
    ).toBe(false)
  })

  it('rejects an empty master key', () => {
    expect(() => deriveSubkey(Buffer.alloc(0), 'label')).toThrow(SecurityError)
  })
})

describe('deriveSlotKeys', () => {
  it('returns a KEK and a verifier that are not the same value', async () => {
    const { kek, verifier } = await deriveSlotKeys(Buffer.from('secret'), Buffer.alloc(16, 1), FAST)
    expect(kek).toHaveLength(32)
    expect(verifier).toHaveLength(32)
    expect(kek.equals(verifier)).toBe(false)
  })

  it('is deterministic for the same inputs', async () => {
    const first = await deriveSlotKeys(Buffer.from('secret'), Buffer.alloc(16, 1), FAST)
    const second = await deriveSlotKeys(Buffer.from('secret'), Buffer.alloc(16, 1), FAST)
    expect(first.kek.equals(second.kek)).toBe(true)
    expect(first.verifier.equals(second.verifier)).toBe(true)
  })
})

describe('wrapDek and unwrapDekWithKek', () => {
  it('round-trips the exact key', () => {
    const dek = generateDek()
    const kek = Buffer.alloc(32, 9)
    const unwrapped = unwrapDekWithKek(wrapDek(dek, kek, AAD), kek, AAD)
    expect(unwrapped?.equals(dek)).toBe(true)
  })

  it('produces a fresh nonce every time, so the same key wrapped twice looks different', () => {
    const dek = generateDek()
    const kek = Buffer.alloc(32, 9)
    const first = wrapDek(dek, kek, AAD)
    const second = wrapDek(dek, kek, AAD)
    expect(first.nonce.equals(second.nonce)).toBe(false)
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false)
  })

  it('never leaks the key into the ciphertext', () => {
    const dek = generateDek()
    const wrapped = wrapDek(dek, Buffer.alloc(32, 9), AAD)
    expect(wrapped.ciphertext.equals(dek)).toBe(false)
    expect(wrapped.ciphertext).toHaveLength(DEK_BYTES)
    expect(wrapped.nonce).toHaveLength(NONCE_BYTES)
    expect(wrapped.tag).toHaveLength(TAG_BYTES)
  })

  it('returns null for the wrong key rather than garbage', () => {
    const wrapped = wrapDek(generateDek(), Buffer.alloc(32, 9), AAD)
    expect(unwrapDekWithKek(wrapped, Buffer.alloc(32, 10), AAD)).toBeNull()
  })

  it('returns null when the associated data does not match', () => {
    const kek = Buffer.alloc(32, 9)
    const wrapped = wrapDek(generateDek(), kek, AAD)
    expect(unwrapDekWithKek(wrapped, kek, Buffer.from('coffer.test|slot=2'))).toBeNull()
  })

  it.each(['ciphertext', 'tag', 'nonce'] as const)(
    'returns null when the %s is altered',
    (field) => {
      const kek = Buffer.alloc(32, 9)
      const wrapped = wrapDek(generateDek(), kek, AAD)
      const damaged = { ...wrapped, [field]: flipFirstBit(wrapped[field]) }
      expect(unwrapDekWithKek(damaged, kek, AAD)).toBeNull()
    },
  )

  it('refuses to wrap with a key of the wrong size', () => {
    expect(() => wrapDek(generateDek(), Buffer.alloc(16, 9), AAD)).toThrow(
      expect.objectContaining({ code: 'KEY_MATERIAL_INVALID' }),
    )
  })
})

describe('wrapDekWithSecret and unwrapDekWithSecret', () => {
  it('unwraps with the right secret', async () => {
    const dek = generateDek()
    const wrapping = await wrapDekWithSecret(dek, Buffer.from('passphrase'), wrapOptions)
    const outcome = await unwrapDekWithSecret(Buffer.from('passphrase'), wrapping, wrapOptions)

    expect(outcome.status).toBe('unwrapped')
    if (outcome.status === 'unwrapped') {
      expect(outcome.dek.equals(dek)).toBe(true)
    }
  })

  it('reports the wrong secret as a wrong secret, not as damage', async () => {
    const wrapping = await wrapDekWithSecret(generateDek(), Buffer.from('passphrase'), wrapOptions)
    const outcome = await unwrapDekWithSecret(Buffer.from('passphras3'), wrapping, wrapOptions)
    expect(outcome.status).toBe('wrong-secret')
  })

  /* The distinction the stored verifier buys: the secret was right and the ciphertext
   * still failed to authenticate, which can only mean the stored bytes were changed. */
  it('reports an altered ciphertext as tampering', async () => {
    const wrapping = await wrapDekWithSecret(generateDek(), Buffer.from('passphrase'), wrapOptions)
    const damaged = {
      ...wrapping,
      wrapped: { ...wrapping.wrapped, ciphertext: flipFirstBit(wrapping.wrapped.ciphertext) },
    }
    const outcome = await unwrapDekWithSecret(Buffer.from('passphrase'), damaged, wrapOptions)
    expect(outcome.status).toBe('tampered')
  })

  it('reports an altered tag as tampering', async () => {
    const wrapping = await wrapDekWithSecret(generateDek(), Buffer.from('passphrase'), wrapOptions)
    const damaged = {
      ...wrapping,
      wrapped: { ...wrapping.wrapped, tag: flipFirstBit(wrapping.wrapped.tag) },
    }
    const outcome = await unwrapDekWithSecret(Buffer.from('passphrase'), damaged, wrapOptions)
    expect(outcome.status).toBe('tampered')
  })

  it('reports altered associated data as tampering', async () => {
    const wrapping = await wrapDekWithSecret(generateDek(), Buffer.from('passphrase'), wrapOptions)
    const outcome = await unwrapDekWithSecret(Buffer.from('passphrase'), wrapping, {
      kdf: FAST,
      aad: () => Buffer.from('a different context'),
    })
    expect(outcome.status).toBe('tampered')
  })

  it('fails when the KDF parameters do not match the ones used to wrap', async () => {
    const wrapping = await wrapDekWithSecret(generateDek(), Buffer.from('passphrase'), wrapOptions)
    const outcome = await unwrapDekWithSecret(Buffer.from('passphrase'), wrapping, {
      kdf: { ...FAST, timeCost: 2 },
      aad: () => AAD,
    })
    expect(outcome.status).toBe('wrong-secret')
  })

  it('stores a verifier that is not the DEK and not the ciphertext', async () => {
    const dek = generateDek()
    const wrapping = await wrapDekWithSecret(dek, Buffer.from('passphrase'), wrapOptions)
    expect(wrapping.verifier.equals(dek)).toBe(false)
    expect(wrapping.verifier.equals(wrapping.wrapped.ciphertext)).toBe(false)
  })
})

describe('zeroize', () => {
  it('overwrites the bytes in place', () => {
    const secret = Buffer.from('a very secret value')
    zeroize(secret)
    expect(secret.every((byte) => byte === 0)).toBe(true)
  })

  it('takes several buffers and tolerates null and undefined', () => {
    const first = Buffer.from([1, 2, 3])
    const second = Buffer.from([4, 5, 6])
    zeroize(first, null, second, undefined)
    expect(first.every((byte) => byte === 0)).toBe(true)
    expect(second.every((byte) => byte === 0)).toBe(true)
  })
})

describe('withSecret', () => {
  it('passes the secret through and returns the result', async () => {
    const secret = Buffer.from('key material')
    const seen = await withSecret(secret, (value) => value.toString('utf8'))
    expect(seen).toBe('key material')
  })

  it('zeroes the secret afterwards', async () => {
    const secret = Buffer.from('key material')
    await withSecret(secret, () => undefined)
    expect(secret.every((byte) => byte === 0)).toBe(true)
  })

  it('zeroes the secret even when the callback throws', async () => {
    const secret = Buffer.from('key material')
    await expect(
      withSecret(secret, () => {
        throw new Error('the database would not open')
      }),
    ).rejects.toThrow('the database would not open')
    expect(secret.every((byte) => byte === 0)).toBe(true)
  })
})

describe('hex and SQLCipher forms', () => {
  it('round-trips through hex', () => {
    const dek = generateDek()
    expect(dekFromHex(dekToHex(dek)).equals(dek)).toBe(true)
  })

  it('produces 64 lowercase hex characters', () => {
    expect(dekToHex(generateDek())).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces the SQLCipher raw-key literal', () => {
    expect(sqlcipherRawKey(generateDek())).toMatch(/^x'[0-9a-f]{64}'$/)
  })

  it.each([
    ['too short', 'ab'],
    ['too long', 'a'.repeat(66)],
    ['not hex', 'z'.repeat(64)],
    ['empty', ''],
    ['a raw-key literal rather than the hex itself', `x'${'a'.repeat(64)}'`],
  ])('rejects hex that is %s', (_label, value) => {
    expect(() => dekFromHex(value)).toThrow(
      expect.objectContaining({ code: 'KEY_MATERIAL_INVALID' }),
    )
  })
})

function flipFirstBit(buffer: Buffer): Buffer {
  const copy = Buffer.from(buffer)
  copy[0] = (copy[0] ?? 0) ^ 0x01
  return copy
}
