/*
 * The scalar representations that every layer agrees on.
 *
 * A deliberately dependency-free leaf. `domain/`, `db/` and the IPC contract all need
 * these, and the renderer needs them too — so they cannot live in `main/` (the renderer
 * must never import from there) and they should not live in `dto.ts` (the domain layer
 * has no business depending on the transport contract).
 *
 * These are aliases for `string`, not branded types. The guarantee is not in the type —
 * it is in the parse functions in `main/domain/money` and `main/domain/time`, which
 * reject anything malformed at the boundary. The alias documents intent and makes a
 * signature readable; the parser does the enforcing.
 */

/**
 * An exact decimal as text — the storage and transport representation of money,
 * quantity and rate.
 *
 * Never a `number`, at any layer, including JSON crossing IPC. See CONVENTIONS §1.
 */
export type DecimalString = string

/** An ISO-8601 UTC timestamp with milliseconds, e.g. '2026-08-13T09:30:00.000Z'. */
export type Timestamp = string

/** A calendar date, 'YYYY-MM-DD'. No time, no zone. */
export type DateString = string
