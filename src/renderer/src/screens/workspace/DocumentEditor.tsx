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
 * ONLY A CHARGE THAT POSTS SHOWS THAT PANEL, which is new here and deliberate. A credit
 * note's movement is negative, so its "outstanding" is money owed BACK — a real figure
 * with no screen to act on it yet, since offsetting a credit note against an invoice and
 * refunding one are both unbuilt. Showing a negative outstanding beside a Record-a-receipt
 * button would offer a user an operation that does not exist. The same filter 0013-1 put
 * on the receipt picker, arriving on the screen the picker feeds.
 */

import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { Badge, Button, Input, Select } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import { makeRoute } from '@renderer/lib/routing'
import { registerScreens, type ScreenContext, type ScreenDefinition } from '@renderer/lib/screens'
import { useNumberFormat, useRegime } from '@renderer/store/regime'
import { useToasts } from '@renderer/store/toasts'
import { correctsKind, definitionOf, DOCUMENT_KINDS, type DocumentKind } from '@shared/documents'
import { receiptDefinitionOf, settlingKind, type ReceiptKind } from '@shared/receipts'
import type {
  AppError,
  Document,
  DocumentLineInput,
  DocumentSettlement,
  DocumentSummary,
  PartySummary,
  RegimeDescription,
} from '@shared/dto'
import { FailureNotice } from '../components/FailureNotice'
import { Notice } from '../components/Notice'
import { ScreenFrame } from '../components/ScreenFrame'
import { formatAmount } from '../lib/ledger-format'
import {
  editorScreenId,
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
  isBlankDraft,
  lineDraftOf,
  linesFrom,
  readyLines,
  stateSentence,
  toLineInput,
  type LineDraft,
} from '../lib/document-editor'

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
   * The voucher that settles this side, which is also its editor's route id. Derived
   * rather than named, because 0013-2 shipped this as `'receipt'` with the purchase side
   * gated off — the payment editor did not exist, and a button reaching an unregistered
   * screen would have landed a user on a blank page. It exists as of 0013-3, and one
   * lookup replaces both the literal and the gate.
   */
  const settlesWith = settlingKind(definition.side)

  const [document, setDocument] = useState<Document | null>(null)
  const [parties, setParties] = useState<PartySummary[]>([])
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

  const load = useCallback(async () => {
    const people = await callApi((api) => api.parties.list({ role: partyRoleFor(definition.side) }))
    if (people.ok) setParties(people.data)

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
  const isSettleable = definition.postsToLedger && definition.direction === 'charge'
  const settledId =
    document !== null && isSettleable && documentStatus !== 'draft' ? document.id : null

  useEffect(() => {
    let current = true
    if (settledId === null) {
      setSettlement(null)
      return
    }

    void callApi((api) => api.receipts.settlement(settledId)).then((result) => {
      if (!current) return
      if (result.ok) setSettlement(result.data)
    })

    return () => {
      current = false
    }
  }, [settledId, documentStatus])

  const touch = useCallback((change: () => void) => {
    setDirty(true)
    change()
  }, [])

  const setLine = useCallback(
    (key: string, field: keyof LineDraft, value: string) =>
      touch(() =>
        setLines((current) =>
          current.map((line) => (line.key === key ? { ...line, [field]: value } : line)),
        ),
      ),
    [touch],
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
            <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>
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
          isEditable={isEditable}
          onChange={setLine}
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

        {settlement !== null && (
          <Settlement
            settlement={settlement}
            label={label}
            settlesWith={settlesWith}
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

// ---- What has been paid against it ------------------------------------------

/**
 * What is outstanding, and the receipts that settled the rest.
 *
 * NOT A FIGURE ON THE DOCUMENT. It is the movement this document made on the party's
 * account less what has been receipted against it — read from main, never derived here.
 * A cancelled document comes back at nothing because its entry was reversed, which is why
 * this panel needs no special case for one.
 *
 * The button carries the party and this document into the voucher editor, and carries no
 * AMOUNT: what moved is a fact about a bank statement, and a screen that guessed it would
 * have somebody confirming a figure they had not read.
 */
function Settlement({
  settlement,
  label,
  settlesWith,
  format,
  onRecordMoney,
}: {
  settlement: DocumentSettlement
  label: string
  settlesWith: ReceiptKind
  format: Parameters<typeof formatAmount>[1]
  onRecordMoney: () => void
}): JSX.Element {
  const isSettled = settlement.outstanding === '0.00'
  const voucher = receiptDefinitionOf(settlesWith).label.toLowerCase()

  return (
    <div className="stack stack--tight">
      <table className="ledger-table ledger-table--figures">
        <tbody>
          <tr>
            <td>Settled against this {label}</td>
            <td className="ledger-table__figure">{formatAmount(settlement.allocated, format)}</td>
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

function Lines({
  lines,
  rates,
  isEditable,
  onChange,
  onAdd,
  onRemove,
}: {
  lines: readonly LineDraft[]
  rates: RegimeDescription['taxRates']
  isEditable: boolean
  onChange: (key: string, field: keyof LineDraft, value: string) => void
  onAdd: () => void
  onRemove: (key: string) => void
}): JSX.Element {
  return (
    <div className="stack">
      <table className="ledger-table ledger-table--figures">
        <thead>
          <tr>
            <th scope="col">Description</th>
            <th scope="col">HSN / SAC</th>
            <th scope="col">Quantity</th>
            <th scope="col">Unit price</th>
            <th scope="col">Discount</th>
            <th scope="col">Tax rate</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={line.key} className="ledger-table__row">
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
 * an editor is reached from its register or from a row, never from the sidebar — there
 * is no such thing as "the" credit note to land on.
 */
export const documentEditorScreens: readonly ScreenDefinition[] = DOCUMENT_KINDS.map(
  (definition) => ({
    id: editorScreenId(definition.kind),
    title: definition.label,
    area: 'workspace' as const,
    render: (context: ScreenContext) => <DocumentEditor {...context} kind={definition.kind} />,
  }),
)

registerScreens(documentEditorScreens)
