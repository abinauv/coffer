/*
 * The regime registry — how the rest of the application gets a `TaxRegime`.
 *
 * Exactly one regime exists today, which is precisely why this file has to exist: a
 * registry with one entry costs nothing, and a second regime added without one means
 * hunting down every `import { inGstRegime }` in the codebase. Everything above this
 * layer asks for a regime by id and receives the interface; nothing outside
 * `regimes/in-gst/` should name a concrete regime, and eslint enforces that for
 * `domain/` and the renderer (CONVENTIONS §1.6).
 *
 * A company stores its regime id. Opening a company therefore looks the regime up by a
 * string that came off disk, which is the case `findRegime` exists for — an id that no
 * longer resolves is a real situation (a downgrade, a hand-edited file) and deserves a
 * message about which regimes are installed, not a crash three calls later.
 */

import type { RegimeId, TaxRegime } from './types'
import { inGstRegime } from './in-gst'

export * from './types'
export { RegimeRefusal, isRegimeRefusal } from './errors'

/**
 * The regime a new company gets unless it says otherwise.
 *
 * A default is not a claim that India is special; it is the only regime that exists, and
 * making the caller choose from a list of one would be a worse first-run experience.
 */
export const DEFAULT_REGIME_ID: RegimeId = 'in'

const REGIMES: ReadonlyMap<RegimeId, TaxRegime> = new Map([[inGstRegime.id, inGstRegime]])

/** Every installed regime, for a picker. */
export function availableRegimes(): ReadonlyArray<{ id: RegimeId; label: string }> {
  return [...REGIMES.values()].map((regime) => ({ id: regime.id, label: regime.label }))
}

/** The regime with this id, or undefined. Use this when the id came from outside. */
export function findRegime(id: RegimeId): TaxRegime | undefined {
  return REGIMES.get(id)
}

/** True when a regime with this id is installed. */
export function isRegimeId(id: string): boolean {
  return REGIMES.has(id)
}

/**
 * The regime with this id.
 *
 * Throws when there is none, naming what is installed — the caller asked for something
 * that does not exist, and every figure it was about to compute would have been wrong.
 */
export function getRegime(id: RegimeId): TaxRegime {
  const regime = REGIMES.get(id)
  if (regime === undefined) {
    const installed = [...REGIMES.keys()].join(', ')
    throw new Error(`No tax regime '${id}'. Installed regimes: ${installed}.`)
  }
  return regime
}
