import { describe, expect, it } from 'vitest'

import {
  PUBLIC_KEY_BYTES,
  SEALED_BOX_OVERHEAD_BYTES,
  SEALED_REQUEST_FORMAT,
  type KeyPair,
  generateKeyPair,
  initSealedBox,
  openRequest,
  openSealed,
  parseSealedRequest,
  publicKeyFingerprint,
  seal,
  sealRequest,
  serializeSealedRequest,
} from './sealed-box'

const maintainer = await generateKeyPair()
const impostor = await generateKeyPair()

describe('initSealedBox', () => {
  it('is idempotent', async () => {
    await expect(Promise.all([initSealedBox(), initSealedBox()])).resolves.toBeDefined()
  })
})

describe('generateKeyPair', () => {
  it('produces a 32-byte X25519 pair', () => {
    expect(maintainer.publicKey).toHaveLength(PUBLIC_KEY_BYTES)
    expect(maintainer.privateKey).toHaveLength(32)
  })

  it('produces a different pair every time', async () => {
    const another = await generateKeyPair()
    expect(another.publicKey.equals(maintainer.publicKey)).toBe(false)
  })
})

describe('seal and openSealed', () => {
  it('round-trips a payload', async () => {
    const message = Buffer.from('a vault that will not parse')
    const sealed = await seal(message, maintainer.publicKey)
    expect((await openSealed(sealed, maintainer)).equals(message)).toBe(true)
  })

  it('hides the plaintext', async () => {
    const sealed = await seal(Buffer.from('recoverable text'), maintainer.publicKey)
    expect(sealed.toString('utf8')).not.toContain('recoverable text')
    expect(sealed.toString('base64')).not.toContain(
      Buffer.from('recoverable text').toString('base64'),
    )
  })

  it('adds exactly the sealed-box overhead', async () => {
    const sealed = await seal(Buffer.alloc(100), maintainer.publicKey)
    expect(sealed).toHaveLength(100 + SEALED_BOX_OVERHEAD_BYTES)
  })

  /* Anonymity: a fresh ephemeral key per seal, so the same message to the same
   * recipient never produces the same bytes and cannot be correlated. */
  it('produces different bytes each time for the same message and key', async () => {
    const first = await seal(Buffer.from('same'), maintainer.publicKey)
    const second = await seal(Buffer.from('same'), maintainer.publicKey)
    expect(first.equals(second)).toBe(false)
  })

  it('will not open with the wrong key pair', async () => {
    const sealed = await seal(Buffer.from('for the maintainer only'), maintainer.publicKey)
    await expect(openSealed(sealed, impostor)).rejects.toThrow(
      expect.objectContaining({ code: 'SEALED_BOX_OPEN_FAILED' }),
    )
  })

  it('will not open with a mismatched half of a pair', async () => {
    const sealed = await seal(Buffer.from('for the maintainer only'), maintainer.publicKey)
    const mixed: KeyPair = { publicKey: maintainer.publicKey, privateKey: impostor.privateKey }
    await expect(openSealed(sealed, mixed)).rejects.toThrow(
      expect.objectContaining({ code: 'SEALED_BOX_OPEN_FAILED' }),
    )
  })

  it.each([0, 20, 47, 100])('rejects a box altered at byte %i', async (index) => {
    const sealed = await seal(Buffer.alloc(120, 3), maintainer.publicKey)
    sealed[index] = (sealed[index] ?? 0) ^ 0x01
    await expect(openSealed(sealed, maintainer)).rejects.toThrow(
      expect.objectContaining({ code: 'SEALED_BOX_OPEN_FAILED' }),
    )
  })

  it('rejects a box too short to be one', async () => {
    await expect(openSealed(Buffer.alloc(10), maintainer)).rejects.toThrow(
      expect.objectContaining({ code: 'SEALED_BOX_OPEN_FAILED' }),
    )
  })

  it.each([0, 16, 31, 33])('rejects a %i-byte public key', async (length) => {
    await expect(seal(Buffer.from('x'), Buffer.alloc(length))).rejects.toThrow(
      expect.objectContaining({ code: 'SEALED_BOX_INVALID_KEY' }),
    )
  })

  it('rejects a private key of the wrong size', async () => {
    const sealed = await seal(Buffer.from('x'), maintainer.publicKey)
    await expect(
      openSealed(sealed, { publicKey: maintainer.publicKey, privateKey: Buffer.alloc(16) }),
    ).rejects.toThrow(expect.objectContaining({ code: 'SEALED_BOX_INVALID_KEY' }))
  })
})

