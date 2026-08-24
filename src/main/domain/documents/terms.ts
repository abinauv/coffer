/*
 * When a document falls due.
 *
 * One function, and it exists so that "null terms means due on receipt" is decided in one
 * place rather than at each of the call sites that will eventually ask. Migration 0014's
 * backfill says the same thing in SQL — `IFNULL(payment_terms_days, 0)` — and a test in
 * the migrations folder runs the two against each other, which is the only place they are
 * allowed to meet.
 *
 * ---------------------------------------------------------------------------
 * NULL IS NOT UNKNOWN HERE, AND THAT IS WORTH SAYING OUT LOUD
 *
 * `parties.payment_terms_days` is nullable, and the tempting reading of a null is "nobody
 * has said". The reading this takes is "due on receipt", which is the ordinary default for
 * a business that has not negotiated terms with a customer, and it is also the only
 * reading that lets every issued invoice carry a due date.
 *
 * The alternative — a null due date for a party with no terms — costs more than it looks.
 * An aged report would then have a bucket of documents it cannot place, and the natural
 * thing for a reader to do with those is to treat them as not yet due, which is the
 * opposite of the truth: money owed with no terms is owed NOW.
 *
 * ---------------------------------------------------------------------------
 * WHY NEGATIVE DAYS ARE A CRASH RATHER THAN A CLAMP
 *
 * `addDays` subtracts happily, so a party carrying -30 would produce an invoice that fell
 * due a month before it was raised. Three layers already refuse to store one — the column
 * CHECK, the IPC validator and the parties repository — so a negative arriving here means
 * a caller has invented it, and the honest answer to a state that cannot happen is to say
 * so rather than to quietly pick a different number.
 *
 * Clamping to zero would be worse than the crash in the way that matters: the document
 * would issue, the books would balance, and the only sign would be a due date a month
 * early on one invoice out of a thousand.
 */

import { addDays, type DateString } from '../time'

/**
 * The date an obligation raised on `documentDate` matures.
 *
 * Whether a kind HAS one is a different question, answered by `chargesOnTerms` in
 * shared/documents.ts. This one is only the arithmetic, so it is callable for a preview
 * before anything is issued.
 */
export function dueDateFor(documentDate: DateString, paymentTermsDays: number | null): DateString {
  const days = paymentTermsDays ?? 0
  if (!Number.isSafeInteger(days) || days < 0) {
    throw new Error(
      `Payment terms of ${String(paymentTermsDays)} days cannot produce a due date. ` +
        'Terms are a whole number of days, and never negative.',
    )
  }
  return addDays(documentDate, days)
}
