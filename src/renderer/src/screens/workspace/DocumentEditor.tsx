/*
 * One document: drafting it, issuing it, cancelling it. All five kinds, one component.
 *
 * WAS `Invoice.tsx`. A credit note, a purchase bill and a debit note reached the ledger in
 * 0013-1 and had no screen; a quotation had been issuable since 0010 and had none either.
 * They differ from an invoice in what the party is called, what their own reference means,
 * whether issuing posts anything, and — for the two corrections — whether they name a
 * document they correct. Everything else on this screen is identical for all five, which
 * is what one table for five kinds was for.
 *
 * THE FIGURES ON THIS SCREEN ARE ALWAYS MAIN'S. A user typing a quantity expects a line
 * total to follow and this screen will not produce one — `quantity x unitPrice` is money
 * arithmetic and the tax is the regime's answer (CONVENTIONS §1.7). So the draft is
 * SAVED and what came back is shown. While there are unsaved edits the totals are marked
 * as belonging to the last saved version rather than quietly redrawn: a stale figure that
 * says it is stale is honest, and a fresh-looking figure the renderer invented is not.
 *
 * That is not a workaround. Every screen in this product shows figures main computed, and
 * a tax document is the one place where being wrong by a paisa is a filing that does not
 * reconcile.
 *
 * THE PLACE OF SUPPLY IS OMITTED UNLESS THE USER TOUCHES IT, and this is the subtlest
 * thing on the screen. Nothing on a document records whether its place was derived or
 * stated. `documents.update` re-derives when the party changed and the caller said
 * nothing, and keeps what is stored otherwise — so a screen that helpfully sent the place
 * it was displaying would pin a Tamil Nadu place of supply onto an invoice just moved to
 * a Karnataka customer, and CGST+SGST would stay where IGST belongs. Sending nothing is
 * how the screen says "you decide". See `placeTouched` below.
 *
 * WHAT IS OUTSTANDING IS SHOWN, AND IT IS NOT A FIELD ON THE DOCUMENT. It is the movement
 * the document made on the party's account less what has been receipted against it, and
 * it is asked for separately because that is what it is — a fact about the ledger, not a
 * column somebody would have to keep in step. A cancelled document comes back at nothing
 * with no code written to make it so.
 *
 * EVERY KIND THAT POSTS SHOWS THAT PANEL AS OF 0015, and until then only a CHARGE did.
 * The reason it was gated is worth keeping, because it was not the panel that was wrong:
 * a credit note's movement is negative, so its "outstanding" was money owed BACK with no
 * screen anywhere to act on it, and a Record-a-receipt button beside it offered an
 * operation that did not exist. Both halves of that are now false. `settlementFor` reads
 * the figure in the DOCUMENT's own facing, so a credit note's outstanding is what is left
 * to refund rather than a negative; and the button reaches the refund editor, which
 * exists.
 *
 * AND WHAT WAS OFFSET RATHER THAN PAID IS SHOWN TOO, AS OF 0016. A credit note set
 * against an invoice moves no money and settles it just the same, so until this landed an
 * invoice reduced by one showed a smaller outstanding with nothing on the page to explain
 * it. `allocated` and `offset` arrive as two figures and are printed as two rows above two
 * lists: "who paid this" and "what did we credit against it" are different questions, and
 * a screen that added them together would answer neither.
 *
 * A LINE NAMES THE ITEM IT IS, AS OF 0017, AND THAT IS NOT ONLY A NEW COLUMN. `itemId`,
 * `unitCode`, `isCharge` and `accountId` were on the contract from the start, validated by
 * the handler, stored by the repository and honoured by the posting rule — and this screen
 * held none of them. So every line was free text, the item master had no consumer at all,
 * and OPENING A SAVED DOCUMENT AND PRESSING SAVE WROTE BACK LINES WITH ALL FOUR STRIPPED
 * OFF. Nothing on screen changed when it happened. That was the bug; the pickers are what
 * make the fields reachable now that they survive a round trip.
 *
 * AND A LINE IS A COPY OF AN ITEM, NEVER A REFERENCE TO ONE. Picking one fills the
 * description, the unit, the rate, the classification and — on a sale — the price, and the
 * line owns those figures from that instant: `dto.ts` is explicit that a line stores its
 * own, so that repricing an item next year cannot rewrite an invoice already issued. Which
 * settles the question the picker raises: after somebody edits the description, is it still
 * that item? It is. The id is what the line IS and the text is what was PRINTED, and only
 * clearing the picker says it was never that item.
 *
 * THE PANEL THAT EDITS THE MATCH LIVES ON THE REFUND DOCUMENT, AND ONLY THERE. A credit
 * note is a pool of money drawn down by refunds and offsets, which is exactly a receipt's
 * shape — so it gets the receipt editor's allocation table, and the invoice at the other
 * end shows the result read-only. Letting either end own the set would mean two screens
 * replacing overlapping sets, and the last one saved would silently drop the other's rows
 * (`SetOffsetsInput`). `Offsets` below is the picker; `Settlement` draws the list.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Badge, Button, Input, Select } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import { makeRoute } from '@renderer/lib/routing'
import { registerScreens, type ScreenContext, type ScreenDefinition } from '@renderer/lib/screens'
import { useNumberFormat, useRegime } from '@renderer/store/regime'
import { useToasts } from '@renderer/store/toasts'
import {
  correctsKind,
  definitionOf,
  DOCUMENT_KINDS,
  opposite,
  postingKindOn,
  type DocumentKind,
} from '@shared/documents'
import { receiptDefinitionOf, settledBy, type ReceiptKind } from '@shared/receipts'
import type {
  Account,
  AppError,
  Document,
  DocumentLineInput,
  DocumentSettlement,
  DocumentSummary,
  ItemSummary,
  OpenDocument,
  PartySummary,
  RegimeDescription,
  UnitOfMeasure,
} from '@shared/dto'
import { CheckboxField } from '../components/CheckboxField'
import { FailureNotice } from '../components/FailureNotice'
import { Notice } from '../components/Notice'
import { ScreenFrame } from '../components/ScreenFrame'
import { formatAmount } from '../lib/ledger-format'
import {
  editorScreenId,
  isStruckStatus,
  partyLabel,
  partyReferenceHint,
  partyReferenceLabel,
  partyRoleFor,
  registerScreenId,
  statusLabel,
  statusTone,
} from '../lib/document-view'
import {
  blankLine,
  canCancel,
  canDelete,
  canEdit,
  canIssue,
  clearItem,
  isBlankDraft,
  itemSideFor,
  lineDraftOf,
  lineFromItem,
  linesFrom,
  postableAccounts,
  readyLines,
  stateSentence,
  toLineInput,
  type LineDraft,
} from '../lib/document-editor'
import { canOffset, isOffsetEditable, offsetsLabel, toOffsetInputs } from '../lib/offset-view'
/* The two halves of a receipt's allocation panel that are not about receipts. An offset
 * row is an allocation row with a document where the voucher was, so the shapes are the
 * same shapes — `DocumentOffsetDto` satisfies what `draftAllocations` reads, and
 * `settleInFull` copies the figure main sent rather than working one out. */
