/*
 * One invoice: drafting it, issuing it, cancelling it.
 *
 * THE FIGURES ON THIS SCREEN ARE ALWAYS MAIN'S. A user typing a quantity expects a line
 * total to follow and this screen will not produce one — `quantity x unitPrice` is money
 * arithmetic and the tax is the regime's answer (CONVENTIONS §1.7). So the draft is
 * SAVED and what came back is shown. While there are unsaved edits the totals are marked
 * as belonging to the last saved version rather than quietly redrawn: a stale figure that
 * says it is stale is honest, and a fresh-looking figure the renderer invented is not.
 *
 * That is not a workaround. Every screen in this product shows figures main computed, and
 * an invoice is the one document where being wrong by a paisa is a filing that does not
 * reconcile.
 *
 * THE PLACE OF SUPPLY IS OMITTED UNLESS THE USER TOUCHES IT, and this is the subtlest
 * thing on the screen. Nothing on a document records whether its place was derived or
 * stated. `documents.update` re-derives when the party changed and the caller said
 * nothing, and keeps what is stored otherwise — so a screen that helpfully sent the place
 * it was displaying would pin a Tamil Nadu place of supply onto an invoice just moved to
 * a Karnataka customer, and CGST+SGST would stay where IGST belongs. Sending nothing is
 * how the screen says "you decide". See `placeTouched` below.
 */

import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { Badge, Button, Input, Select } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import { makeRoute } from '@renderer/lib/routing'
import { registerScreens, type ScreenContext } from '@renderer/lib/screens'
import { useNumberFormat, useRegime } from '@renderer/store/regime'
import { useToasts } from '@renderer/store/toasts'
import type {
  AppError,
  Document,
  DocumentLineInput,
  PartySummary,
  RegimeDescription,
} from '@shared/dto'
import { FailureNotice } from '../components/FailureNotice'
import { Notice } from '../components/Notice'
import { ScreenFrame } from '../components/ScreenFrame'
import { formatAmount } from '../lib/ledger-format'
import { INVOICE_KIND, statusLabel, statusTone } from '../lib/invoice-view'
import {
  blankLine,
  canCancel,
  canDelete,
  canEdit,
  canIssue,
  lineDraftOf,
  readyLines,
  stateSentence,
  toLineInput,
  type LineDraft,
} from '../lib/invoice-editor'

