/*
 * The invoice editor, rendered.
 *
 * THREE THINGS ARE COVERED ONLY HERE.
 *
 * The place of supply is OMITTED unless the user chooses one. Nothing on a document
 * records whether its place was derived or stated, so a screen that helpfully sent back
 * the place it was displaying would pin a Tamil Nadu place of supply onto an invoice just
 * moved to a Karnataka customer — CGST+SGST would stay where IGST belongs, and the
 * invoice would look entirely ordinary. That is the assertion this file exists for.
 *
 * The figures shown are always main's. There is no test that a line total appears while
 * typing, because there is no line total while typing: the renderer does not compute
 * money, so the totals belong to the last saved version and say so.
 *
 * And the four verbs reach the states they are allowed to. A button offered on a document
 * that would refuse it is worse than a button that is not offered.
 *
 * WHAT IS OUTSTANDING IS ASKED FOR SEPARATELY, and the tests at the foot of this file say
 * why that is the right shape: it is a fact about the ledger rather than a field on the
 * document, so a draft is never asked about at all, and a cancelled invoice comes back at
 * nothing without the screen knowing anything about reversals.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  Document,
  DocumentLineDto,
  DocumentSettlement,
  DocumentStatusDto,
  PartySummary,
  Result,
} from '@shared/dto'
import { renderScreen, screenContext, testRoute, type BridgeStub } from '../../test/harness'
import { Invoice } from './Invoice'

const CUSTOMERS: PartySummary[] = [
  {
    id: 'party-1',
    name: 'Sunrise Components',
    isCustomer: true,
    isVendor: false,
    registrationNumber: '33AABCC1234D1ZI',
    city: 'Chennai',
    isArchived: false,
  } as PartySummary,
  {
    id: 'party-2',
    name: 'Deccan Alloys',
    isCustomer: true,
    isVendor: false,
    registrationNumber: '29AAAAA0000A1ZY',
    city: 'Bengaluru',
    isArchived: false,
  } as PartySummary,
]

function line(over: Partial<DocumentLineDto> = {}): DocumentLineDto {
  return {
    id: 'line-1',
    lineNumber: 1,
    itemId: null,
    description: 'Ball bearing 6203',
    quantity: '2.000',
    unitCode: null,
    unitPrice: '500.00',
    discount: '0.00',
    taxableAmount: '1000.00',
    ratePct: '18.000',
    classificationCode: null,
    isCharge: false,
    accountId: null,
    taxes: [],
    ...over,
  }
}

function document(over: Partial<Document> = {}): Document {
  return {
    id: 'doc-1',
    kind: 'sales-invoice',
    status: 'draft' as DocumentStatusDto,
    number: null,
    date: '2026-04-15',
    partyId: 'party-1',
    partyName: 'Sunrise Components',
    grandTotal: '1180.00',
    seriesId: null,
    partyReference: null,
    placeOfSupplyJurisdiction: '33',
    placeOfSupplyCountry: 'in',
    roundingPolicy: 'none',
    narration: '',
    entryId: null,
    lines: [line()],
    totals: {
      taxableValue: '1000.00',
      totalDiscount: '0.00',
      totalTax: '180.00',
      netTotal: '1180.00',
      roundOff: '0.00',
      grandTotal: '1180.00',
      taxSummary: [
        { code: 'CGST', label: 'CGST @ 9%', ratePct: '9.000', amount: '90.00' },
        { code: 'SGST', label: 'SGST @ 9%', ratePct: '9.000', amount: '90.00' },
      ],
    },
    createdAt: '2026-04-15T09:00:00.000Z',
    updatedAt: '2026-04-15T09:00:00.000Z',
    issuedAt: null,
    cancelledAt: null,
    ...over,
  }
}

/** What has been receipted against it. Nothing, unless a test says otherwise. */
function settlement(over: Partial<DocumentSettlement> = {}): DocumentSettlement {
  return {
    documentId: 'doc-1',
    movement: '1180.00',
    allocated: '0.00',
    outstanding: '1180.00',
    receipts: [],
    ...over,
  }
}

