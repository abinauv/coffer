/*
 * A refusal raised from inside a regime, as the rest of main can recognise it.
 *
 * A regime's own errors carry its own codes and its own words, and nothing above
 * `regimes/` may import a regime's module to find out what they are (CONVENTIONS §1.6).
 * So each regime's error class extends this one, and the IPC boundary maps this — the
 * code and the message reach the screen, and the boundary never learns which country
 * raised them.
 */

/** A refusal from a regime. Carries a stable, machine-readable code. */
export class RegimeRefusal extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RegimeRefusal'
    this.code = code
  }
}

/** True when `value` is a refusal raised from inside a regime. */
export function isRegimeRefusal(value: unknown): value is RegimeRefusal {
  return value instanceof RegimeRefusal
}
