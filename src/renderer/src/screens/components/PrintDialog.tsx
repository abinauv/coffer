/*
 * Printing a document.
 *
 * WHAT THE RENDERER KNOWS ABOUT THE PAGE IS A PICTURE OF IT. Main builds the HTML,
 * renders it in a window of its own and sends back a PNG of page one; the markup never
 * crosses the boundary. An invoice is the one artefact in this product that somebody
 * outside the business reads, and markup that reached an untrusted process could come
 * back altered.
 *
 * THE PREVIEW IS PAGE ONE, AND THE DIALOG SAYS SO. It is a screenshot of the rendered
 * page rather than a rendering of the PDF, so a forty-line invoice previews its first
 * sheet. A dialog that showed one page and implied it was the whole document would be
 * lying about the thing the user is about to hand a customer.
 *
 * NO TEMPLATE PICKER. This build draws one template — the tax invoice — and a picker with
 * one entry promises a second (design.md §4 rule 7, and decision D6, which left the
 * language setting off Settings for the same reason). The template is named as a fact
 * instead, so the reader knows which one they are getting.
 *
 * EVERY CHANGE RE-RENDERS, after a pause. Each render is a real Chromium laying out a
 * real page, so the requests are debounced and a stale answer is dropped rather than
 * drawn: ticking three boxes quickly must not leave the preview showing the second one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Button, Dialog } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import { useRegime } from '@renderer/store/regime'
import { useToasts } from '@renderer/store/toasts'
import type { AppError, PrintCopy, PrintInclude, PrintPreview } from '@shared/dto'
import { CheckboxField } from './CheckboxField'
import { FailureNotice } from './FailureNotice'
import { COPY_LABELS, PRINT_COPIES, previewNote, printableCopies } from '../lib/print-view'

/** How long to wait after the last tick before asking main to render again. */
const REDRAW_DELAY_MS = 350

interface PrintDialogProps {
  isOpen: boolean
  /** The document to print. It must be issued; a draft has no number and is refused. */
  documentId: string
  /** What to call it in the title: the number, or the kind when there somehow is none. */
  title: string
  onClose: () => void
}