/** A bridge that serves one document and echoes a chosen answer back from every write. */
function bridgeFor(
  stored: Document | null,
  answer: Document = document(),
  settled: DocumentSettlement = settlement(),
): BridgeStub {
  return {
    parties: {
      list: () => Promise.resolve<Result<PartySummary[]>>({ ok: true, data: CUSTOMERS }),
    },
    receipts: {
      /* Asked for any document that has posted. A draft never reaches it, which is what
       * the first test in `what has been received` asserts. */
      settlement: () => Promise.resolve<Result<DocumentSettlement>>({ ok: true, data: settled }),
    },
    documents: {
      get: () => Promise.resolve<Result<Document | null>>({ ok: true, data: stored }),
      create: () => Promise.resolve<Result<Document>>({ ok: true, data: answer }),
      update: () => Promise.resolve<Result<Document>>({ ok: true, data: answer }),
      issue: () => Promise.resolve<Result<Document>>({ ok: true, data: answer }),
      cancel: () => Promise.resolve<Result<Document>>({ ok: true, data: answer }),
      delete: () => Promise.resolve<Result<void>>({ ok: true, data: undefined }),
    },
  }
}

const editing = (id = 'doc-1') => screenContext({ route: testRoute('invoice', { id }) })
const creating = () => screenContext({ route: testRoute('invoice') })

const sentTo = (
  bridge: { lastCallTo(channel: string): { args: readonly unknown[] } | undefined },
  channel: string,
): Record<string, unknown> | undefined =>
  bridge.lastCallTo(channel)?.args[0] as Record<string, unknown> | undefined

describe('the place of supply', () => {
  /*
   * THE ASSERTION THIS FILE EXISTS FOR.
   *
   * The editor is showing a Tamil Nadu place of supply because that is what main derived
   * for a Tamil Nadu customer. The user changes the customer to a Karnataka one and saves.
   * If the screen sends the place it is displaying, `documents.update` treats it as the
   * caller stating a place, keeps Tamil Nadu, and the invoice carries CGST+SGST when it
   * should carry IGST. Sending nothing is how the screen says "you decide".
   */
  it('is not sent back when the user did not choose it', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Invoice {...editing()} />, {
      bridge: bridgeFor(document()),
    })

    await waitFor(() => expect(screen.getByLabelText('Customer')).toHaveValue('party-1'))
    await user.selectOptions(screen.getByLabelText('Customer'), 'party-2')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('documents:update')).toHaveLength(1))
    expect(sentTo(bridge, 'documents:update')).not.toHaveProperty('placeOfSupplyJurisdiction')
    expect(sentTo(bridge, 'documents:update')?.['partyId']).toBe('party-2')
  })

  /* And it IS sent when the user states one, because an override is a decision only a
   * person can make — a hotel room, goods delivered to a third state. */
  it('is sent when the user chooses one', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Invoice {...editing()} />, {
      bridge: bridgeFor(document()),
    })

    await waitFor(() => expect(screen.getByLabelText('Customer')).toHaveValue('party-1'))
    await user.selectOptions(screen.getByLabelText('Place of supply'), '29')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('documents:update')).toHaveLength(1))
    expect(sentTo(bridge, 'documents:update')?.['placeOfSupplyJurisdiction']).toBe('29')
  })

  it('offers the jurisdictions the regime listed, and letting the regime decide', async () => {
    renderScreen(<Invoice {...editing()} />, { bridge: bridgeFor(document()) })

    const picker = (await screen.findByLabelText('Place of supply')) as HTMLSelectElement
    expect([...picker.options].map((option) => option.text)).toEqual([
      'Wherever the regime decides',
      'Karnataka',
      'Tamil Nadu',
    ])
  })
})