describe('sealRequest and openRequest', () => {
  const payload = {
    format: 'coffer.vault',
    version: 1,
    recoveryCodesRemaining: 3,
    slots: [{ id: 'passphrase', kind: 'passphrase', isSpent: false }],
  }

  it('round-trips through the serialised envelope', async () => {
    const envelope = await sealRequest(payload, maintainer.publicKey)
    const text = serializeSealedRequest(envelope)
    expect(await openRequest(text, maintainer)).toEqual(payload)
  })

  it('round-trips an already-parsed envelope object', async () => {
    const envelope = await sealRequest(payload, maintainer.publicKey)
    expect(await openRequest(envelope, maintainer)).toEqual(payload)
  })

  it('leaves nothing of the payload readable in the envelope', async () => {
    const text = serializeSealedRequest(
      await sealRequest({ note: 'my company is called Ferrous Works' }, maintainer.publicKey),
    )
    expect(text).not.toContain('Ferrous Works')
    expect(text).not.toContain('note')
  })

  it('labels the envelope with a fingerprint of the key it was sealed to', async () => {
    const envelope = await sealRequest(payload, maintainer.publicKey)
    expect(envelope.format).toBe(SEALED_REQUEST_FORMAT)
    expect(envelope.recipientFingerprint).toBe(publicKeyFingerprint(maintainer.publicKey))
  })

  it('cannot be opened by anyone else', async () => {
    const envelope = await sealRequest(payload, maintainer.publicKey)
    await expect(openRequest(envelope, impostor)).rejects.toThrow(
      expect.objectContaining({ code: 'SEALED_BOX_OPEN_FAILED' }),
    )
  })

  it('fails to open once the sealed field has been edited', async () => {
    const envelope = await sealRequest(payload, maintainer.publicKey)
    const bytes = Buffer.from(envelope.sealed, 'base64')
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01
    await expect(
      openRequest({ ...envelope, sealed: bytes.toString('base64') }, maintainer),
    ).rejects.toThrow(expect.objectContaining({ code: 'SEALED_BOX_OPEN_FAILED' }))
  })
})

describe('parseSealedRequest', () => {
  it.each([
    ['text that is not JSON', 'nonsense'],
    ['a JSON array', '[]'],
    ['a JSON string', '"hello"'],
    ['an object without the format marker', JSON.stringify({ version: 1, sealed: 'AAAA' })],
    [
      'an envelope with a sealed field that is not base64',
      JSON.stringify({
        format: SEALED_REQUEST_FORMAT,
        version: 1,
        recipientFingerprint: 'AAAA',
        createdAt: 'now',
        sealed: 'not base64!!',
      }),
    ],
    [
      'an envelope whose sealed field is too short to be a box',
      JSON.stringify({
        format: SEALED_REQUEST_FORMAT,
        version: 1,
        recipientFingerprint: 'AAAA',
        createdAt: 'now',
        sealed: Buffer.alloc(8).toString('base64'),
      }),
    ],
  ])('rejects %s', (_label, input) => {
    expect(() => parseSealedRequest(input)).toThrow(
      expect.objectContaining({ code: 'SEALED_REQUEST_MALFORMED' }),
    )
  })

  it('rejects an envelope from a newer version of Coffer', async () => {
    const envelope = await sealRequest({ a: 1 }, maintainer.publicKey)
    expect(() => parseSealedRequest({ ...envelope, version: 99 })).toThrow(
      expect.objectContaining({ code: 'SEALED_REQUEST_MALFORMED' }),
    )
  })
})

describe('publicKeyFingerprint', () => {
  it('is stable for a key', () => {
    expect(publicKeyFingerprint(maintainer.publicKey)).toBe(
      publicKeyFingerprint(maintainer.publicKey),
    )
  })

  it('differs between keys', () => {
    expect(publicKeyFingerprint(maintainer.publicKey)).not.toBe(
      publicKeyFingerprint(impostor.publicKey),
    )
  })

  it('is short enough to read aloud', () => {
    expect(publicKeyFingerprint(maintainer.publicKey)).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/)
  })

  it('refuses a key of the wrong size', () => {
    expect(() => publicKeyFingerprint(Buffer.alloc(16))).toThrow(
      expect.objectContaining({ code: 'SEALED_BOX_INVALID_KEY' }),
    )
  })
})