import { draftAllocations, settleInFull } from '../lib/receipt-view'

export function DocumentEditor({
  kind,
  route,
  navigate,
}: ScreenContext & { kind: DocumentKind }): JSX.Element {
  const documentId = route.params['id'] ?? null
  const { show } = useToasts()
  const regime = useRegime()
  const format = useNumberFormat()

  const definition = definitionOf(kind)
  const label = definition.label.toLowerCase()
  const corrects = correctsKind(kind)
  /*
   * The voucher that settles THIS KIND, which is also its editor's route id. Derived
   * rather than named, because 0013-2 shipped this as `'receipt'` with the purchase side
   * gated off — the payment editor did not exist, and a button reaching an unregistered
   * screen would have landed a user on a blank page. It exists as of 0013-3, and one
   * lookup replaces both the literal and the gate.
   *
   * NULL FOR A QUOTATION, which is 0015 saying out loud what was previously true by
   * accident: the side-only version answered `'receipt'` for one, and the settlement
   * panel's `postsToLedger` gate was the only thing stopping a button offering to receipt
   * a quotation. The gate is still there and now agrees with the value rather than
   * covering for it.
   */
  const settlesWith = settledBy(kind)
  /*
   * THE KIND AT THE OTHER END OF AN OFFSET, which is never this one.
   *
   * A charge document's offsets are refund documents and a refund document's are charges,
   * so one lookup answers for both ends and there is no branch to type backwards — see
   * `opposite`, which exists because this is its second spelling. It names the rows in the
   * settlement panel: the credit notes listed under an invoice, and the invoices a credit
   * note's own figure was taken by.
   *
   * `offsetsLabel` CANNOT ANSWER THIS AND IS NOT MEANT TO. It reads a REFUND kind and
   * names what that kind settles, which is the picker's heading on a credit note; asked
   * about an invoice it refuses, because an invoice settles nothing.
   */
  const offsetEndKind = postingKindOn(definition.side, opposite(definition.direction))

  const [document, setDocument] = useState<Document | null>(null)
  const [parties, setParties] = useState<PartySummary[]>([])
  /*
   * The three master lists a LINE is picked from, read once beside the parties.
   *
   * READ EVEN WHEN THE DOCUMENT CANNOT BE EDITED, and that is the point of loading them
   * here rather than behind `isEditable`. An issued invoice still has to show WHICH item
   * each line was, and a picker whose options never arrived would draw a stored item as a
   * blank field — the `<select>` failure this project keeps writing down: the option is
   * missing, so the control falls back to the first one and reads as though a choice had
   * been made.
   *
   * EMPTY IS A NORMAL ANSWER FOR ALL THREE, not a failure to load. `setUpBooks` seeds no
   * units at all, so a company opened for the first time has none, and a business that has
   * not built an item master yet enters free text — which is what every line was until
   * 0017 and stays entirely legal.
   */
  const [items, setItems] = useState<ItemSummary[]>([])
  const [units, setUnits] = useState<UnitOfMeasure[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [error, setError] = useState<AppError | null>(null)
  const [isBusy, setBusy] = useState(false)
  const [isReading, setReading] = useState(documentId !== null)

  const [partyId, setPartyId] = useState('')
  const [date, setDate] = useState('')
  const [partyReference, setPartyReference] = useState('')
  const [narration, setNarration] = useState('')
  const [lines, setLines] = useState<LineDraft[]>([blankLine()])

  /* The document this one corrects, where the kind may name one. '' is "none", which is
   * legal: one credit note against several invoices has been allowed since 2019, so the
   * column is nullable and this picker has an empty option that means it. */
  const [originalId, setOriginalId] = useState('')
  const [originals, setOriginals] = useState<DocumentSummary[]>([])

  /* See the header. Only an explicit choice is sent, so that a party change re-asks the
   * regime instead of having the displayed place pinned back on. */
  const [place, setPlace] = useState('')
  const [placeTouched, setPlaceTouched] = useState(false)

  /* Unsaved edits. What makes the totals panel say what it is showing. */
  const [isDirty, setDirty] = useState(false)

  /* What has been receipted against it. Null until asked, and only asked for a document
   * that has posted — a draft has made no movement, so there is nothing to be against. */
  const [settlement, setSettlement] = useState<DocumentSettlement | null>(null)

  /* The charges this refund document may be set against, and the amounts the panel holds
   * for them. Keyed by document for the reason the receipt editor's are: 0016's UNIQUE
   * means one row per charge, so there is nothing to add and nothing to remove.
   *
   * NULL UNTIL ASKED, and that is not the same as an empty list. "They have nothing
   * outstanding" is a sentence this panel says out loud; saying it while the answer is
   * still in flight would be telling the user something nobody has looked up yet. */
  const [openCharges, setOpenCharges] = useState<OpenDocument[] | null>(null)
  const [offsetDrafts, setOffsetDrafts] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    /* The item list is asked for THIS SIDE — what is sold on a sales document, what is
     * bought on a purchase one. An item is very often both, so this narrows the picker
     * rather than saying what the item is (`itemSideFor`). Archived items and archived
     * units are left out by both defaults, which is what a picker wants. */
    const [people, catalogue, measures, chart] = await Promise.all([
      callApi((api) => api.parties.list({ role: partyRoleFor(definition.side) })),
      callApi((api) => api.items.list({ side: itemSideFor(definition.side) })),
      callApi((api) => api.units.list()),
      callApi((api) => api.ledger.listAccounts()),
    ])
    if (people.ok) setParties(people.data)
    if (catalogue.ok) setItems(catalogue.data)
    if (measures.ok) setUnits(measures.data)
    /* Never a group, never an archived one — see `postableAccounts`. */
    if (chart.ok) setAccounts([...postableAccounts(chart.data)])

    if (documentId === null) {
      setReading(false)
      return
    }

    const result = await callApi((api) => api.documents.get(documentId))
    setReading(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    if (result.data === null) {
      setError({
        code: 'DOCUMENT_NOT_FOUND',
        message: `That ${label} is no longer in these books.`,
      })
      return
    }
    /*
     * THE ONE HAZARD ONE EDITOR FOR FIVE KINDS CREATES. The kind comes from the route and
     * the id comes from the route, independently — so a link built by hand, or a Back
     * that reaches this screen with a stale id, can load an invoice into the credit note
     * editor. Everything would look ordinary: the heading would say Credit note, the
     * corrections picker would appear, and the save would be refused by 0013's trigger
     * naming a document the user had just been shown.
     *
     * `Document.kind` is a `string` at the boundary on purpose, so this compares strings.
     * A company file written by a newer build lands here too, which is the right place
     * for it: a kind this build cannot draw is a kind it should not draw.
     */
    if (result.data.kind !== kind) {
      setError({
        code: 'DOCUMENT_KIND_MISMATCH',
        message: `That document is not a ${label}. Open it from its own register.`,
      })
      return
    }
    adopt(result.data)
  }, [definition.side, documentId, kind, label])

  /** Take main's answer as the truth, and clear the unsaved-edits mark. */
  function adopt(next: Document): void {
    setDocument(next)
    setPartyId(next.partyId)
    setDate(next.date)
    setPartyReference(next.partyReference ?? '')
    setNarration(next.narration)
    setLines(next.lines.length === 0 ? [blankLine()] : next.lines.map(lineDraftOf))
    setOriginalId(next.originalDocumentId ?? '')
    setPlace(next.placeOfSupplyJurisdiction ?? '')
    setPlaceTouched(false)
    setDirty(false)
    setError(null)
  }

  useEffect(() => {
    void load()
  }, [load])

  /*
   * WHAT THIS DOCUMENT MAY CORRECT, for the party it is against.
   *
   * Re-read when the party changes, because the answer is entirely about them: 0013's
   * trigger refuses a link to another party's invoice, so a picker that kept the old
   * party's list would offer choices the database will reject.
   *
   * Only issued documents, which is also why a link that is already stored is always in
   * the list: 0013 refuses to cancel a document something corrects, so the original of a
   * saved correction cannot have left `issued` while the correction exists.
   */
  useEffect(() => {
    let current = true
    if (corrects === null || partyId === '') {
      setOriginals([])
      return
    }

    void callApi((api) => api.documents.list({ kind: corrects, status: 'issued', partyId })).then(
      (result) => {
        if (!current) return
        if (result.ok) setOriginals(result.data)
      },
    )

    return () => {
      current = false
    }
  }, [corrects, partyId])

  /*
   * Read after the document, and again after anything that could move it. The guard
   * against a stale answer is the usual one: a document cancelled while this was in
   * flight would otherwise paint an outstanding figure over one that owes nothing.
   */
  const documentStatus = document?.status ?? null
  const isSettleable = definition.postsToLedger
  const settledId =
    document !== null && isSettleable && documentStatus !== 'draft' ? document.id : null

  useEffect(() => {
    let current = true
    if (settledId === null) {
      setSettlement(null)
      return
    }

    void callApi((api) => api.documents.settlement(settledId)).then((result) => {
      if (!current) return
      if (result.ok) setSettlement(result.data)
    })

    return () => {
      current = false
    }
  }, [settledId, documentStatus])

  /*
   * WHAT THIS REFUND DOCUMENT MAY BE SET AGAINST.
   *
   * Asked for only where the save would be accepted — `isOffsetEditable` — because a
   * picker on a draft or a cancelled note is a list of choices main refuses one by one,
   * and `openForOffset` itself refuses a charge document by name: a sales invoice settles
   * nothing, it is what gets settled.
   *
   * RE-READ WHENEVER THE SETTLEMENT MOVES, and that is the half worth reading twice.
   * `documents.offset` answers with the new settlement, so adopting it is enough to make
   * the FIGURES right — and every OUTSTANDING in this picker is a figure about a different
   * document, which settling one of them has just changed. A panel that adopted the answer
   * and left the rows alone would show what each invoice had left before the save.
   *
   * The drafts are seeded from `settlement.offsets` rather than kept, for the same reason
   * every other panel on this screen takes main's answer as the truth.
   */
  const offsetId = document !== null && isOffsetEditable(kind, document.status) ? document.id : null

  useEffect(() => {
    let current = true
    if (offsetId === null || settlement === null) {
      setOpenCharges(null)
      setOffsetDrafts({})
      return
    }

    void callApi((api) => api.documents.openForOffset(offsetId)).then((result) => {
      if (!current) return
      if (!result.ok) {
        setError(result.error)
        return
      }
      setOpenCharges(result.data)
      setOffsetDrafts(draftAllocations(result.data, settlement.offsets))
    })

    return () => {
      current = false
    }
  }, [offsetId, settlement])

  const touch = useCallback((change: () => void) => {
    setDirty(true)
    change()
  }, [])

  /*
   * GENERIC IN THE FIELD, because one field on a row is not a string. `isCharge` is a
   * checkbox and a `value: string` signature would have it arriving as `'true'` — a
   * string the repository would store as truthy for ever, including the string `'false'`.
   * Written this way the compiler pairs each field with its own type at every call site.
   */
  const setLine = useCallback(
    <K extends keyof LineDraft>(key: string, field: K, value: LineDraft[K]) =>
      touch(() =>
        setLines((current) =>
          current.map((line) => (line.key === key ? { ...line, [field]: value } : line)),
        ),
      ),
    [touch],
  )

  /* Looked up by id rather than searched. `.find` over a list is how "the one that
   * matches" quietly becomes "whichever is listed first" (CONVENTIONS §1.9), and a picker
   * is exactly where that would go unnoticed — the wrong item would still have a name. */
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item] as const)), [items])

  /*
   * Choosing the item a line is, and filling the line in from it.
   *
   * SEEDED, NOT REFERENCED. `lineFromItem` copies the item's defaults into the boxes and
   * the line owns them from that moment: nothing re-reads the item on save, so repricing
   * it next year cannot rewrite what this invoice said (`dto.ts`, Units and items).
   *
   * WHICH MEANS EDITING THE TEXT DOES NOT UNPICK THE ITEM. The id is what the line IS and
   * the description is what was PRINTED, and a business that types "Ball bearing 6203 —
   * as agreed on the phone" over an item's name has changed the printing, not the goods.
   * Clearing the picker is the one thing that says it was never that item, and it leaves
   * every box exactly as it stands (`clearItem`).
   */
  const chooseItem = useCallback(
    (key: string, itemId: string) => {
      const item = itemsById.get(itemId)
      touch(() =>
        setLines((current) =>
          current.map((line) => {
            if (line.key !== key) return line
            return item === undefined ? clearItem(line) : lineFromItem(line, item, definition.side)
          }),
        ),
      )
    },
    [definition.side, itemsById, touch],
  )

  /*
   * Choosing the document this one corrects, and copying its lines into an empty draft.
   *
   * A full return is the common case and retyping an invoice to record one is the kind of
   * work software exists to remove. What is copied is what a person typed — description,
   * quantity, price, discount, rate — and nothing derived: the tax is asked of the regime
   * again on save, against this document's own date. See `linesFrom`.
   *
   * ONLY INTO AN EMPTY DRAFT. Changing the picker after typing lines leaves them alone,
   * because the alternative is a screen that silently discards work when somebody
   * corrects a mis-click.
   */
  const chooseOriginal = useCallback(
    async (next: string) => {
      touch(() => setOriginalId(next))
      if (next === '' || !isBlankDraft(lines)) return

      const result = await callApi((api) => api.documents.get(next))
      if (!result.ok || result.data === null) return
      setLines(linesFrom(result.data))
    },
    [lines, touch],
  )

  const status = document?.status ?? 'draft'
  const isEditable = document === null || canEdit(status)
  const sendable = readyLines(lines)
  const canSave = partyId !== '' && date !== '' && sendable.length > 0 && !isBusy && isEditable

  /** What every save and create sends, minus the id. */
  const payload = useCallback(
    (): {
      date: string
      partyId: string
      partyReference: string
      narration: string
      lines: DocumentLineInput[]
      placeOfSupplyJurisdiction?: string
      originalDocumentId?: string | null
    } => ({
      date,
      partyId,
      partyReference: partyReference.trim(),
      narration: narration.trim(),
      lines: sendable.map(toLineInput),
      /* Omitted unless chosen — see the header. */
      ...(placeTouched && place !== '' ? { placeOfSupplyJurisdiction: place } : {}),
      /* Sent as null rather than omitted when cleared, because absent means "leave it" on
       * an update and this picker's empty option means "it names none". Omitted entirely
       * for a kind that corrects nothing, which 0013's trigger refuses a link on. */
      ...(corrects === null ? {} : { originalDocumentId: originalId === '' ? null : originalId }),
    }),
    [corrects, date, narration, originalId, partyId, partyReference, place, placeTouched, sendable],
  )

  const save = useCallback(async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)

    const result = await callApi((api) =>
      document === null
        ? api.documents.create({ kind, ...payload() })
        : api.documents.update({ id: document.id, ...payload() }),
    )
    setBusy(false)

    if (!result.ok) {
      setError(result.error)
      return
    }

    const wasNew = document === null
    adopt(result.data)
    if (wasNew) {
      /* The route now names the draft that exists, so Back and the title bar agree with
       * what is on screen. `ScreenContext.navigate` pushes and takes no mode, so Back
       * from here reaches the empty editor — which is a new-document screen that creates
       * nothing until asked, not a second draft. */
      navigate(makeRoute('workspace', editorScreenId(kind), { id: result.data.id }))
    }
    show({
      tone: 'success',
      title: wasNew ? 'Draft created' : 'Saved',
      body: definition.postsToLedger
        ? 'Nothing is in the books until it is issued.'
        : 'Issuing it will number it and send it. It reaches the books either way — a quotation posts nothing.',
    })
  }, [canSave, definition.postsToLedger, document, kind, navigate, payload, show])

  const issue = useCallback(async () => {
    if (document === null) return
    setBusy(true)
    setError(null)
    const result = await callApi((api) => api.documents.issue({ id: document.id }))
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    adopt(result.data)
    show({
      tone: 'success',
      title: 'Issued',
      body: definition.postsToLedger
        ? `${result.data.number ?? `The ${label}`} is in the books. To undo it, cancel it — the number is kept.`
        : `${result.data.number ?? `The ${label}`} is numbered and sent. It puts nothing in the books.`,
    })
  }, [definition.postsToLedger, document, label, show])

  const cancel = useCallback(async () => {
    if (document === null) return
    setBusy(true)
    setError(null)
    const result = await callApi((api) => api.documents.cancel({ id: document.id }))
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    adopt(result.data)
    show({
      tone: 'success',
      title: 'Cancelled',
      body: definition.postsToLedger
        ? 'What it posted has been reversed. The number is kept, so the series has no hole.'
        : 'The number is kept, so the series has no hole. There was nothing posted to reverse.',
    })
  }, [definition.postsToLedger, document, show])

  const remove = useCallback(async () => {
    if (document === null) return
    setBusy(true)
    setError(null)
    const result = await callApi((api) => api.documents.delete(document.id))
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    show({
      tone: 'success',
      title: 'Deleted',
      body: 'The draft is gone. Nothing was in the books.',
    })
    navigate(makeRoute('workspace', registerScreenId(kind)))
  }, [document, kind, navigate, show])

  const setOffsetAmount = useCallback(
    (chargeDocumentId: string, value: string) =>
      setOffsetDrafts((current) => ({ ...current, [chargeDocumentId]: value })),
    [],
  )

  /*
   * Save what this refund document settles: THE WHOLE SET, never a patch.
   *
   * An empty list is a legitimate save rather than a no-op — it takes every offset off and
   * puts the credit back on account, which is the only way back from a match somebody
   * regrets. So the button is not gated on a row being filled in.
   *
   * IT DOES NOT MARK THE DOCUMENT DIRTY EITHER. Nothing here edits the document: an offset
   * moves no money, writes no entry and changes no total, so a totals panel that called
   * itself stale because somebody matched an invoice would be saying something untrue.
   * What the save does move is the settlement, which it adopts.
   */
  const saveOffsets = useCallback(async () => {
    if (document === null) return
    setBusy(true)
    setError(null)

    const result = await callApi((api) =>
      api.documents.offset({
        refundDocumentId: document.id,
        offsets: toOffsetInputs(offsetDrafts),
      }),
    )
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }

    setSettlement(result.data)
    show({
      tone: 'success',
      title: 'Saved',
      body:
        `Nothing moved in the ledger — this only says which ` +
        `${offsetsLabel(kind).toLowerCase()} this ${label} settles.`,
    })
  }, [document, kind, label, offsetDrafts, show])

  if (isReading) {
    return (
      <ScreenFrame isInset width="list" title={definition.label}>
        <p className="prose prose--muted">Reading the {label}…</p>
      </ScreenFrame>
    )
  }

  return (
    <ScreenFrame
      isInset
      width="list"
      title={document?.number ?? `New ${label}`}
      lede={stateSentence(kind, status, document?.number ?? null, document?.dueDate ?? null)}
      actions={
        <>
          <Button
            variant="ghost"
            onClick={() => navigate(makeRoute('workspace', registerScreenId(kind)))}
          >
            Back to the register
          </Button>
          {isEditable && (
            <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
              {document === null ? 'Create draft' : 'Save'}
            </Button>
          )}
        </>
      }
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="ledger" />}

        {document !== null && (
          <div className="toolbar">
            <Badge tone={statusTone(status)} isStruck={isStruckStatus(status)}>
              {statusLabel(status)}
            </Badge>
            {canIssue(status) && (
              <Button variant="primary" disabled={isBusy || isDirty} onClick={() => void issue()}>
                Issue
              </Button>
            )}
            {canCancel(status) && (
              <Button variant="ghost" disabled={isBusy} onClick={() => void cancel()}>
                Cancel this {label}
              </Button>
            )}
            {canDelete(status) && (
              <Button variant="ghost" disabled={isBusy} onClick={() => void remove()}>
                Delete draft
              </Button>
            )}
          </div>
        )}

        {/* Issuing with unsaved edits would number and post the SAVED version, which is
            not what is on screen. Saying so is better than saving silently. */}
        {isDirty && document !== null && canIssue(status) && (
          <Notice tone="info" title="There are unsaved changes">
            <p>
              Save them first — issuing would number and{' '}
              {definition.postsToLedger ? 'post' : 'send'} the {label} as it was last saved.
            </p>
          </Notice>
        )}

        <div className="stack">
          <Select
            label={partyLabel(definition.side)}
            value={partyId}
            disabled={!isEditable}
            onChange={(event) => touch(() => setPartyId(event.target.value))}
          >
            <option value="">Choose a {partyLabel(definition.side).toLowerCase()}</option>
            {parties.map((party) => (
              <option key={party.id} value={party.id}>
                {party.name}
              </option>
            ))}
          </Select>

          {corrects !== null && (
            <Corrects
              kind={kind}
              corrects={corrects}
              value={originalId}
              options={originals}
              isEditable={isEditable}
              hasParty={partyId !== ''}
              onChange={(next) => void chooseOriginal(next)}
            />
          )}

          <Input
            label="Date"
            type="date"
            value={date}
            disabled={!isEditable}
            onChange={(event) => touch(() => setDate(event.target.value))}
          />

          <Input
            label={partyReferenceLabel(definition.side)}
            value={partyReference}
            disabled={!isEditable}
            hint={partyReferenceHint(definition.side)}
            onChange={(event) => touch(() => setPartyReference(event.target.value))}
          />

          <PlaceOfSupply
            regime={regime}
            label={label}
            value={place}
            isEditable={isEditable}
            isTouched={placeTouched}
            onChange={(next) => {
              setPlaceTouched(true)
              touch(() => setPlace(next))
            }}
          />

          <Input
            label="Narration"
            value={narration}
            disabled={!isEditable}
            hint={
              definition.postsToLedger
                ? 'What the day book will say about the entry this posts.'
                : 'A note for whoever reads it. This posts nothing, so it reaches no day book.'
            }
            onChange={(event) => touch(() => setNarration(event.target.value))}
          />
        </div>

        <Lines
          lines={lines}
          rates={regime?.taxRates ?? []}
          items={items}
          units={units}
          accounts={accounts}
          isEditable={isEditable}
          onChange={setLine}
          onChooseItem={chooseItem}
          onAdd={() => touch(() => setLines((current) => [...current, blankLine()]))}
          onRemove={(key) =>
            touch(() =>
              setLines((current) => {
                const left = current.filter((line) => line.key !== key)
                return left.length === 0 ? [blankLine()] : left
              }),
            )
          }
        />

        {document !== null && <Totals document={document} isStale={isDirty} format={format} />}

        {offsetId !== null && openCharges !== null && (
          <Offsets
            charges={openCharges}
            kind={kind}
            label={label}
            values={offsetDrafts}
            format={format}
            isBusy={isBusy}
            onChange={setOffsetAmount}
            onSave={() => void saveOffsets()}
          />
        )}

        {settlement !== null && settlesWith !== null && (
          <Settlement
            settlement={settlement}
            label={label}
            settlesWith={settlesWith}
            offsetEndKind={offsetEndKind}
            isOffsetEdited={canOffset(kind)}
            format={format}
            onRecordMoney={() =>
              navigate(
                makeRoute('workspace', settlesWith, {
                  partyId: document?.partyId ?? '',
                  documentId: settlement.documentId,
                }),
              )
            }
          />
        )}
      </div>
    </ScreenFrame>
  )
}