describe('the figures', () => {
  it('shows what main computed, formatted the way the regime writes numbers', async () => {
    renderScreen(<Invoice {...editing()} />, { bridge: bridgeFor(document()) })

    expect(await screen.findByText('1,180.00')).toBeInTheDocument()
    expect(screen.getByText('CGST @ 9%')).toBeInTheDocument()
    expect(screen.getByText('1,000.00')).toBeInTheDocument()
  })

  /*
   * NOT REDRAWN AND NOT HIDDEN — LABELLED. The renderer cannot recompute a total and
   * will not pretend to, so an edited-but-unsaved invoice says which version the figures
   * on screen belong to. Quietly leaving 1,180.00 under a changed quantity is the bug
   * this notice exists to prevent.
   */
  it('says the totals are stale once something is edited', async () => {
    const user = userEvent.setup()
    renderScreen(<Invoice {...editing()} />, { bridge: bridgeFor(document()) })

    await screen.findByText('1,180.00')
    expect(screen.queryByText(/from the last saved version/)).toBeNull()

    await user.type(screen.getByLabelText('Narration'), 'Against PO 4471')

    expect(screen.getByText(/from the last saved version/)).toBeInTheDocument()
    /* The figure is still shown. A stale figure that says it is stale beats a gap. */
    expect(screen.getByText('1,180.00')).toBeInTheDocument()
  })

  it('stops saying so once the edits are saved', async () => {
    const user = userEvent.setup()
    renderScreen(<Invoice {...editing()} />, { bridge: bridgeFor(document()) })

    await screen.findByText('1,180.00')
    await user.type(screen.getByLabelText('Narration'), 'Against PO 4471')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(screen.queryByText(/from the last saved version/)).toBeNull())
  })
})

describe('what a line sends', () => {
  it('sends no taxable amount and no tax component', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Invoice {...editing()} />, {
      bridge: bridgeFor(document()),
    })

    await waitFor(() => expect(screen.getByLabelText('Customer')).toHaveValue('party-1'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('documents:update')).toHaveLength(1))
    const sent = sentTo(bridge, 'documents:update')?.['lines'] as Record<string, unknown>[]
    expect(sent[0]).not.toHaveProperty('taxableAmount')
    expect(sent[0]).not.toHaveProperty('taxes')
    expect(sent[0]?.['description']).toBe('Ball bearing 6203')
  })

  /*
   * THE RATE FIELD ACCEPTS ANYTHING. The slabs come from the regime and are advisory —
   * they change by notification and this build's copy is bundled, so a list gone stale
   * must not stand between a user and an invoice they are legally required to raise.
   */
  it('sends a rate that is not one of the regime slabs', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Invoice {...editing()} />, {
      bridge: bridgeFor(document()),
    })

    const rate = await screen.findByLabelText('Tax rate, line 1')
    await user.clear(rate)
    await user.type(rate, '17.5')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('documents:update')).toHaveLength(1))
    const sent = sentTo(bridge, 'documents:update')?.['lines'] as Record<string, unknown>[]
    expect(sent[0]?.['ratePct']).toBe('17.5')
  })

  it('leaves an unfinished row out rather than sending a blank one', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Invoice {...editing()} />, {
      bridge: bridgeFor(document()),
    })

    await waitFor(() => expect(screen.getByLabelText('Customer')).toHaveValue('party-1'))
    await user.click(screen.getByRole('button', { name: 'Add a line' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('documents:update')).toHaveLength(1))
    expect(sentTo(bridge, 'documents:update')?.['lines']).toHaveLength(1)
  })
})

