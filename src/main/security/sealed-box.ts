/*
 * Sealed boxes — anonymous public-key encryption, for the maintainer-assisted flow.
 *
 * A sealed box (libsodium `crypto_box_seal`: X25519 key agreement with an ephemeral
 * sender key, then XSalsa20-Poly1305) lets anyone encrypt to a public key such that only
 * the holder of the matching private key can open it. There is no sender key to manage
 * and no shared secret to agree in advance, which is what makes it usable from an
 * offline desktop app talking to a maintainer it has never met.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS EXPLICITLY NOT.
 *
 * When a user is in trouble — a vault that will not parse, a recovery code that is
 * rejected, an unexplained failure to unlock — the useful thing to send a maintainer is
 * the state of their vault: format version, KDF parameters, which slots exist and which
 * are spent. That is diagnostic detail about someone's finances and their machine, and
 * it should not travel through a public issue tracker in the clear. `sealRequest` puts
 * it in an envelope only the maintainer can open.
 *
 * IT DOES NOT ESCROW THE KEY. There is no maintainer-held copy of any DEK, no wrapped
 * slot that a maintainer key can open, no path by which anyone but the user can decrypt
 * a company's books. SECURITY.md promises the user, in plain words, that a passphrase
 * lost along with every recovery code means the books are gone — a maintainer escrow
 * slot would make that promise false, and it is not worth having. Leaving vendor escrow
 * out is a deliberate choice, not an oversight.
 *
 * So: never put a DEK, a passphrase or a recovery code in a sealed request. The payload
 * is whatever the caller passes, and this module cannot enforce that rule for you —
 * `describeVault` in vault.ts exists to give you a payload that is safe by construction.
 *
 * NO MAINTAINER KEY IS BAKED IN. The recipient's public key is always a parameter. A
 * placeholder constant in the source is a key that ends up in production by accident.
 */

import { createHash } from 'node:crypto'
import type _sodium from 'libsodium-wrappers'

import { SecurityError } from './errors'

type Sodium = typeof _sodium

/** X25519 public key length. */
export const PUBLIC_KEY_BYTES = 32

/** X25519 private key length. */
export const PRIVATE_KEY_BYTES = 32

/** Bytes a sealed box adds to the plaintext: 32-byte ephemeral public key + 16-byte MAC. */
export const SEALED_BOX_OVERHEAD_BYTES = 48

/** Marker on a sealed request envelope. */
export const SEALED_REQUEST_FORMAT = 'coffer.sealed-request'

/** Envelope format version. */
export const SEALED_REQUEST_VERSION = 1

/** An X25519 key pair. The private key belongs to the maintainer and never leaves them. */
export interface KeyPair {
  readonly publicKey: Buffer
  readonly privateKey: Buffer
}

/** Anything that survives a JSON round trip. Sealed request payloads must be this. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** The cleartext wrapper around a sealed payload. Nothing in it is secret. */
export interface SealedRequestEnvelope {
  format: string
  version: number
  /** Which key this was sealed to, so the maintainer knows which private key to reach for. */
  recipientFingerprint: string
  createdAt: string
  /** base64 of the sealed box. */
  sealed: string
}

/*
 * libsodium-wrappers is a WebAssembly build that has to finish initialising before any
 * of its functions exist. Every entry point here awaits it, so callers never have to
 * remember an init step; the promise is cached, so awaiting it is free after the first
 * time.
 */
let sodiumReady: Promise<Sodium> | null = null

async function sodium(): Promise<Sodium> {
  if (sodiumReady === null) {
    sodiumReady = import('libsodium-wrappers').then(async (module) => {
      const library = module.default
      await library.ready
      return library
    })
  }
  return sodiumReady
}

/**
 * Warm libsodium up ahead of time. Optional — every function here initialises on demand
 * — but useful at startup so the first seal is not the one that pays for it.
 */
export async function initSealedBox(): Promise<void> {
  await sodium()
}

/** Generate an X25519 key pair. The maintainer runs this once; tests run it constantly. */
export async function generateKeyPair(): Promise<KeyPair> {
  const library = await sodium()
  const pair = library.crypto_box_keypair()
  return {
    publicKey: Buffer.from(pair.publicKey),
    privateKey: Buffer.from(pair.privateKey),
  }
}

/**
 * Seal `plaintext` to a public key. Only the holder of the matching private key can open
 * it, and the result reveals nothing about who sealed it.
 *
 * @throws SecurityError `SEALED_BOX_INVALID_KEY`
 */
export async function seal(plaintext: Buffer, recipientPublicKey: Buffer): Promise<Buffer> {
  assertKeyLength(recipientPublicKey, PUBLIC_KEY_BYTES)
  const library = await sodium()
  return Buffer.from(
    library.crypto_box_seal(new Uint8Array(plaintext), new Uint8Array(recipientPublicKey)),
  )
}

/**
 * Open a sealed box. Both halves of the key pair are needed: X25519 cannot recover the
 * public key from the private key the way some schemes can, and the sealed box construction
 * needs it to recompute the nonce.
 *
 * @throws SecurityError `SEALED_BOX_INVALID_KEY` | `SEALED_BOX_OPEN_FAILED`
 */
