/*
 * The offset panel's vocabulary: a credit note set against the invoices it settles.
 *
 * AN OFFSET IS AN ALLOCATION WITH A DOCUMENT WHERE THE VOUCHER WAS, so this file is
 * deliberately the smaller half of that sentence. `receipt-view.ts` already holds the two
 * shapes an editor keeps a set of matches in, and the panel imports them from there
 * rather than getting offset-shaped copies here:
 *
 *   `draftAllocations(open, existing)` — one line per open document, seeded from what is
 *     already matched. `DocumentOffsetDto` structurally satisfies the `{ documentId,
 *     amount }` it reads, so there was nothing to adapt.
 *   `settleInFull(document)` — a copy of the `outstanding` main sent, never a sum. It
 *     takes an `OpenDocument`, which is what the charge picker is filled from.
 *
 * A SECOND COPY OF EITHER IS THE SHAPE THIS CODEBASE KEEPS DELETING. Two functions
 * agreeing today is not a property anything tests, and the day they disagree is the day
 * the panel seeds a line the picker does not list — or fills a box with a figure a rupee
 * off what main will accept. What is below is only what is genuinely different about an
 * offset: which kinds may have one, when the set may be edited, what the list is called,
 * and the one field name that differs on the wire.
 *
 * NOTHING HERE ADDS UP MONEY (§1.7), for receipt-view.ts's reason and with the same
 * consequence: a user typing lines cannot be shown what is left of the note as they type.
 * `setOffsets` returns the note's whole `DocumentSettlement` — movement, allocated,
 * offset, outstanding — computed against the ledger, and the panel redraws from that.
 *
 * THE SET IS EDITED FROM THE REFUND END AND ONLY FROM THERE, which is `SetOffsetsInput`'s
 * decision and `db/repos/offsets.ts`'s header: if both ends could replace an overlapping
 * set, the last save would silently drop rows the other end had never been shown. So
 * every question this file answers is asked ABOUT a credit or debit note. An invoice's
 * screen displays what has been set against it and asks none of them.
 */

import { correctsKind, definitionOf, postsToLedger, type DocumentKind } from '@shared/documents'
import type { OffsetInput } from '@shared/dto'

// ---- Which documents may be set against something ---------------------------

/**
 * Whether this kind of document may be set against charge documents at all.
 *
 * READ OFF THE KIND TABLE, never a list of kinds written out here (§1.9). `correctsKind`
 * derives its mapping from these same two fields, and a hand-written pair would be a
 * second answer agreeing by inspection until a sixth kind is added — at which point the
 * table answers for it and the list does not.
 *
 * A refund kind is the end that owns the set: that is the `direction` half, and it is
 * what excludes an invoice, which is issued, posts, and is still the thing being settled.
 *
 * `postsToLedger` IS THE OTHER HALF AND IT IS DOING MORE THAN IT LOOKS. What an offset
 * draws down is the document's MOVEMENT on the party's control account, so a refund kind
 * that reaches no ledger has nothing to draw down — every line against it would settle a
 * real invoice out of a figure that is not in the books. It is the quotation's argument
 * facing the other way, and `postingKindIn` excludes the quotation for exactly it.
 *
 * NO TEST CAN KILL THAT SECOND CONDITION TODAY, and writing it down is cheaper than the
 * next mutation pass rediscovering it: both refund kinds in the shipped table post, so
 * removing `postsToLedger` changes no answer. `postingKindIn` solves this by taking the
 * table as an argument; the panel that calls this passes a kind and nothing else, so the
 * honest version is this note rather than a parameter no caller has a use for. The test
 * states the rule over every row of the table instead of pretending otherwise.
 */
export function canOffset(kind: DocumentKind): boolean {
  return definitionOf(kind).direction === 'refund' && postsToLedger(kind)
}