describe('creating one', () => {
  it('will not create without a customer, a date and a line', async () => {
    renderScreen(<Invoice {...creating()} />, { bridge: bridgeFor(null) })

    expect(await screen.findByRole('button', { name: 'Create draft' })).toBeDisabled()
  })

  it('creates a sales invoice and moves to it', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    const { bridge } = renderScreen(
      <Invoice {...screenContext({ route: testRoute('invoice'), navigate })} />,
      { bridge: bridgeFor(null, document({ id: 'doc-9' })) },
    )

    await screen.findByLabelText('Customer')
    await user.selectOptions(screen.getByLabelText('Customer'), 'party-1')
    await user.type(screen.getByLabelText('Date'), '2026-04-15')
    await user.type(screen.getByLabelText('Description, line 1'), 'Ball bearing 6203')
    await user.type(screen.getByLabelText('Unit price, line 1'), '500.00')
    await user.click(screen.getByRole('button', { name: 'Create draft' }))

    await waitFor(() => expect(bridge.callsTo('documents:create')).toHaveLength(1))
    expect(sentTo(bridge, 'documents:create')?.['kind']).toBe('sales-invoice')
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ screenId: 'invoice', params: { id: 'doc-9' } }),
    )
  })
})

describe('the four verbs', () => {
  it('offers issue and delete on a draft, and not cancel', async () => {
    renderScreen(<Invoice {...editing()} />, { bridge: bridgeFor(document()) })

    expect(await screen.findByRole('button', { name: 'Issue' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete draft' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel this invoice' })).toBeNull()
  })

  /*
   * AN ISSUED INVOICE IS NEVER DELETED AND NEVER EDITED. It has a number that was
   * reported, an entry in the ledger and a place in a series. Cancelling is the way back,
   * and the fields are locked so a save cannot be attempted at all.
   */
  it('offers only cancel on an issued one, and locks the form', async () => {
    const issued = document({ status: 'issued', number: 'INV/2026-27/0001', entryId: 'entry-1' })
    renderScreen(<Invoice {...editing()} />, { bridge: bridgeFor(issued) })

    expect(await screen.findByRole('button', { name: 'Cancel this invoice' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete draft' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Issue' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.getByLabelText('Customer')).toBeDisabled()
    expect(screen.getByLabelText('Description, line 1')).toBeDisabled()
  })

  it('offers nothing at all on a cancelled one', async () => {
    const cancelled = document({ status: 'cancelled', number: 'INV/2026-27/0001' })
    renderScreen(<Invoice {...editing()} />, { bridge: bridgeFor(cancelled) })

    await screen.findByText(/Cancelled\./)
    expect(screen.queryByRole('button', { name: 'Issue' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel this invoice' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete draft' })).toBeNull()
  })

  it('issues, and says what the number is and how to undo it', async () => {
    const user = userEvent.setup()
    const issued = document({ status: 'issued', number: 'INV/2026-27/0001', entryId: 'entry-1' })
    const { bridge } = renderScreen(<Invoice {...editing()} />, {
      bridge: bridgeFor(document(), issued),
    })

    await user.click(await screen.findByRole('button', { name: 'Issue' }))

    await waitFor(() => expect(bridge.callsTo('documents:issue')).toHaveLength(1))
    expect(await screen.findByText(/INV\/2026-27\/0001 is in the books/)).toBeInTheDocument()
    expect(screen.getByText(/the number is kept/)).toBeInTheDocument()
  })

  /*
   * Issuing numbers and posts the SAVED version, which is not what is on screen when
   * there are unsaved edits. Saying so beats silently saving first — the user pressed
   * Issue, not Save, and the two are not the same decision.
   */
  it('will not issue while there are unsaved edits, and says why', async () => {
    const user = userEvent.setup()
    renderScreen(<Invoice {...editing()} />, { bridge: bridgeFor(document()) })

    await screen.findByRole('button', { name: 'Issue' })
    await user.type(screen.getByLabelText('Narration'), 'Against PO 4471')

    expect(screen.getByRole('button', { name: 'Issue' })).toBeDisabled()
    expect(screen.getByText('There are unsaved changes')).toBeInTheDocument()
  })

  it('cancels, and says the number is kept', async () => {
    const user = userEvent.setup()
    const issued = document({ status: 'issued', number: 'INV/2026-27/0001', entryId: 'entry-1' })
    const cancelled = document({
      ...issued,
      status: 'cancelled',
      cancelledAt: '2026-04-20T00:00:00.000Z',
    })
    const { bridge } = renderScreen(<Invoice {...editing()} />, {
      bridge: bridgeFor(issued, cancelled),
    })

    await user.click(await screen.findByRole('button', { name: 'Cancel this invoice' }))

    await waitFor(() => expect(bridge.callsTo('documents:cancel')).toHaveLength(1))

    /* Scoped to the toast. The LEDE says the same thing — `stateSentence` describes a
     * cancelled invoice as reversed — and an unscoped query finds both, which is a
     * failure that reads as a bug and is not one. Two places saying it is correct: the
     * toast tells you what just happened, the lede tells you what the document is. */
    const toasts = within(screen.getByRole('region', { name: 'Notifications' }))
    expect(await toasts.findByText(/has been reversed/)).toBeInTheDocument()
    expect(toasts.getByText(/series has no hole/)).toBeInTheDocument()
  })

  it('deletes a draft and returns to the register', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    const { bridge } = renderScreen(
      <Invoice {...screenContext({ route: testRoute('invoice', { id: 'doc-1' }), navigate })} />,
      { bridge: bridgeFor(document()) },
    )

    await user.click(await screen.findByRole('button', { name: 'Delete draft' }))

    await waitFor(() => expect(bridge.callsTo('documents:delete')).toHaveLength(1))
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ screenId: 'invoices' }))
  })
})

