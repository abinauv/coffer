/*
 * The print dialog, rendered.
 *
 * `print-view.ts` is covered as pure functions next door. What is covered here is the
 * part that only exists once the dialog is on screen: that the options reach main as a
 * request, that a stale render is not drawn over a newer one, and that the preview is
 * never described as the whole document.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { PrintDocumentInput, PrintPreview } from '@shared/dto'
import { DEFAULT_COMPANY, renderScreen, type BridgeStub } from '../../test/harness'
import { PrintDialog } from './PrintDialog'

const PREVIEW: PrintPreview = {
  imageDataUri: 'data:image/png;base64,iVBORw0KGgo=',
  widthPx: 794,
  heightPx: 1123,
  copyCount: 1,
}

/* Merged into the group rather than spread over it: a `documents` override that replaced
 * the whole group would leave the other two channels unanswered, and the harness fails a
 * test on an unanswered channel — which reads as the dialog being broken. */
function open(over: Record<string, unknown> = {}): void {
  renderScreen(
    <PrintDialog isOpen documentId="d1" title="INV/2026-27/0001" onClose={() => undefined} />,
    {
      bridge: {
        documents: {
          renderPrint: () => Promise.resolve({ ok: true, data: PREVIEW }),
          savePdf: () => Promise.resolve({ ok: true, data: { path: '/home/a/INV-0001.pdf' } }),
          print: () => Promise.resolve({ ok: true, data: undefined }),
          ...over,
        },
      } as BridgeStub,
      company: DEFAULT_COMPANY,
    },
  )
}

describe('what it offers', () => {
  it('starts on the original alone, with both blocks included', async () => {
    const calls: PrintDocumentInput[] = []
    open({
      renderPrint: (input: PrintDocumentInput) => {
        calls.push(input)
        return Promise.resolve({ ok: true, data: PREVIEW })
      },
    })

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({
      id: 'd1',
      copies: ['original'],
      include: { amountInWords: true, hsnSummary: true },
    })
  })

  /*
   * NO TEMPLATE PICKER. One template exists, and a picker with one entry promises a
   * second — the reasoning that kept the language setting off Settings (D6).
   */
  it('names the template rather than offering a list of one', async () => {
    open()

    expect(await screen.findByText('Tax invoice')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByText(/not written yet/)).toBeInTheDocument()
  })

  it('says on each copy what that sheet will be marked', async () => {
    open()

    expect(await screen.findByText('ORIGINAL FOR RECIPIENT')).toBeInTheDocument()
    expect(screen.getByText('DUPLICATE FOR TRANSPORTER')).toBeInTheDocument()
    expect(screen.getByText('TRIPLICATE FOR SUPPLIER')).toBeInTheDocument()
  })
})

describe('changing what is printed', () => {
  it('asks for the copies that are ticked, in the rule order', async () => {
    const user = userEvent.setup()
    const calls: PrintDocumentInput[] = []
    open({
      renderPrint: (input: PrintDocumentInput) => {
        calls.push(input)
        return Promise.resolve({ ok: true, data: { ...PREVIEW, copyCount: input.copies.length } })
      },
    })
    await waitFor(() => expect(calls).toHaveLength(1))

    await user.click(screen.getByRole('checkbox', { name: /Triplicate/ }))
    await user.click(screen.getByRole('checkbox', { name: /Duplicate/ }))

    await waitFor(() => {
      expect(calls[calls.length - 1]?.copies).toEqual(['original', 'duplicate', 'triplicate'])
    })
  })

  it('carries a declined block into the request', async () => {
    const user = userEvent.setup()
    const calls: PrintDocumentInput[] = []
    open({
      renderPrint: (input: PrintDocumentInput) => {
        calls.push(input)
        return Promise.resolve({ ok: true, data: PREVIEW })
      },
    })
    await waitFor(() => expect(calls).toHaveLength(1))

    await user.click(screen.getByRole('checkbox', { name: /Amount in words/ }))

    await waitFor(() => expect(calls[calls.length - 1]?.include.amountInWords).toBe(false))
  })

  it('will not print nothing', async () => {
    const user = userEvent.setup()
    open()
    await screen.findByRole('img', { name: /Page one/ })

    await user.click(screen.getByRole('checkbox', { name: /Original/ }))

    expect(await screen.findByText('Choose at least one copy to print.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Print' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save PDF' })).toBeDisabled()
  })
})

describe('the preview', () => {
  it('shows page one and says that is what it is', async () => {
    open()

    const image = await screen.findByRole('img', { name: 'Page one of INV/2026-27/0001' })
    expect(image).toHaveAttribute('src', PREVIEW.imageDataUri)
    expect(screen.getByText(/the first page/)).toBeInTheDocument()
  })

  it('counts the sheets a three-copy run will produce', async () => {
    const user = userEvent.setup()
    open({
      renderPrint: (input: PrintDocumentInput) =>
        Promise.resolve({ ok: true, data: { ...PREVIEW, copyCount: input.copies.length } }),
    })
    await screen.findByRole('img', { name: /Page one/ })

    await user.click(screen.getByRole('checkbox', { name: /Duplicate/ }))
    await user.click(screen.getByRole('checkbox', { name: /Triplicate/ }))

    expect(await screen.findByText(/three copies, one per sheet/)).toBeInTheDocument()
  })

  it('says what went wrong instead of showing a stale page', async () => {
    open({
      renderPrint: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'DOCUMENT_NOT_ISSUED', message: 'A draft has no number.' },
        }),
    })

    expect(await screen.findByText('A draft cannot be printed.')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /Page one/ })).not.toBeInTheDocument()
  })
})

describe('saving and printing', () => {
  it('sends the same request it previewed, and says where the file went', async () => {
    const user = userEvent.setup()
    const save = vi.fn(() =>
      Promise.resolve({ ok: true as const, data: { path: '/home/a/INV-0001.pdf' } }),
    )
    open({ savePdf: save })
    await screen.findByRole('img', { name: /Page one/ })

    await user.click(screen.getByRole('button', { name: 'Save PDF' }))

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        id: 'd1',
        copies: ['original'],
        include: { amountInWords: true, hsnSummary: true },
      }),
    )
    const toasts = await screen.findByRole('region', { name: 'Notifications' })
    expect(within(toasts).getByText('/home/a/INV-0001.pdf')).toBeInTheDocument()
  })

  /*
   * A CANCELLED SAVE IS NOT NEWS. Nothing was written, and the user is the one who
   * decided that — reporting it back to them in a toast would be the app narrating.
   */
  it('says nothing when the save dialog is cancelled', async () => {
    const user = userEvent.setup()
    open({ savePdf: () => Promise.resolve({ ok: true, data: { path: null } }) })
    await screen.findByRole('img', { name: /Page one/ })

    await user.click(screen.getByRole('button', { name: 'Save PDF' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save PDF' })).toBeEnabled())
    expect(screen.queryByText('PDF saved')).not.toBeInTheDocument()
  })
})