export function PrintDialog({ isOpen, documentId, title, onClose }: PrintDialogProps): JSX.Element {
  const regime = useRegime()
  const { show } = useToasts()

  const [copies, setCopies] = useState<readonly PrintCopy[]>(['original'])
  const [include, setInclude] = useState<PrintInclude>({ amountInWords: true, hsnSummary: true })
  const [preview, setPreview] = useState<PrintPreview | null>(null)
  const [isDrawing, setDrawing] = useState(true)
  const [error, setError] = useState<AppError | null>(null)
  const [isBusy, setBusy] = useState(false)

  /*
   * The copies as a string, so the effect below can depend on WHAT was ticked rather than
   * on an array rebuilt every render. Ticking the same boxes in another order produces the
   * same key and does not re-render the page.
   */
  const copyKey = printableCopies(copies).join(',')
  const wanted = useMemo<readonly PrintCopy[]>(
    () => (copyKey === '' ? [] : (copyKey.split(',') as PrintCopy[])),
    [copyKey],
  )
  const canPrint = wanted.length > 0

  /*
   * The render in flight. Only the newest answer is drawn — an earlier one arriving late
   * would replace a newer preview with an older page, which is the one thing a preview
   * must not do.
   */
  const latest = useRef(0)

  useEffect(() => {
    if (!isOpen || !canPrint) {
      setPreview(null)
      setDrawing(false)
      return
    }
    setDrawing(true)
    const attempt = ++latest.current
    const timer = setTimeout(() => {
      void (async () => {
        const result = await callApi((api) =>
          api.documents.renderPrint({ id: documentId, copies: wanted, include }),
        )
        if (attempt !== latest.current) return
        setDrawing(false)
        if (result.ok) {
          setPreview(result.data)
          setError(null)
        } else {
          setPreview(null)
          setError(result.error)
        }
      })()
    }, REDRAW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [isOpen, documentId, canPrint, wanted, include])

  const toggleCopy = useCallback((copy: PrintCopy, isOn: boolean) => {
    setCopies((current) =>
      isOn ? [...current, copy] : current.filter((existing) => existing !== copy),
    )
  }, [])

  const savePdf = useCallback(async () => {
    setBusy(true)
    const result = await callApi((api) =>
      api.documents.savePdf({ id: documentId, copies: wanted, include }),
    )
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    /* A cancelled save dialog is an ordinary outcome: nothing was written, and saying so
     * in a toast would report the user's own decision back to them as news. */
    if (result.data.path === null) return
    onClose()
    show({
      tone: 'success',
      title: 'PDF saved',
      body: result.data.path,
    })
  }, [documentId, wanted, include, onClose, show])

  const print = useCallback(async () => {
    setBusy(true)
    const result = await callApi((api) =>
      api.documents.print({ id: documentId, copies: wanted, include }),
    )
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    onClose()
  }, [documentId, wanted, include, onClose])

  const classification = regime?.classification.label ?? 'Classification'

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      title={`Print ${title}`}
      description="A4. The page is built and rendered by Coffer itself — nothing is sent anywhere."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="archive" disabled={!canPrint || isBusy} onClick={() => void savePdf()}>
            Save PDF
          </Button>
          <Button
            variant="primary"
            icon="invoice"
            disabled={!canPrint || isBusy}
            isBusy={isBusy}
            onClick={() => void print()}
          >
            Print
          </Button>
        </>
      }
    >
      <div className="print">
        <div className="print__options stack">
          {error && <FailureNotice error={error} context="print" />}

          <section className="fact" aria-labelledby="print-template">
            <span className="fact__label" id="print-template">
              Template
            </span>
            <p className="prose">Tax invoice</p>
            <p className="prose prose--muted">
              The only one this build draws. A bill of supply and a delivery challan are not written
              yet.
            </p>
          </section>

          <fieldset className="print__group">
            <legend className="caps-label">Copies</legend>
            {PRINT_COPIES.map((copy) => (
              <CheckboxField
                key={copy}
                isChecked={copies.includes(copy)}
                onChange={(isOn) => toggleCopy(copy, isOn)}
                hint={COPY_LABELS[copy].marking}
              >
                {COPY_LABELS[copy].label}
              </CheckboxField>
            ))}
            {!canPrint && <p className="prose prose--muted">Choose at least one copy to print.</p>}
          </fieldset>

          <fieldset className="print__group">
            <legend className="caps-label">Include</legend>
            <CheckboxField
              isChecked={include.amountInWords}
              onChange={(isOn) => setInclude((now) => ({ ...now, amountInWords: isOn }))}
              hint="The grand total written out, under the figures."
            >
              Amount in words
            </CheckboxField>
            <CheckboxField
              isChecked={include.hsnSummary}
              onChange={(isOn) => setInclude((now) => ({ ...now, hsnSummary: isOn }))}
              hint="A fold by code, unit and rate at the foot. Useful when filing; not something the recipient needs."
            >
              {classification} summary
            </CheckboxField>
          </fieldset>
        </div>

        <div className="print__preview">
          <div className="print__sheet" aria-live="polite">
            {preview === null ? (
              <p className="print__placeholder">
                {isDrawing ? 'Drawing the page…' : 'Nothing to preview.'}
              </p>
            ) : (
              <img
                className="print__image"
                src={preview.imageDataUri}
                width={preview.widthPx}
                height={preview.heightPx}
                alt={`Page one of ${title}`}
                data-stale={isDrawing ? 'true' : 'false'}
              />
            )}
          </div>
          <p className="prose prose--muted">{previewNote(preview)}</p>
        </div>
      </div>
    </Dialog>
  )
}
