/*
 * Running work in the caller's transaction, or in one of our own.
 *
 * ONE FUNCTION, AND IT EXISTS BECAUSE KYSELY REFUSES TO NEST. Measured rather than read:
 * `trx.transaction()` throws `calling the transaction method for a Transaction is not
 * supported` — it does not open a savepoint and it does not quietly join. So a repository
 * function that unconditionally calls `db.transaction()` is a function that cannot be
 * called from inside another one, and the compiler will not tell you: `CofferDb` is the
 * same type either way, and the failure arrives at runtime in whichever code path first
 * tried to compose two writes.
 *
 * That composition is not a nicety here. Issuing a document is ONE transaction spanning
 * four repositories — the numbering counter moves, the posting rule runs, the journal
 * entry is written and the document's status changes, together or not at all (rule 3 in
 * domain/documents/types.ts). Every one of those pieces has to be callable from inside
 * the transaction the piece above it opened.
 *
 * WHAT THIS DOES NOT GIVE YOU IS A NESTED ROLLBACK. Joining a caller's transaction means
 * a failure rolls back everything, including work the caller did before calling. That is
 * exactly what issuing wants — a document that fails to post must not keep the number it
 * spent — and it is the only behaviour available, because SQLite savepoints are not
 * something Kysely exposes. A caller that needs part of its work to survive a failure
 * needs two transactions and has to say so.
 */

import type { CofferDb } from '../kysely'

export async function inTransaction<T>(
  db: CofferDb,
  work: (trx: CofferDb) => Promise<T>,
): Promise<T> {
  return db.isTransaction ? work(db) : db.transaction().execute(work)
}