/**
 * Whether the offset panel may be EDITED for a document in this state.
 *
 * Two conditions, and each refuses something the other lets through: an issued sales
 * invoice is the wrong END of the match, and a draft credit note is the right end in the
 * wrong state.
 *
 * A DRAFT HAS NO NUMBER AND NOTHING TO OFFSET — it has posted nothing, so there is no
 * movement for a line to draw on. A CANCELLED NOTE'S MOVEMENT NETS TO NOTHING, reversed
 * by a second entry, so a line against it draws on zero. `setOffsets` refuses both ends
 * with one sentence and 0016's trigger refuses them underneath it; repeating the rule
 * here is not defence in depth but a different job. A picker whose save is always refused
 * teaches a user to distrust the panel, when what they needed was to issue the note.
 *
 * `status` is a string rather than `DocumentStatusDto` for `statusLabel`'s reason: what
 * arrives is what main sent, and a status this build does not know is not one this build
 * may edit against.
 */
export function isOffsetEditable(kind: DocumentKind, status: string): boolean {
  return canOffset(kind) && status === 'issued'
}

// ---- What the list is called ------------------------------------------------

/**
 * The heading for the offsets list: what the documents this note settles are called.
 *
 * READ OFF THE DOCUMENT TABLE, not written out here. `settlesLabel` in receipt-view.ts
 * exists to prevent exactly the line this would otherwise be, and `correctsKind` is the
 * mapping 0013 also holds in SQL and `offsetKindFor` reads in main — so a sixth document
 * kind cannot leave this panel calling a bill an invoice, and the heading cannot drift
 * from what the picker under it actually lists.
 *
 * THE PLURAL, because it heads a list of them.
 *
 * IT THROWS FOR A KIND THAT CORRECTS NOTHING, and the alternatives are the reason. An
 * empty heading draws a nameless panel over a picker that can never fill. The document's
 * own plural — "Credit notes" over the list of invoices a credit note settles — is worse,
 * because it reads plausibly, and a wrong answer that agrees with everything around it is
 * the one nobody finds. Neither is reachable by a user: the panel is drawn behind
 * `canOffset`, so a call here for an invoice is a screen asking the wrong end of the
 * match for its offsets, which is a bug in the screen rather than a state a user can get
 * into. `definitionOf` set the precedent of throwing with a sentence naming what could
 * not be answered, and `offsetKindFor` refuses the same call from the main side rather
 * than inventing a kind for it.
 */
export function offsetsLabel(refundKind: DocumentKind): string {
  const chargeKind = correctsKind(refundKind)
  if (chargeKind === null) {
    throw new Error(
      `A ${definitionOf(refundKind).label.toLowerCase()} corrects nothing and settles ` +
        'nothing — it is what gets settled, so it has no offsets to head. Ask canOffset() ' +
        'before drawing the panel.',
    )
  }
  return definitionOf(chargeKind).pluralLabel
}

// ---- What is sent -----------------------------------------------------------

/**
 * The offsets to send, dropping the lines the user left blank.
 *
 * THE TWIN OF `toAllocationInputs`, AND IT EXISTS FOR ONE WORD. `OffsetInput` names its
 * document field `chargeDocumentId` where `AllocationInput` names it `documentId`,
 * because an offset has a document at BOTH ends and the row has to say which end it is.
 * A shared helper parameterised by a key name would cost more to read than the three
 * lines it saves, and would turn the wire shape into a runtime string.
 *
 * A BLANK IS NOT A ZERO. `readAmount` in the repository refuses an offset of nothing — an
 * offset says two documents settle each other, and one of nothing does not — so a row
 * nobody filled in is left out rather than sent as '0.00'. A row typed as `0` IS sent,
 * and main answers it with that sentence: the user meant something by typing it, and
 * dropping it silently would leave them looking at a line the books do not have.
 *
 * The rows go in the order the drafts hold them, which is the order the picker listed the
 * open charges — oldest first, as main sorted them. Nothing here reorders a user's lines.
 */
export function toOffsetInputs(drafts: Readonly<Record<string, string>>): readonly OffsetInput[] {
  return Object.entries(drafts)
    .filter(([, amount]) => amount.trim() !== '')
    .map(([chargeDocumentId, amount]) => ({ chargeDocumentId, amount: amount.trim() }))
}
