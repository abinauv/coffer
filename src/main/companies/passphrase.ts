/*
 * Advisory passphrase strength.
 *
 * THIS NEVER BLOCKS ANYTHING. There is no key escrow and no maintainer-held key
 * (ARCHITECTURE §6.3.1): if Coffer refused a passphrase, the user would have no fallback
 * and no one to appeal to. SECURITY.md calls accepting a weak passphrase *without
 * warning* a vulnerability — the remedy is the warning, not the refusal. So this module
 * produces a number and a sentence, and `create` never reads either.
 *
 * WHY NOT A LIBRARY. zxcvbn is the right tool and it is 800 KB of dictionaries. This is a
 * meter next to a text box, not an authentication decision, and the difference between
 * "this is weak" and "this is very weak" changes nothing a user does. What matters is
 * that the four failures people actually make are caught: too short, one of the handful
 * of passwords everybody picks, a keyboard run, and one character repeated.
 *
 * WHAT THE SCORE MEANS. An estimate of guessing difficulty in bits, mapped to 0-4:
 *
 *     < 28 bits   0  trivial — a laptop tries every one of these in seconds
 *     < 40 bits   1  weak
 *     < 56 bits   2  fair
 *     < 72 bits   3  strong
 *     otherwise   4  very strong
 *
 * The estimate is deliberately conservative about length and harsh about patterns,
 * because "make it longer" is advice that works and "add a symbol" is advice that
 * produces `Password1!`.
 */

import type { PassphraseStrength } from '@shared/dto'

/** Analysis stops here. A meter must not become a way to spend a second of CPU per keystroke. */
const MAX_ANALYSED_LENGTH = 256

/** Bit thresholds for scores 1, 2, 3 and 4. */
const SCORE_THRESHOLDS = [28, 40, 56, 72] as const

const LABELS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'] as const

/** Below this score, the UI shows the warning. Still lets the passphrase through. */
const WEAK_BELOW_SCORE = 3

/*
 * The passwords that appear at the top of every breach corpus, plus the ones this
 * particular product will attract. Compared after case folding and after trailing digits
 * and punctuation are stripped, so `Password123!` is caught by `password`.
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'passwd',
  'pass',
  'passphrase',
  'secret',
  'letmein',
  'welcome',
  'admin',
  'administrator',
  'root',
  'user',
  'guest',
  'login',
  'qwerty',
  'qwertyuiop',
  'azerty',
  'qwertz',
  'asdf',
  'asdfgh',
  'asdfghjkl',
  'zxcvbn',
  'zxcvbnm',
  'iloveyou',
  'princess',
  'dragon',
  'monkey',
  'sunshine',
  'football',
  'baseball',
  'superman',
  'batman',
  'starwars',
  'trustno',
  'whatever',
  'freedom',
  'master',
  'shadow',
  'michael',
  'jennifer',
  'jordan',
  'hello',
  'test',
  'testing',
  'changeme',
  'default',
  'abc',
  'aaa',
  'coffer',
  'accounts',
  'company',
  'business',
  'ledger',
  'books',
  'invoice',
  'money',
])

/** Keyboard rows, so that `qwerty` and `asdfgh` are recognised as the runs they are. */
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'azertyuiop', 'qwertzuiop']

/**
 * Score a passphrase for the strength meter.
 *
 * Total function: every input produces a result, including the empty string, a
 * hundred-thousand-character paste, and text in a script with no case. It never throws
 * and it never returns the passphrase in any field.
 */
export function scorePassphrase(passphrase: string): PassphraseStrength {
  if (typeof passphrase !== 'string' || passphrase.trim() === '') {
    return {
      score: 0,
      label: LABELS[0],
      suggestion:
        'Enter a passphrase. Four unrelated words are easier to remember and harder to ' +
        'guess than one scrambled word.',
      isWeak: true,
    }
  }

  const sample = passphrase.slice(0, MAX_ANALYSED_LENGTH)
  const analysis = analyse(sample)
  const score = scoreFor(analysis.bits)

  return {
    score,
    label: LABELS[score],
    suggestion: score === 4 ? null : suggestionFor(analysis, sample),
    isWeak: score < WEAK_BELOW_SCORE,
  }
}

interface Analysis {
  readonly bits: number
  readonly length: number
  readonly isCommon: boolean
  readonly hasRun: boolean
  readonly repetition: number
  readonly classes: number
}

function analyse(sample: string): Analysis {
  const length = sample.length
  const classes = characterClasses(sample)
  const pool = poolSize(sample)

  /*
   * Repeated characters buy less than new ones: `aaaaaaaa` is not eight characters of
   * search space. Each repeat of a character already seen counts half.
   */
  const unique = new Set(sample).size
  const repetition = length === 0 ? 0 : 1 - unique / length
  let effectiveLength = unique + (length - unique) * 0.5

  /* Runs of three or more that a guessing program walks straight through: `abc`, `321`,
   * `aaa`, `qwerty`, `asdfgh`. Everything past the first two characters of a run is free. */
  const runPenalty = predictableRunPenalty(sample)
  effectiveLength -= runPenalty

  const isCommon = looksCommon(sample)

  let bits = Math.max(0, effectiveLength) * Math.log2(Math.max(2, pool))
  if (isCommon) {
    /* Not a subtraction: a passphrase on the list is guessed from the list, and how
     * many characters it happens to have does not enter into it. */
    bits = Math.min(bits, 12)
  }

  /*
   * A ceiling on short passphrases, whatever their alphabet. `Tr0ub4dor&3` scores well
   * on a character-count estimate and is famously not strong; the estimate cannot see
   * that it is one dictionary word with predictable substitutions, but it can see that
   * eleven characters is not much to search. Below 8 characters nothing can be strong;
   * below 12, nothing can clear the warning.
   */
  if (length < 8) {
    bits = Math.min(bits, SCORE_THRESHOLDS[0] - 1)
  } else if (length < 12) {
    bits = Math.min(bits, SCORE_THRESHOLDS[2] - 1)
  }

  return {
    bits: Math.max(0, bits),
    length,
    isCommon,
    hasRun: runPenalty > 0,
    repetition,
    classes,
  }
}

