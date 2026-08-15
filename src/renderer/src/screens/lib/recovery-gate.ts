/*
 * The gate on the recovery-codes screen.
 *
 * This is the only screen in Coffer whose content cannot be shown twice. After it, the
 * codes exist on paper or they do not exist at all (ARCHITECTURE §6.3.1). A checkbox is
 * not enough proof of that — people tick boxes to make screens go away — so the gate
 * asks for one of the codes back, chosen by us rather than by them. Somebody who can
 * type code four has the sheet in front of them.
 *
 * The comparison is not a security decision. It compares what was typed against a code
 * already in this window's memory, to decide whether to let a button enable. It is
 * deliberately forgiving in the same way the main process is (src/main/security/
 * recovery-codes.ts): case, hyphens and spaces are ignored, and the three characters
 * people mis-copy by hand are repaired.
 */

/** Crockford's Base32, as used for recovery codes. No I, L, O or U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Symbols in a code, ignoring the grouping hyphens. */
export const CODE_LENGTH = 20

/*
 * Transcription repairs. A handwritten O is a zero, and both I and L are ones. `U` is
 * absent from the alphabet and is not a plausible misreading of anything in it, so it is
 * left to fail rather than guessed at — exactly as the main process leaves it.
 */
const REPAIRS = new Map<string, string>([
  ['O', '0'],
  ['I', '1'],
  ['L', '1'],
])

/**
 * The canonical form of a typed code: upper case, no separators, repairs applied.
 *
 * Total: anything at all can be passed in. Characters outside the alphabet survive as
 * themselves so that `isWellFormedCode` can reject them, rather than being silently
 * dropped into a string that then looks valid.
 */
export function normalizeCode(input: string): string {
  let normalized = ''
  for (const character of input.toUpperCase()) {
    if (character === '-' || character === ' ' || character === '\t' || character === '\n') continue
    normalized += REPAIRS.get(character) ?? character
  }
  return normalized
}

/** True when this could be a code at all: 20 symbols, all from the alphabet. */
export function isWellFormedCode(input: string): boolean {
  const normalized = normalizeCode(input)
  if (normalized.length !== CODE_LENGTH) return false
  return [...normalized].every((symbol) => ALPHABET.includes(symbol))
}

/** True when what was typed is the code we asked for. Order and grouping do not matter. */
export function matchesCode(expected: string, typed: string): boolean {
  const wanted = normalizeCode(expected)
  if (wanted === '') return false
  return normalizeCode(typed) === wanted
}

/**
 * Which code to ask for.
 *
 * `fraction` is a number in [0, 1) — `Math.random()` at the call site, so this stays
 * pure and the test can pin it. Asking for a fixed position would teach the second
 * company's user to copy only the last one.
 */
export function challengeIndex(count: number, fraction: number): number {
  if (count <= 0) return 0
  const bounded = Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0), 0.999999) : 0
  return Math.floor(bounded * count)
}

export interface GateInput {
  /** The codes as they were shown. */
  codes: readonly string[]
  /** Which one was asked for. */
  challenge: number
  /** What the user typed back. */
  typed: string
  /** Whether the "I have saved these" box is ticked. */
  hasAcknowledged: boolean
}

export interface GateState {
  canContinue: boolean
  /** What is still missing, for the hint under the field. Null when nothing is. */
  blockedBy: 'acknowledgement' | 'code-missing' | 'code-mismatch' | null
}

/**
 * Whether the user may leave this screen.
 *
 * Both conditions are real: the box says they have saved the codes somewhere, and the
 * retyped code shows they can read what they saved. Neither alone is worth much.
 */
export function gateState(input: GateInput): GateState {
  const expected = input.codes[input.challenge] ?? ''
  const typed = normalizeCode(input.typed)

  if (typed === '') return { canContinue: false, blockedBy: 'code-missing' }
  if (!matchesCode(expected, input.typed)) return { canContinue: false, blockedBy: 'code-mismatch' }
  if (!input.hasAcknowledged) return { canContinue: false, blockedBy: 'acknowledgement' }
  return { canContinue: true, blockedBy: null }
}

/** The hint shown under the confirmation field for each blocked state. */
export function gateHint(state: GateState, position: number): string {
  switch (state.blockedBy) {
    case 'code-missing':
      return `Type code ${position} from the sheet you just saved, to prove it is readable.`
    case 'code-mismatch':
      return `That is not code ${position}. Read it from your sheet — the codes are still shown above.`
    case 'acknowledgement':
      return 'Tick the box below to confirm the codes are saved away from this computer.'
    case null:
      return 'Code confirmed. These codes will not be shown again.'
  }
}