export async function openSealed(sealed: Buffer, keyPair: KeyPair): Promise<Buffer> {
  assertKeyLength(keyPair.publicKey, PUBLIC_KEY_BYTES)
  assertKeyLength(keyPair.privateKey, PRIVATE_KEY_BYTES)
  if (sealed.length < SEALED_BOX_OVERHEAD_BYTES) {
    throw openFailed()
  }
  const library = await sodium()
  try {
    return Buffer.from(
      library.crypto_box_seal_open(
        new Uint8Array(sealed),
        new Uint8Array(keyPair.publicKey),
        new Uint8Array(keyPair.privateKey),
      ),
    )
  } catch {
    // Wrong key pair, or a single altered byte anywhere in the box. Poly1305 does not
    // distinguish, and neither should we.
    throw openFailed()
  }
}

/**
 * Build a sealed request: a small JSON envelope carrying a sealed payload, ready to be
 * written to a file or pasted into an email.
 *
 * The envelope itself is cleartext on purpose — the maintainer needs to see which key it
 * was sealed to before they can open anything, and there is nothing else in it.
 */
export async function sealRequest(
  payload: JsonValue,
  recipientPublicKey: Buffer,
): Promise<SealedRequestEnvelope> {
  const sealed = await seal(Buffer.from(JSON.stringify(payload), 'utf8'), recipientPublicKey)
  return {
    format: SEALED_REQUEST_FORMAT,
    version: SEALED_REQUEST_VERSION,
    recipientFingerprint: publicKeyFingerprint(recipientPublicKey),
    createdAt: new Date().toISOString(),
    sealed: sealed.toString('base64'),
  }
}

/** The envelope as the text of a request file. */
export function serializeSealedRequest(envelope: SealedRequestEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`
}

/**
 * Open a sealed request — the maintainer's side of the flow, and what makes the whole
 * thing testable end to end.
 *
 * @throws SecurityError `SEALED_REQUEST_MALFORMED` | `SEALED_BOX_INVALID_KEY` | `SEALED_BOX_OPEN_FAILED`
 */
export async function openRequest(input: unknown, keyPair: KeyPair): Promise<JsonValue> {
  const envelope = parseSealedRequest(input)
  const plaintext = await openSealed(Buffer.from(envelope.sealed, 'base64'), keyPair)
  try {
    return JSON.parse(plaintext.toString('utf8')) as JsonValue
  } catch {
    throw new SecurityError(
      'SEALED_REQUEST_MALFORMED',
      'The sealed request opened but did not contain a readable payload.',
    )
  }
}

/**
 * Validate a request envelope without opening it.
 *
 * @throws SecurityError `SEALED_REQUEST_MALFORMED`
 */
export function parseSealedRequest(input: unknown): SealedRequestEnvelope {
  const raw = typeof input === 'string' ? parseJson(input) : input
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw requestMalformed()
  }
  const record = raw as Record<string, unknown>
  const version = record['version']
  const sealed = record['sealed']
  const recipientFingerprint = record['recipientFingerprint']
  const createdAt = record['createdAt']
  if (
    record['format'] !== SEALED_REQUEST_FORMAT ||
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    typeof sealed !== 'string' ||
    typeof recipientFingerprint !== 'string' ||
    typeof createdAt !== 'string'
  ) {
    throw requestMalformed()
  }
  if (version > SEALED_REQUEST_VERSION) {
    throw new SecurityError(
      'SEALED_REQUEST_MALFORMED',
      'This request was written by a newer version of Coffer.',
    )
  }
  const decoded = Buffer.from(sealed, 'base64')
  if (decoded.length < SEALED_BOX_OVERHEAD_BYTES || decoded.toString('base64') !== sealed) {
    throw requestMalformed()
  }
  return { format: SEALED_REQUEST_FORMAT, version, recipientFingerprint, createdAt, sealed }
}

/**
 * A short, readable fingerprint of a public key: the first 16 hex characters of its
 * SHA-256, grouped in fours. For a human to read out and compare against a published
 * value before trusting a key — `A1B2-C3D4-E5F6-0789`.
 */
export function publicKeyFingerprint(publicKey: Buffer): string {
  assertKeyLength(publicKey, PUBLIC_KEY_BYTES)
  const digest = createHash('sha256').update(publicKey).digest('hex').toUpperCase()
  return (digest.slice(0, 16).match(/.{4}/g) ?? []).join('-')
}

function assertKeyLength(key: Buffer, expected: number): void {
  if (!Buffer.isBuffer(key) || key.length !== expected) {
    throw new SecurityError('SEALED_BOX_INVALID_KEY', 'That is not a valid key for a sealed box.')
  }
}

function openFailed(): SecurityError {
  return new SecurityError(
    'SEALED_BOX_OPEN_FAILED',
    'This request could not be opened with that key.',
  )
}

function requestMalformed(): SecurityError {
  return new SecurityError('SEALED_REQUEST_MALFORMED', 'That is not a Coffer sealed request.')
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw requestMalformed()
  }
}
