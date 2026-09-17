/*
 * What Company → Recovery codes says about the codes it cannot show.
 *
 * The renderer knows one number about them: how many are unspent. That is deliberate —
 * the codes exist on paper or they do not exist at all (ARCHITECTURE §6.3.1), and nothing
 * in this process has ever held a copy it could count from. So every sentence here is
 * built from that one count, and none of them claims to know where the sheet is.
 *
 * The wording earns its own file because it has to stay honest as the count falls: at
 * five there is nothing to say, at one there is something worth saying, and at zero the
 * passphrase is the only way in and the user should hear it plainly.
 */

/** How many codes a set holds. `RECOVERY_CODE_COUNT` in src/main/security/recovery-codes.ts. */
export const RECOVERY_CODE_SET_SIZE = 5

export type RecoveryTone = 'positive' | 'warning' | 'negative'

export interface RecoveryView {
  /** Unspent codes, clamped to something a meter can draw. */
  remaining: number
  /** Segments in the meter: the set size, unless a vault somehow holds more. */
  issued: number
  spent: number
  tone: RecoveryTone
  /** The meter's label and its `aria-valuetext`: one string, so both always agree. */
  valueText: string
  /** What the count means, in a sentence. */
  line: string
}

/**
 * The count, as a meter and a sentence.
 *
 * Total: a negative or absurd count from a vault nobody expected still produces
 * something drawable rather than a broken bar.
 */
export function recoveryView(remaining: number): RecoveryView {
  const safe = Number.isFinite(remaining) ? Math.max(Math.trunc(remaining), 0) : 0
  const issued = Math.max(safe, RECOVERY_CODE_SET_SIZE)
  const spent = issued - safe

  return {
    remaining: safe,
    issued,
    spent,
    tone: toneOf(safe),
    valueText: `${safe} of ${issued} unused`,
    line: lineFor(safe, spent),
  }
}

function toneOf(remaining: number): RecoveryTone {
  if (remaining === 0) return 'negative'
  if (remaining <= 2) return 'warning'
  return 'positive'
}

/*
 * SAYING NOTHING IS ALSO AN ANSWER. A full set is the state the user was left in, and a
 * screen that congratulates them on it is noise. What the sentence covers is the two
 * things they might not have noticed: codes that have been spent, and codes running out.
 */
function lineFor(remaining: number, spent: number): string {
  if (remaining === 0) {
    return (
      'Every code has been used. The passphrase is now the only way into these books — ' +
      'and while you still have it, you can issue a new set below.'
    )
  }
  if (remaining === 1) {
    return (
      'One code is left. It opens these books once, and then the passphrase is the only ' +
      'way in.'
    )
  }
  if (spent === 0) {
    return `All ${remaining} are unused. Each one opens these books once, without the passphrase.`
  }
  return `${spent} ${spent === 1 ? 'has' : 'have'} been used and will never work again. Cross them off your sheet.`
}

/**
 * Whether the Overview should say something about the codes.
 *
 * Two left is the point at which a person can still act on it without hurrying: they can
 * issue a new set, on purpose, from a machine that is already unlocked.
 */
export function isRecoveryLow(remaining: number): boolean {
  return remaining <= 2
}