export function Invoice({ route, navigate }: ScreenContext): JSX.Element {
  const documentId = route.params['id'] ?? null
  const { show } = useToasts()
  const regime = useRegime()
  const format = useNumberFormat()

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

  /* See the header. Only an explicit choice is sent, so that a party change re-asks the
   * regime instead of having the displayed place pinned back on. */
  const [place, setPlace] = useState('')
  const [placeTouched, setPlaceTouched] = useState(false)

  /* Unsaved edits. What makes the totals panel say what it is showing. */
  const [isDirty, setDirty] = useState(false)

  const load = useCallback(async () => {
    const customers = await callApi((api) => api.parties.list({ role: 'customer' }))
    if (customers.ok) setParties(customers.data)

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
      setError({ code: 'DOCUMENT_NOT_FOUND', message: 'That invoice is no longer in these books.' })
      return
    }
    adopt(result.data)
  }, [documentId])

  /** Take main's answer as the truth, and clear the unsaved-edits mark. */
  function adopt(next: Document): void {
    setDocument(next)
    setPartyId(next.partyId)
    setDate(next.date)
    setPartyReference(next.partyReference ?? '')
    setNarration(next.narration)
    setLines(next.lines.length === 0 ? [blankLine()] : next.lines.map(lineDraftOf))
    setPlace(next.placeOfSupplyJurisdiction ?? '')
    setPlaceTouched(false)
    setDirty(false)
    setError(null)
  }

  useEffect(() => {
    void load()
  }, [load])

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
    } => ({
      date,
      partyId,
      partyReference: partyReference.trim(),
      narration: narration.trim(),
      lines: sendable.map(toLineInput),
      /* Omitted unless chosen — see the header. */
      ...(placeTouched && place !== '' ? { placeOfSupplyJurisdiction: place } : {}),
    }),
    [date, narration, partyId, partyReference, place, placeTouched, sendable],
  )

  const save = useCallback(async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)

    const result = await callApi((api) =>
      document === null
        ? api.documents.create({ kind: INVOICE_KIND, ...payload() })
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
       * from here reaches the empty editor — which is a new-invoice screen that creates
       * nothing until asked, not a second draft. */
      navigate(makeRoute('workspace', 'invoice', { id: result.data.id }))
    }
    show({
      tone: 'success',
      title: wasNew ? 'Draft created' : 'Saved',
      body: 'Nothing is in the books until it is issued.',
    })
  }, [canSave, document, navigate, payload, show])

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
      body: `${result.data.number ?? 'The invoice'} is in the books. To undo it, cancel it — the number is kept.`,
    })
  }, [document, show])

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
      body: 'What it posted has been reversed. The number is kept, so the series has no hole.',
    })
  }, [document, show])

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
    navigate(makeRoute('workspace', 'invoices'))
  }, [document, navigate, show])

  if (isReading) {
    return (
      <ScreenFrame isInset width="list" title="Invoice">
        <p className="prose prose--muted">Reading the invoice…</p>
      </ScreenFrame>
    )
  }

  return (
    <ScreenFrame
      isInset
      width="list"
      title={document?.number ?? 'New invoice'}
      lede={stateSentence(status, document?.number ?? null)}
      actions={
        <>
          <Button variant="ghost" onClick={() => navigate(makeRoute('workspace', 'invoices'))}>
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
                Cancel this invoice
              </Button>
            )}
            {canDelete(status) && (
              <Button variant="ghost" disabled={isBusy} onClick={() => void remove()}>
                Delete draft
              </Button>
            )}
          </div>
        )}

        {/* Issuing an invoice with unsaved edits would number and post the SAVED version,
            which is not what is on screen. Saying so is better than saving silently. */}
        {isDirty && document !== null && canIssue(status) && (
          <Notice tone="info" title="There are unsaved changes">
            <p>Save them first — issuing would number and post the invoice as it was last saved.</p>
          </Notice>
        )}

        <div className="stack">
          <Select
            label="Customer"
            value={partyId}
            disabled={!isEditable}
            onChange={(event) => touch(() => setPartyId(event.target.value))}
          >
            <option value="">Choose a customer</option>
            {parties.map((party) => (
              <option key={party.id} value={party.id}>
                {party.name}
              </option>
            ))}
          </Select>

          <Input
            label="Date"
            type="date"
            value={date}
            disabled={!isEditable}
            onChange={(event) => touch(() => setDate(event.target.value))}
          />

          <Input
            label="Their reference"
            value={partyReference}
            disabled={!isEditable}
            hint="A purchase order number, or whatever they asked you to quote."
            onChange={(event) => touch(() => setPartyReference(event.target.value))}
          />

          <PlaceOfSupply
            regime={regime}
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
            hint="What the day book will say about the entry this posts."
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
      </div>
    </ScreenFrame>
  )
}

// ---- The place of supply ----------------------------------------------------

function PlaceOfSupply({
  regime,
  value,
  isEditable,
  isTouched,
  onChange,
}: {
  regime: RegimeDescription | null
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
          ? 'Overridden for this invoice. Choose "Wherever the regime decides" to let it decide again.'
          : 'Left alone, this follows the customer and your own registration. Change it only for a supply that happens somewhere else — a hotel room, goods delivered to a third state.'
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
                 * an invoice they are required to raise. The datalist offers; the field
                 * accepts anything.
                 */}
                <Input
                  label={`Tax rate, line ${String(index + 1)}`}
                  isLabelHidden
                  list="invoice-tax-rates"
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

      <datalist id="invoice-tax-rates">
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
       * invoice that is stored. The renderer cannot recompute them and will not pretend
       * to, so when there are unsaved edits it says which version they belong to.
       */}
      {isStale && (
        <Notice tone="info" title="These figures are from the last saved version">
          <p>
            Tax is worked out in the main process, against the regime these books use. Save to see
            what the invoice now comes to.
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

registerScreens([
  {
    id: 'invoice',
    title: 'Invoice',
    area: 'workspace',
    /* No `nav`. It is reached from the register or from a row, never from the sidebar —
     * there is no such thing as "the" invoice to land on. */
    render: (context) => <Invoice {...context} />,
  },
])