// ---- The document this one corrects -----------------------------------------

/**
 * The picker for the document a credit or debit note corrects.
 *
 * OPTIONAL, AND THE EMPTY OPTION SAYS WHY. Since the 2019 amendment to section 34 one
 * credit note may cover several invoices — the post-sale discount a distributor settles
 * at quarter end is exactly that — so a required field would refuse a document the law
 * permits. GSTR-1 table 9B wants the original where there is one, which is why the field
 * exists at all and why it is asked for rather than derived: two invoices to the same
 * customer in the same month for the same amount are ordinary, and nothing in the figures
 * says which one a credit note undid.
 *
 * IT NEEDS THE PARTY FIRST, and says so rather than showing an empty list. 0013's trigger
 * refuses a link to another party's document, so until a party is chosen there is nothing
 * this could honestly offer.
 */
function Corrects({
  kind,
  corrects,
  value,
  options,
  isEditable,
  hasParty,
  onChange,
}: {
  kind: DocumentKind
  corrects: DocumentKind
  value: string
  options: readonly DocumentSummary[]
  isEditable: boolean
  hasParty: boolean
  onChange: (next: string) => void
}): JSX.Element {
  const correctedLabel = definitionOf(corrects).label.toLowerCase()
  const ownLabel = definitionOf(kind).label.toLowerCase()

  return (
    <Select
      label={`The ${correctedLabel} this corrects`}
      value={value}
      disabled={!isEditable || !hasParty}
      hint={
        hasParty
          ? `Optional. Filling it in puts the original on the return, and choosing one into an empty ${ownLabel} copies its lines across for you to edit.`
          : `Choose a ${partyLabel(definitionOf(kind).side).toLowerCase()} first — a ${ownLabel} may only correct their own ${correctedLabel}s.`
      }
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">None — this covers more than one, or none</option>
      {options.map((original) => (
        <option key={original.id} value={original.id}>
          {original.number} · {original.date}
        </option>
      ))}
    </Select>
  )
}