describe('when main refuses', () => {
  it('shows the sentence main wrote, not a paraphrase', async () => {
    const user = userEvent.setup()
    renderScreen(<Invoice {...editing()} />, {
      bridge: {
        ...bridgeFor(document()),
        documents: {
          ...bridgeFor(document()).documents,
          issue: () =>
            Promise.resolve<Result<Document>>({
              ok: false,
              error: {
                code: 'COMPANY_PROFILE_MISSING',
                message: 'Fill in the business details before raising an invoice.',
              },
            }),
        },
      },
    })

    await user.click(await screen.findByRole('button', { name: 'Issue' }))

    expect(await screen.findByText(/Fill in the business details/)).toBeInTheDocument()
  })

  it('says so when the invoice is no longer in the books', async () => {
    renderScreen(<Invoice {...editing()} />, { bridge: bridgeFor(null) })

    expect(await screen.findByText(/no longer in these books/)).toBeInTheDocument()
  })
})

describe('reading it', () => {
  it('fills the form from what is stored', async () => {
    const stored = document({ narration: 'Against PO 4471', partyReference: 'PO-4471' })
    renderScreen(<Invoice {...editing()} />, { bridge: bridgeFor(stored) })

    await waitFor(() => expect(screen.getByLabelText('Narration')).toHaveValue('Against PO 4471'))
    expect(screen.getByLabelText('Their reference')).toHaveValue('PO-4471')
    expect(screen.getByLabelText('Description, line 1')).toHaveValue('Ball bearing 6203')
    expect(screen.getByLabelText('Quantity, line 1')).toHaveValue('2.000')
  })

  it('shows a draft as a draft, with no number to show', async () => {
    renderScreen(<Invoice {...editing()} />, { bridge: bridgeFor(document()) })

    await waitFor(() => expect(screen.getByLabelText('Customer')).toHaveValue('party-1'))
    const badge = screen.getByText('Draft')
    expect(within(badge.closest('div') as HTMLElement).getByText('Draft')).toBeInTheDocument()
    expect(screen.getByText(/Nothing is in the books until it is issued/)).toBeInTheDocument()
  })
})