function scoreFor(bits: number): 0 | 1 | 2 | 3 | 4 {
  if (bits < SCORE_THRESHOLDS[0]) return 0
  if (bits < SCORE_THRESHOLDS[1]) return 1
  if (bits < SCORE_THRESHOLDS[2]) return 2
  if (bits < SCORE_THRESHOLDS[3]) return 3
  return 4
}

/** The single most useful thing this passphrase could do better — one sentence, not a list. */
function suggestionFor(analysis: Analysis, sample: string): string {
  if (analysis.isCommon) {
    return 'This is one of the first passphrases anyone would try. Use words that mean something only to you.'
  }
  if (analysis.length < 12) {
    return 'Make it longer. Length is worth far more than punctuation — four unrelated words beats eight scrambled characters.'
  }
  if (analysis.hasRun) {
    return 'Drop the runs like "abcd" or "qwerty". They are the first thing a guessing program tries.'
  }
  if (analysis.repetition > 0.5) {
    return 'Too much of this repeats. Different words, rather than the same characters again.'
  }
  if (analysis.classes === 1 && !sample.includes(' ')) {
    return 'Add another word, or a number you will remember. One long run of the same kind of character is easier to guess than it looks.'
  }
  return 'Add another word. Each one you add multiplies the work of guessing it.'
}

function characterClasses(sample: string): number {
  let classes = 0
  if (/[a-z]/.test(sample)) classes += 1
  if (/[A-Z]/.test(sample)) classes += 1
  if (/[0-9]/.test(sample)) classes += 1
  if (/[^a-zA-Z0-9]/.test(sample)) classes += 1
  return classes
}

/** How many characters an attacker would have to try per position. */
function poolSize(sample: string): number {
  let pool = 0
  if (/[a-z]/.test(sample)) pool += 26
  if (/[A-Z]/.test(sample)) pool += 26
  if (/[0-9]/.test(sample)) pool += 10
  if (/[ -/:-@[-`{-~]/.test(sample)) pool += 33
  /* Anything outside ASCII widens the alphabet enormously, but a user typing one accented
   * character has not multiplied their security by a thousand. A flat, modest bonus. */
  if (/[^\x20-\x7e]/u.test(sample)) pool += 40
  return pool
}

/**
 * Characters beyond the first two of any run an attacker can walk through.
 *
 * `abcdef` gives 4, `aaaa` gives 2, `qwerty` gives 4, `a1b2c3` gives 0. Direction is not
 * tracked: `abcba` is no harder to guess than `abcde`.
 */
function predictableRunPenalty(sample: string): number {
  const folded = sample.toLowerCase()
  let penalty = 0
  let runLength = 1

  for (let index = 1; index < folded.length; index += 1) {
    if (isPredictableStep(folded.charAt(index - 1), folded.charAt(index))) {
      runLength += 1
      continue
    }
    penalty += runCost(runLength)
    runLength = 1
  }
  return penalty + runCost(runLength)
}

function runCost(runLength: number): number {
  return runLength >= 3 ? runLength - 2 : 0
}

/** The same character, the next or previous one, or the next key along a keyboard row. */
function isPredictableStep(previous: string, current: string): boolean {
  const step = current.charCodeAt(0) - previous.charCodeAt(0)
  if (step === 0 || step === 1 || step === -1) {
    return true
  }
  return KEYBOARD_ROWS.some((row) => {
    const from = row.indexOf(previous)
    const to = row.indexOf(current)
    return from !== -1 && to !== -1 && Math.abs(from - to) === 1
  })
}

/**
 * Is this one of the passwords everybody picks, dressed up?
 *
 * `Password123!` and `p@ssword` both reduce to `password`: case is folded, the usual
 * character substitutions are undone, and trailing digits and punctuation — the two
 * things people add when a form demands "a number and a symbol" — are stripped.
 */
function looksCommon(sample: string): boolean {
  const lower = sample.toLowerCase()
  const candidates = new Set<string>()
  for (const base of [lower, unleet(lower)]) {
    candidates.add(base)
    /* The digits and punctuation people append when a form demands them. */
    candidates.add(base.replace(/[^a-z]+$/, '').replace(/^[^a-z]+/, ''))
  }
  for (const candidate of candidates) {
    if (COMMON_PASSWORDS.has(candidate)) {
      return true
    }
  }
  return false
}

function unleet(lower: string): string {
  return lower
    .replace(/[@4]/g, 'a')
    .replace(/[$5]/g, 's')
    .replace(/[!1|]/g, 'i')
    .replace(/0/g, 'o')
    .replace(/3/g, 'e')
    .replace(/7/g, 't')
}