// ---- What a credit or debit note settles ------------------------------------

/**
 * The charges this refund document may be set against, and how much of each it settles.
 *
 * A RECEIPT'S ALLOCATION TABLE, BECAUSE A CREDIT NOTE IS A RECEIPT'S SHAPE. It is a pool
 * of money drawn down by refunds and by offsets, so what a user does with it is what they
 * do with a receipt: say which of the party's charges it pays, and by how much. The rows
 * are the documents themselves — 0016's UNIQUE allows one offset per pair, so there is one
 * line per charge and no way to add or remove one.
 *
 * NOTHING HERE ADDS UP MONEY. "Settle in full" copies `outstanding`, which main computed
 * against the ledger; the renderer does not sum the boxes to show what is left of the note
 * (CONVENTIONS §1.7) — the panel below shows what came back from the last save instead.
 *
 * THE FIRST COLUMN IS READ OFF THE KIND TABLE, through `offsetsLabel`. A debit note
 * settles purchase bills, and calling one an invoice here would be the first place a user
 * learned the wrong word for their own paperwork — which is the mistake `settlesLabel` was
 * written to prevent on the voucher screens and this is the same mistake.
 */
function Offsets({
  charges,
  kind,
  label,
  values,
  format,
  isBusy,
  onChange,
  onSave,
}: {
  charges: readonly OpenDocument[]
  /** This document's own kind, which is a refund kind: the panel is drawn behind
   * `isOffsetEditable`, and `offsetsLabel` refuses anything else by name. */
  kind: DocumentKind
  label: string
  values: Readonly<Record<string, string>>
  format: Parameters<typeof formatAmount>[1]
  isBusy: boolean
  onChange: (chargeDocumentId: string, value: string) => void
  onSave: () => void
}): JSX.Element {
  const charged = offsetsLabel(kind)

  if (charges.length === 0) {
    return (
      <Notice tone="info" title={`There is nothing of theirs to set this ${label} against`}>
        <p>
          Their open {charged.toLowerCase()} appear here, oldest first. Until one exists, the{' '}
          {label} stays on account — which is an ordinary thing for a business to hold, not an
          unfinished job.
        </p>
      </Notice>
    )
  }

  return (
    <div className="stack stack--tight">
      <table className="ledger-table ledger-table--figures">
        <thead>
          <tr>
            <th scope="col">{charged}</th>
            <th scope="col">Date</th>
            <th scope="col" className="ledger-table__figure">
              Total
            </th>
            <th scope="col" className="ledger-table__figure">
              Outstanding
            </th>
            <th scope="col" className="ledger-table__figure">
              Set against it
            </th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {charges.map((charge) => (
            <tr key={charge.id} className="ledger-table__row">
              <td className="ledger-table__code">{charge.number}</td>
              <td className="ledger-table__code">{charge.date}</td>
              <td className="ledger-table__figure">{formatAmount(charge.grandTotal, format)}</td>
              <td className="ledger-table__figure">{formatAmount(charge.outstanding, format)}</td>
              <td className="ledger-table__figure">
                <Input
                  label={`Set against ${charge.number}`}
                  isLabelHidden
                  value={values[charge.id] ?? ''}
                  placeholder="0.00"
                  onChange={(event) => onChange(charge.id, event.target.value)}
                />
              </td>
              <td>
                {/* A COPY of what main sent, never a sum — see `settleInFull`. */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onChange(charge.id, settleInFull(charge))}
                >
                  Settle in full
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* THE WHOLE SET CROSSES, and an empty one is a real answer: it takes every offset
          off and puts the credit back on account. So this is never disabled for want of a
          row — clearing the last line and saving is the way back. */}
      <div className="toolbar">
        <Button variant="primary" disabled={isBusy} onClick={onSave}>
          Save what this {label} settles
        </Button>
      </div>
    </div>
  )
}

// ---- What has been paid against it ------------------------------------------

/**
 * What is outstanding, what settled the rest, and where each part of it came from.
 *
 * NOT A FIGURE ON THE DOCUMENT. It is the movement this document made on the party's
 * account less what has been receipted and less what has been offset against it — read
 * from main, never derived here. A cancelled document comes back at nothing because its
 * entry was reversed, which is why this panel needs no special case for one.
 *
 * TWO FIGURES AND TWO LISTS RATHER THAN ONE OF EACH. `allocated` and `offset` subtract
 * identically, which is the arithmetic saying they are the same kind of thing; they are
 * shown apart because "who paid this" and "what did we credit against it" are different
 * questions, and only one of them has a bank statement behind it.
 *
 * "LESS", AND THE FIGURE KEEPS THE SIGN IT ARRIVED WITH (CONVENTIONS §1.7). Both of those
 * figures are taken OFF the movement to reach the outstanding beside them, and main sends
 * both as positive quantities. The heading carries the subtraction; negating a copy here
 * would be the renderer doing arithmetic, and a screen that flips a sign in one place and
 * not another ends up showing the same credit positive in one cell and negative in the
 * next.
 *
 * THE OFFSETS LIST IS DRAWN ONLY AT THE CHARGE END. At the refund end the same rows are
 * already on screen with a box beside each, in the panel that edits them — `isOffsetEdited`
 * is that panel saying so, so the two can never both draw.
 *
 * The button carries the party and this document into the voucher editor, and carries no
 * AMOUNT: what moved is a fact about a bank statement, and a screen that guessed it would
 * have somebody confirming a figure they had not read.
 */
function Settlement({
  settlement,
  label,
  settlesWith,
  offsetEndKind,
  isOffsetEdited,
  format,
  onRecordMoney,
}: {
  settlement: DocumentSettlement
  label: string
  settlesWith: ReceiptKind
  /** The kind at the other end of an offset — a refund kind here, a charge one there. */
  offsetEndKind: DocumentKind
  /** Whether the panel above owns these offsets, which is where the picker lives. */
  isOffsetEdited: boolean
  format: Parameters<typeof formatAmount>[1]
  onRecordMoney: () => void
}): JSX.Element {
  const isSettled = settlement.outstanding === '0.00'
  const voucher = receiptDefinitionOf(settlesWith).label.toLowerCase()
  const otherEnd = definitionOf(offsetEndKind).pluralLabel.toLowerCase()

  return (
    <div className="stack stack--tight">
      <table className="ledger-table ledger-table--figures">
        <tbody>
          <tr>
            <td>Settled against this {label}</td>
            <td className="ledger-table__figure">{formatAmount(settlement.allocated, format)}</td>
          </tr>
          <tr>
            <td>Less {otherEnd} set against it</td>
            <td className="ledger-table__figure">{formatAmount(settlement.offset, format)}</td>
          </tr>
          <tr>
            <td>Outstanding</td>
            <td className="ledger-table__figure">{formatAmount(settlement.outstanding, format)}</td>
          </tr>
        </tbody>
      </table>

      {settlement.receipts.length > 0 && (
        <table className="ledger-table ledger-table--figures">
          <thead>
            <tr>
              <th scope="col">{receiptDefinitionOf(settlesWith).label}</th>
              <th scope="col">Date</th>
              <th scope="col" className="ledger-table__figure">
                Against this {label}
              </th>
            </tr>
          </thead>
          <tbody>
            {settlement.receipts.map((receipt) => (
              <tr key={receipt.receiptId} className="ledger-table__row">
                <td className="ledger-table__code">{receipt.number}</td>
                <td className="ledger-table__code">{receipt.date}</td>
                <td className="ledger-table__figure">{formatAmount(receipt.amount, format)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/*
       * The documents that settled the rest of it, beside the money that settled the
       * first part. The heading is read off the kind table through `offsetEndKind` —
       * writing "Credit note" here would have a purchase bill's panel calling a debit note
       * a credit note, which is what `settlesLabel` was written to prevent next door.
       */}
      {!isOffsetEdited && settlement.offsets.length > 0 && (
        <table className="ledger-table ledger-table--figures">
          <thead>
            <tr>
              <th scope="col">{definitionOf(offsetEndKind).label}</th>
              <th scope="col">Date</th>
              <th scope="col" className="ledger-table__figure">
                Set against this {label}
              </th>
            </tr>
          </thead>
          <tbody>
            {settlement.offsets.map((offset) => (
              <tr key={offset.offsetId} className="ledger-table__row">
                <td className="ledger-table__code">{offset.documentNumber}</td>
                <td className="ledger-table__code">{offset.documentDate}</td>
                <td className="ledger-table__figure">{formatAmount(offset.amount, format)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!isSettled && (
        <div className="toolbar">
          <Button icon="plus" variant="ghost" size="sm" onClick={onRecordMoney}>
            Record a {voucher}
          </Button>
        </div>
      )}
    </div>
  )
}

// ---- The place of supply ----------------------------------------------------

function PlaceOfSupply({
  regime,
  label,
  value,
  isEditable,
  isTouched,
  onChange,
}: {
  regime: RegimeDescription | null
  label: string
  value: string
  isEditable: boolean
  isTouched: boolean
  onChange: (next: string) => void
}): JSX.Element {
  return (
    <Select
      label="Place of supply"
      value={value}
      disabled={!isEditable}
      hint={
        isTouched
          ? `Overridden for this ${label}. Choose "Wherever the regime decides" to let it decide again.`
          : 'Left alone, this follows the party and your own registration. Change it only for a supply that happens somewhere else — a hotel room, goods delivered to a third state.'
      }
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Wherever the regime decides</option>
      {(regime?.jurisdictions ?? []).map((jurisdiction) => (
        <option key={jurisdiction.code} value={jurisdiction.code}>
          {jurisdiction.name}
        </option>
      ))}
    </Select>
  )
}

// ---- The lines --------------------------------------------------------------

/*
 * The grid, and the four columns 0017 added to it.
 *
 * WHAT A LINE IS, AND WHAT IT SAYS. The first column names the ITEM — the master record
 * the line came from — and the middle columns are what was printed. They are not the same
 * fact and the screen keeps them apart on purpose: picking an item fills the description,
 * the unit, the rate, the classification and (on a sale) the price, and from that instant
 * the line owns its copies. Editing any of them leaves the line the same item. A line with
 * no item at all is free text and is as valid as it was before this column existed.
 *
 * WHERE IT POSTS IS THE LAST COLUMN, and it is deliberately the last one. Two controls,
 * both about the same question:
 *
 *   the charge box    freight, packing or insurance — `freight-outward` on a sale,
 *                     `freight-inward` on a purchase, and taxed like anything else
 *   the account       a named account, which beats both defaults
 *
 * Most lines want neither, which is why they sit past the figures rather than among them.
 * But the account override is the only way an expense reaches its own account on a
 * purchase bill, and without it that document cannot record what a small business
 * actually buys — so it is on the row, not behind a preference.
 *
 * A STORED CHOICE THE LIST NO LONGER OFFERS GETS AN OPTION OF ITS OWN. An item archived
 * after an invoice was issued is not in `items.list`, and a `<select>` whose value matches
 * no option silently displays the FIRST one — so the invoice would name a different item
 * than the one it was made of, convincingly. The extra option is what makes the control
 * show what is actually stored.
 */

function Lines({
  lines,
  rates,
  items,
  units,
  accounts,
  isEditable,
  onChange,
  onChooseItem,
  onAdd,
  onRemove,
}: {
  lines: readonly LineDraft[]
  rates: RegimeDescription['taxRates']
  items: readonly ItemSummary[]
  units: readonly UnitOfMeasure[]
  /** Already narrowed to what a line may post to — see `postableAccounts`. */
  accounts: readonly Account[]
  isEditable: boolean
  onChange: <K extends keyof LineDraft>(key: string, field: K, value: LineDraft[K]) => void
  onChooseItem: (key: string, itemId: string) => void
  onAdd: () => void
  onRemove: (key: string) => void
}): JSX.Element {
  const listedItems = useMemo(() => new Set(items.map((item) => item.id)), [items])
  const listedUnits = useMemo(() => new Set(units.map((unit) => unit.code)), [units])
  const listedAccounts = useMemo(() => new Set(accounts.map((account) => account.id)), [accounts])

  return (
    <div className="stack">
      <table className="ledger-table ledger-table--figures">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Description</th>
            <th scope="col">HSN / SAC</th>
            <th scope="col">Quantity</th>
            <th scope="col">Unit</th>
            <th scope="col">Unit price</th>
            <th scope="col">Discount</th>
            <th scope="col">Tax rate</th>
            <th scope="col">Posts to</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={line.key} className="ledger-table__row">
              <td>
                {/*
                 * THE PICKER SEEDS AND THEN LETS GO. `onChooseItem` fills the row from the
                 * item's own defaults; nothing here re-reads it afterwards, and nothing
                 * else on the row writes to `itemId`. So editing the description next door
                 * does not unpick the item, and clearing this does not empty the
                 * description — see `lineFromItem` and `clearItem`.
                 */}
                <Select
                  label={`Item, line ${String(index + 1)}`}
                  isLabelHidden
                  value={line.itemId}
                  disabled={!isEditable}
                  onChange={(event) => onChooseItem(line.key, event.target.value)}
                >
                  <option value="">None — type the line yourself</option>
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.code === null ? item.name : `${item.code} — ${item.name}`}
                    </option>
                  ))}
                  {line.itemId !== '' && !listedItems.has(line.itemId) && (
                    <option value={line.itemId}>An item that is no longer listed</option>
                  )}
                </Select>
              </td>
              <td>
                <Input
                  label={`Description, line ${String(index + 1)}`}
                  isLabelHidden
                  value={line.description}
                  disabled={!isEditable}
                  onChange={(event) => onChange(line.key, 'description', event.target.value)}
                />
              </td>
              <td>
                <Input
                  label={`HSN or SAC, line ${String(index + 1)}`}
                  isLabelHidden
                  value={line.classificationCode}
                  disabled={!isEditable}
                  onChange={(event) => onChange(line.key, 'classificationCode', event.target.value)}
                />
              </td>
              <td>
                <Input
                  label={`Quantity, line ${String(index + 1)}`}
                  isLabelHidden
                  value={line.quantity}
                  disabled={!isEditable}
                  onChange={(event) => onChange(line.key, 'quantity', event.target.value)}
                />
              </td>
              <td>
                {/*
                 * NO UNIT IS A COMPLETE LINE, and an empty list is a first-run company
                 * rather than a broken control — `setUpBooks` seeds none at all. So the
                 * empty option is not a placeholder waiting to be replaced: it is an
                 * answer, and it is the answer every line has until somebody sets units
                 * up. The note under the table says where they come from.
                 */}
                <Select
                  label={`Unit, line ${String(index + 1)}`}
                  isLabelHidden
                  value={line.unitCode}
                  disabled={!isEditable}
                  onChange={(event) => onChange(line.key, 'unitCode', event.target.value)}
                >
                  <option value="">No unit</option>
                  {units.map((unit) => (
                    <option key={unit.code} value={unit.code}>
                      {unit.code} — {unit.name}
                    </option>
                  ))}
                  {line.unitCode !== '' && !listedUnits.has(line.unitCode) && (
                    <option value={line.unitCode}>{line.unitCode}</option>
                  )}
                </Select>
              </td>
              <td>
                <Input
                  label={`Unit price, line ${String(index + 1)}`}
                  isLabelHidden
                  value={line.unitPrice}
                  disabled={!isEditable}
                  onChange={(event) => onChange(line.key, 'unitPrice', event.target.value)}
                />
              </td>
              <td>
                <Input
                  label={`Discount, line ${String(index + 1)}`}
                  isLabelHidden
                  value={line.discount}
                  disabled={!isEditable}
                  onChange={(event) => onChange(line.key, 'discount', event.target.value)}
                />
              </td>
              <td>
                {/*
                 * A LIST AND A BOX, NOT A CLOSED PICKER. The slabs come from the regime
                 * and are advisory: rates change by notification and this build's copy of
                 * them is bundled, so a list gone stale must not stand between a user and
                 * a document they are required to raise. The datalist offers; the field
                 * accepts anything.
                 */}
                <Input
                  label={`Tax rate, line ${String(index + 1)}`}
                  isLabelHidden
                  list="document-tax-rates"
                  value={line.ratePct}
                  disabled={!isEditable}
                  placeholder="18"
                  onChange={(event) => onChange(line.key, 'ratePct', event.target.value)}
                />
              </td>
              <td>
                {/*
                 * THE USER'S WORDS, NOT THE FIELD'S. `isCharge` is what the column is
                 * called in the contract; what a person is looking at is the freight line
                 * on a bill. It says nothing about whether the line is taxed — a charge
                 * that should not be taxed carries a rate of nil, which is a decision on
                 * the row where anybody can see it (regimes/in-gst/tax.ts).
                 *
                 * The line number is on the label and not on screen, so twenty rows are
                 * twenty distinct controls to a screen reader and one column to everyone
                 * else.
                 */}
                <CheckboxField
                  isChecked={line.isCharge}
                  isDisabled={!isEditable}
                  onChange={(isChecked) => onChange(line.key, 'isCharge', isChecked)}
                >
                  Freight or packing
                  <span className="visually-hidden">, line {String(index + 1)}</span>
                </CheckboxField>
                <Select
                  label={`Account, line ${String(index + 1)}`}
                  isLabelHidden
                  value={line.accountId}
                  disabled={!isEditable}
                  onChange={(event) => onChange(line.key, 'accountId', event.target.value)}
                >
                  <option value="">Wherever this line normally posts</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} — {account.name}
                    </option>
                  ))}
                  {line.accountId !== '' && !listedAccounts.has(line.accountId) && (
                    <option value={line.accountId}>An account that is no longer listed</option>
                  )}
                </Select>
              </td>
              <td>
                {isEditable && (
                  <Button variant="ghost" size="sm" onClick={() => onRemove(line.key)}>
                    Remove
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <datalist id="document-tax-rates">
        {rates.map((rate) => (
          <option key={rate.ratePct} value={rate.ratePct}>
            {rate.label} — {rate.note}
          </option>
        ))}
      </datalist>

      {/*
       * SAID ONCE, UNDER THE TABLE, RATHER THAN UNDER EVERY ROW. A hint on a control in a
       * grid is the same sentence twenty times over; both of these are about a column.
       *
       * The units one is drawn only where it is true, and it is true on a company's first
       * day: no unit is seeded anywhere, so an empty picker is what everybody starts with
       * and it must not read as a list that failed to load.
       */}
      {units.length === 0 && (
        <p className="prose prose--muted">
          No units are set up yet, and a line needs none — a quantity can be counted in nothing.
          Units of measure, under Inventory, is where they come from.
        </p>
      )}
      <p className="prose prose--muted">
        Each line posts where this kind of document normally sends it. Name an account on a line to
        send that one somewhere else — which is how a bill records an expense.
      </p>

      {isEditable && (
        <div className="toolbar">
          <Button icon="plus" variant="ghost" size="sm" onClick={onAdd}>
            Add a line
          </Button>
        </div>
      )}
    </div>
  )
}

// ---- The foot ---------------------------------------------------------------

function Totals({
  document,
  isStale,
  format,
}: {
  document: Document
  isStale: boolean
  format: Parameters<typeof formatAmount>[1]
}): JSX.Element {
  const { totals } = document

  return (
    <div className="stack stack--tight">
      {/*
       * SAID, NOT HIDDEN. These are the figures main computed for the version of this
       * document that is stored. The renderer cannot recompute them and will not pretend
       * to, so when there are unsaved edits it says which version they belong to.
       */}
      {isStale && (
        <Notice tone="info" title="These figures are from the last saved version">
          <p>
            Tax is worked out in the main process, against the regime these books use. Save to see
            what it now comes to.
          </p>
        </Notice>
      )}

      <table className="ledger-table ledger-table--figures">
        <tbody>
          <tr>
            <td>Taxable value</td>
            <td className="ledger-table__figure">{formatAmount(totals.taxableValue, format)}</td>
          </tr>
          {totals.taxSummary.map((tax) => (
            <tr key={`${tax.code}-${tax.ratePct}`}>
              <td>{tax.label}</td>
              <td className="ledger-table__figure">{formatAmount(tax.amount, format)}</td>
            </tr>
          ))}
          <tr>
            <td>Total tax</td>
            <td className="ledger-table__figure">{formatAmount(totals.totalTax, format)}</td>
          </tr>
          <tr>
            <td>Grand total</td>
            <td className="ledger-table__figure">{formatAmount(totals.grandTotal, format)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

/*
 * One editor per kind, from the same table the registers use. No `nav` on any of them:
 * an editor is reached from its register or from a row, never from the rail — there
 * is no such thing as "the" credit note to land on. `navParent` is that register, so
 * the rail keeps it marked while the editor is open.
 */
export const documentEditorScreens: readonly ScreenDefinition[] = DOCUMENT_KINDS.map(
  (definition) => ({
    id: editorScreenId(definition.kind),
    title: definition.label,
    area: 'workspace' as const,
    navParent: registerScreenId(definition.kind),
    render: (context: ScreenContext) => <DocumentEditor {...context} kind={definition.kind} />,
  }),
)

registerScreens(documentEditorScreens)