describe('what has been received against it', () => {
  const issued = () => document({ status: 'issued', number: 'INV/2026-27/0001' })

  /* A draft has posted nothing, so there is no movement for anything to be against.
   * Asking would be asking about a document the ledger has never seen. */
  it('is not asked about at all while the invoice is a draft', async () => {
    const { bridge } = renderScreen(<Invoice {...editing()} />, { bridge: bridgeFor(document()) })

    await waitFor(() => expect(bridge.callsTo('documents:get')).toHaveLength(1))
    expect(bridge.callsTo('receipts:settlement')).toHaveLength(0)
  })

  it('shows what is outstanding once it has been issued', async () => {
    renderScreen(<Invoice {...editing()} />, {
      bridge: bridgeFor(
        issued(),
        issued(),
        settlement({ allocated: '500.00', outstanding: '680.00' }),
      ),
    })

    const row = (await screen.findByText('Outstanding')).closest('tr') as HTMLElement
    expect(within(row).getByText('680.00')).toBeInTheDocument()
  })

  it('names the receipts that settled part of it', async () => {
    renderScreen(<Invoice {...editing()} />, {
      bridge: bridgeFor(
        issued(),
        issued(),
        settlement({
          allocated: '500.00',
          outstanding: '680.00',
          receipts: [
            {
              receiptId: 'rct-1',
              number: 'RCT/2026-27/0001',
              date: '2026-04-20',
              amount: '500.00',
            },
          ],
        }),
      ),
    })

    const row = (await screen.findByText('RCT/2026-27/0001')).closest('tr') as HTMLElement
    expect(within(row).getByText('2026-04-20')).toBeInTheDocument()
    expect(within(row).getByText('500.00')).toBeInTheDocument()
  })

  /*
   * IT CARRIES THE CUSTOMER AND THE INVOICE, AND NO AMOUNT. What arrived is a fact about
   * a bank statement; pre-filling what the invoice says would have somebody confirming a
   * figure they had not read, and a part payment is the ordinary case.
   */
  it('records a receipt against it, carrying the customer and the invoice', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    renderScreen(
      <Invoice {...screenContext({ route: testRoute('invoice', { id: 'doc-1' }), navigate })} />,
      { bridge: bridgeFor(issued(), issued(), settlement()) },
    )

    await user.click(await screen.findByRole('button', { name: 'Record a receipt' }))

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        screenId: 'receipt',
        params: { partyId: 'party-1', documentId: 'doc-1' },
      }),
    )
  })

  it('offers no receipt button once nothing is outstanding', async () => {
    renderScreen(<Invoice {...editing()} />, {
      bridge: bridgeFor(
        issued(),
        issued(),
        settlement({ allocated: '1180.00', outstanding: '0.00' }),
      ),
    })

    await screen.findByText('Outstanding')
    expect(screen.queryByRole('button', { name: 'Record a receipt' })).not.toBeInTheDocument()
  })

  /*
   * A cancel refused because money is allocated against it. Main's sentence names the
   * figure and says what to do; the screen shows it rather than inventing one of its own,
   * because the money is on a receipt the user has to go and find.
   */
  it("shows main's refusal when the invoice has money against it", async () => {
    const user = userEvent.setup()
    const base = bridgeFor(issued(), issued(), settlement({ allocated: '500.00' }))
    renderScreen(<Invoice {...editing()} />, {
      bridge: {
        ...base,
        documents: {
          ...base.documents,
          cancel: () =>
            Promise.resolve<Result<Document>>({
              ok: false,
              error: {
                code: 'DOCUMENT_ALLOCATED',
                message:
                  '500.00 has been receipted against this document. Take the allocation off the receipt first, so that money goes somewhere you chose.',
              },
            }),
        },
      },
    })

    await user.click(await screen.findByRole('button', { name: 'Cancel this invoice' }))

    expect(await screen.findByText(/Take the allocation off the receipt first/)).toBeInTheDocument()
  })
})
