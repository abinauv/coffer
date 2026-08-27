/*
 * The document editor, rendered.
 *
 * ONE COMPONENT, FIVE REGISTRATIONS (0013-2). Most of what follows renders it as the
 * sales-invoice editor, because the place-of-supply rule, the four verbs and the totals
 * panel are the same for every kind — which is the argument for one editor rather than
 * five. What differs by kind has its own sections at the foot: the party a purchase asks
 * for, the words a quotation needs, and the document a credit note corrects.
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
  DocumentSummary,
  DocumentSettlement,
  DocumentStatusDto,
  PartySummary,
  Result,
} from '@shared/dto'
import { DOCUMENT_KINDS } from '@shared/documents'
import { renderScreen, screenContext, testRoute, type BridgeStub } from '../../test/harness'
import { documentEditorScreens, DocumentEditor } from './DocumentEditor'

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
    dueDate: null,
    partyId: 'party-1',
    partyName: 'Sunrise Components',
    grandTotal: '1180.00',
    seriesId: null,
    originalDocumentId: null,
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

const editing = (id = 'doc-1') => screenContext({ route: testRoute('sales-invoice', { id }) })
const creating = () => screenContext({ route: testRoute('sales-invoice') })

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
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
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
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document()),
    })

    await waitFor(() => expect(screen.getByLabelText('Customer')).toHaveValue('party-1'))
    await user.selectOptions(screen.getByLabelText('Place of supply'), '29')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('documents:update')).toHaveLength(1))
    expect(sentTo(bridge, 'documents:update')?.['placeOfSupplyJurisdiction']).toBe('29')
  })

  it('offers the jurisdictions the regime listed, and letting the regime decide', async () => {
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document()),
    })

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
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document()),
    })

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
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document()),
    })

    await screen.findByText('1,180.00')
    expect(screen.queryByText(/from the last saved version/)).toBeNull()

    await user.type(screen.getByLabelText('Narration'), 'Against PO 4471')

    expect(screen.getByText(/from the last saved version/)).toBeInTheDocument()
    /* The figure is still shown. A stale figure that says it is stale beats a gap. */
    expect(screen.getByText('1,180.00')).toBeInTheDocument()
  })

  it('stops saying so once the edits are saved', async () => {
    const user = userEvent.setup()
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document()),
    })

    await screen.findByText('1,180.00')
    await user.type(screen.getByLabelText('Narration'), 'Against PO 4471')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(screen.queryByText(/from the last saved version/)).toBeNull())
  })
})

describe('what a line sends', () => {
  it('sends no taxable amount and no tax component', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
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
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
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
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
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
    renderScreen(<DocumentEditor {...creating()} kind="sales-invoice" />, {
      bridge: bridgeFor(null),
    })

    expect(await screen.findByRole('button', { name: 'Create draft' })).toBeDisabled()
  })

  it('creates a sales invoice and moves to it', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    const { bridge } = renderScreen(
      <DocumentEditor
        {...screenContext({ route: testRoute('sales-invoice'), navigate })}
        kind="sales-invoice"
      />,
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
      expect.objectContaining({ screenId: 'sales-invoice', params: { id: 'doc-9' } }),
    )
  })
})

describe('the four verbs', () => {
  it('offers issue and delete on a draft, and not cancel', async () => {
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document()),
    })

    expect(await screen.findByRole('button', { name: 'Issue' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete draft' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel this sales invoice' })).toBeNull()
  })

  /*
   * AN ISSUED INVOICE IS NEVER DELETED AND NEVER EDITED. It has a number that was
   * reported, an entry in the ledger and a place in a series. Cancelling is the way back,
   * and the fields are locked so a save cannot be attempted at all.
   */
  it('offers only cancel on an issued one, and locks the form', async () => {
    const issued = document({ status: 'issued', number: 'INV/2026-27/0001', entryId: 'entry-1' })
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(issued),
    })

    expect(
      await screen.findByRole('button', { name: 'Cancel this sales invoice' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete draft' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Issue' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.getByLabelText('Customer')).toBeDisabled()
    expect(screen.getByLabelText('Description, line 1')).toBeDisabled()
  })

  /*
   * THE DUE DATE, FROM THE DOCUMENT RATHER THAN FROM ANYWHERE ELSE. `stateSentence` is
   * tested next door as a pure function, so what is worth asserting here is only the
   * wiring: the screen hands it the date the document came back with. Without this a call
   * site passing `null` for ever would leave every test in both files green.
   */
  it('says when the invoice it is showing falls due', async () => {
    const issued = document({
      status: 'issued',
      number: 'INV/2026-27/0001',
      entryId: 'entry-1',
      dueDate: '2026-05-15',
    })
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(issued),
    })

    expect(await screen.findByText(/Due 2026-05-15/)).toBeInTheDocument()
  })

  it('offers nothing at all on a cancelled one', async () => {
    const cancelled = document({ status: 'cancelled', number: 'INV/2026-27/0001' })
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(cancelled),
    })

    await screen.findByText(/Cancelled\./)
    expect(screen.queryByRole('button', { name: 'Issue' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel this sales invoice' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete draft' })).toBeNull()
  })

  it('issues, and says what the number is and how to undo it', async () => {
    const user = userEvent.setup()
    const issued = document({ status: 'issued', number: 'INV/2026-27/0001', entryId: 'entry-1' })
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
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
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document()),
    })

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
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(issued, cancelled),
    })

    await user.click(await screen.findByRole('button', { name: 'Cancel this sales invoice' }))

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
      <DocumentEditor
        {...screenContext({ route: testRoute('sales-invoice', { id: 'doc-1' }), navigate })}
        kind="sales-invoice"
      />,
      { bridge: bridgeFor(document()) },
    )

    await user.click(await screen.findByRole('button', { name: 'Delete draft' }))

    await waitFor(() => expect(bridge.callsTo('documents:delete')).toHaveLength(1))
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ screenId: 'sales-invoice-register' }),
    )
  })
})

describe('when main refuses', () => {
  it('shows the sentence main wrote, not a paraphrase', async () => {
    const user = userEvent.setup()
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
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
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(null),
    })

    expect(await screen.findByText(/no longer in these books/)).toBeInTheDocument()
  })
})

describe('reading it', () => {
  it('fills the form from what is stored', async () => {
    const stored = document({ narration: 'Against PO 4471', partyReference: 'PO-4471' })
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(stored),
    })

    await waitFor(() => expect(screen.getByLabelText('Narration')).toHaveValue('Against PO 4471'))
    expect(screen.getByLabelText('Their reference')).toHaveValue('PO-4471')
    expect(screen.getByLabelText('Description, line 1')).toHaveValue('Ball bearing 6203')
    expect(screen.getByLabelText('Quantity, line 1')).toHaveValue('2.000')
  })

  it('shows a draft as a draft, with no number to show', async () => {
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document()),
    })

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
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document()),
    })

    await waitFor(() => expect(bridge.callsTo('documents:get')).toHaveLength(1))
    expect(bridge.callsTo('receipts:settlement')).toHaveLength(0)
  })

  it('shows what is outstanding once it has been issued', async () => {
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
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
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
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
      <DocumentEditor
        {...screenContext({ route: testRoute('sales-invoice', { id: 'doc-1' }), navigate })}
        kind="sales-invoice"
      />,
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
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
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
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
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

    await user.click(await screen.findByRole('button', { name: 'Cancel this sales invoice' }))

    expect(await screen.findByText(/Take the allocation off the receipt first/)).toBeInTheDocument()
  })
})

// ---- What differs by kind ---------------------------------------------------

describe('a purchase bill', () => {
  const bill = (over: Partial<Document> = {}): Document =>
    document({ kind: 'purchase-bill', partyId: 'party-1', ...over })

  const purchase = (id = 'doc-1') => screenContext({ route: testRoute('purchase-bill', { id }) })

  /*
   * IT ASKS FOR VENDORS. One party record can be both — a firm you buy from and sell to
   * is ordinary — so this narrows the picker rather than describing what a party IS. A
   * bill editor listing customers would offer somebody the wrong half of their book.
   */
  it('asks main for vendors, not customers', async () => {
    const { bridge } = renderScreen(<DocumentEditor {...purchase()} kind="purchase-bill" />, {
      bridge: bridgeFor(bill()),
    })

    await waitFor(() => expect(bridge.callsTo('parties:list')).toHaveLength(1))
    expect(sentTo(bridge, 'parties:list')?.['role']).toBe('vendor')
  })

  it('labels the party as a vendor', async () => {
    renderScreen(<DocumentEditor {...purchase()} kind="purchase-bill" />, {
      bridge: bridgeFor(bill()),
    })

    expect(await screen.findByLabelText('Vendor')).toBeInTheDocument()
    expect(screen.queryByLabelText('Customer')).toBeNull()
  })

  /*
   * THE FIELD THAT IS NOT COSMETIC. A vendor's own bill number is what a GSTR-2B
   * reconciliation matches on; labelled "their reference" it invites being left blank,
   * and a blank one makes the purchase unmatchable against what the supplier filed.
   */
  it('asks for the supplier own invoice number by that name', async () => {
    renderScreen(<DocumentEditor {...purchase()} kind="purchase-bill" />, {
      bridge: bridgeFor(bill()),
    })

    expect(await screen.findByLabelText(/Their invoice number/)).toBeInTheDocument()
  })

  it('creates a purchase bill, not an invoice', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(
      <DocumentEditor
        {...screenContext({ route: testRoute('purchase-bill') })}
        kind="purchase-bill"
      />,
      { bridge: bridgeFor(null, bill({ id: 'doc-9' })) },
    )

    await screen.findByLabelText('Vendor')
    await user.selectOptions(screen.getByLabelText('Vendor'), 'party-1')
    await user.type(screen.getByLabelText('Date'), '2026-04-15')
    await user.type(screen.getByLabelText('Description, line 1'), 'Ball bearing 6203')
    await user.type(screen.getByLabelText('Unit price, line 1'), '500.00')
    await user.click(screen.getByRole('button', { name: 'Create draft' }))

    await waitFor(() => expect(bridge.callsTo('documents:create')).toHaveLength(1))
    expect(sentTo(bridge, 'documents:create')?.['kind']).toBe('purchase-bill')
  })

  /*
   * BACK GOES TO ITS OWN REGISTER. Every navigation on this screen is built from the
   * kind, and a fixed route would send somebody who deleted a draft bill to the invoice
   * list — a screen with none of their work on it and no sign of what happened.
   */
  it('returns to the bill register, not the invoice one', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()

    renderScreen(
      <DocumentEditor
        {...screenContext({ route: testRoute('purchase-bill', { id: 'doc-1' }), navigate })}
        kind="purchase-bill"
      />,
      { bridge: bridgeFor(bill()) },
    )

    await user.click(await screen.findByRole('button', { name: 'Delete draft' }))

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({ screenId: 'purchase-bill-register' }),
      ),
    )
  })

  /*
   * IT OFFERS A PAYMENT, NOT A RECEIPT — and asserting the absence of the receipt button
   * would not have said so. 0013-2 shipped exactly that assertion, correctly, because no
   * payment editor existed yet; 0013-3 built one and renamed the button, after which the
   * old test passed while testing nothing. THE ABSENCE OF THE OLD NAME IS NOT THE
   * PRESENCE OF THE NEW ONE. Both are asserted.
   */
  it('offers a payment to settle it with, and not a receipt', async () => {
    const issuedBill = bill({ status: 'issued', number: 'BILL/2026-27/0001', entryId: 'entry-1' })
    renderScreen(<DocumentEditor {...purchase()} kind="purchase-bill" />, {
      bridge: bridgeFor(issuedBill, issuedBill, settlement()),
    })

    expect(await screen.findByText('Outstanding')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Record a payment' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Record a receipt' })).toBeNull()
  })

  /*
   * AND IT GOES TO THE PAYMENT EDITOR, carrying the vendor and this bill. The route id is
   * derived from the voucher that settles the purchase side, so a literal `'receipt'`
   * here would open the receipt editor with a vendor's id in the party field — which
   * would then list customers and find none of them matching.
   */
  it('carries the vendor and the bill into the payment editor', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    const issuedBill = bill({ status: 'issued', number: 'BILL/2026-27/0001', entryId: 'entry-1' })

    renderScreen(
      <DocumentEditor
        {...screenContext({ route: testRoute('purchase-bill', { id: 'doc-1' }), navigate })}
        kind="purchase-bill"
      />,
      { bridge: bridgeFor(issuedBill, issuedBill, settlement()) },
    )

    await user.click(await screen.findByRole('button', { name: 'Record a payment' }))

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        screenId: 'payment',
        params: { partyId: 'party-1', documentId: 'doc-1' },
      }),
    )
  })

  /* The panel names the voucher in its heading too, so a column of payments is not
   * labelled Receipt on a bill. */
  it('heads the settlement rows with the payment, not the receipt', async () => {
    const issuedBill = bill({ status: 'issued', number: 'BILL/2026-27/0001', entryId: 'entry-1' })
    renderScreen(<DocumentEditor {...purchase()} kind="purchase-bill" />, {
      bridge: bridgeFor(
        issuedBill,
        issuedBill,
        settlement({
          allocated: '500.00',
          outstanding: '680.00',
          receipts: [
            {
              receiptId: 'pay-1',
              number: 'PAY/2026-27/0001',
              date: '2026-04-25',
              amount: '500.00',
            },
          ],
        }),
      ),
    })

    expect(await screen.findByRole('columnheader', { name: 'Payment' })).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Receipt' })).toBeNull()
  })
})

describe('a credit note', () => {
  const note = (over: Partial<Document> = {}): Document =>
    document({ kind: 'credit-note', ...over })

  const correcting = (id = 'doc-1') => screenContext({ route: testRoute('credit-note', { id }) })

  const INVOICES: DocumentSummary[] = [
    {
      id: 'inv-1',
      kind: 'sales-invoice',
      status: 'issued',
      number: 'INV/2026-27/0001',
      date: '2026-04-15',
      dueDate: '2026-05-15',
      partyId: 'party-1',
      partyName: 'Sunrise Components',
      grandTotal: '1180.00',
    },
  ]

  /** The credit note bridge, which also answers the picker's query. */
  function correctingBridge(
    stored: Document | null,
    answer: Document = note(),
    settled: DocumentSettlement = settlement(),
  ): BridgeStub {
    const base = bridgeFor(stored, answer, settled)
    return {
      ...base,
      documents: {
        ...base.documents,
        list: () => Promise.resolve<Result<DocumentSummary[]>>({ ok: true, data: INVOICES }),
        get: (id: string) =>
          Promise.resolve<Result<Document | null>>({
            ok: true,
            data: id === 'inv-1' ? document({ id: 'inv-1', lines: [line()] }) : stored,
          }),
      },
    } as BridgeStub
  }

  /*
   * THE PICKER ASKS FOR THE CHARGE KIND ON ITS OWN SIDE, and for THIS party's documents.
   * 0013's trigger refuses a link to another party's invoice, so a picker that offered
   * everyone's would be offering choices the database will reject — and the refusal would
   * arrive at save time, naming a document the user had just been shown.
   */
  it('offers only this customer issued invoices', async () => {
    const { bridge } = renderScreen(<DocumentEditor {...correcting()} kind="credit-note" />, {
      bridge: correctingBridge(note()),
    })

    await waitFor(() => expect(bridge.callsTo('documents:list')).toHaveLength(1))
    expect(sentTo(bridge, 'documents:list')).toMatchObject({
      kind: 'sales-invoice',
      status: 'issued',
      partyId: 'party-1',
    })
  })

  it('is not offered on a kind that corrects nothing', async () => {
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: correctingBridge(document()),
    })

    await screen.findByLabelText('Customer')
    expect(bridge.callsTo('documents:list')).toHaveLength(0)
    expect(screen.queryByLabelText(/this corrects/)).toBeNull()
  })

  /* Optional, because one credit note against several invoices has been legal since 2019
   * — so the empty option has to mean something rather than being a prompt. */
  it('offers an explicit none, and sends null for it', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<DocumentEditor {...correcting()} kind="credit-note" />, {
      bridge: correctingBridge(note({ originalDocumentId: 'inv-1' })),
    })

    await screen.findByRole('option', { name: /INV\/2026-27\/0001/ })
    await waitFor(() => expect(screen.getByLabelText(/this corrects/)).toHaveValue('inv-1'))
    await user.selectOptions(screen.getByLabelText(/this corrects/), '')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('documents:update')).toHaveLength(1))
    expect(sentTo(bridge, 'documents:update')?.['originalDocumentId']).toBeNull()
  })

  it('sends the invoice it was pointed at', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<DocumentEditor {...correcting()} kind="credit-note" />, {
      bridge: correctingBridge(note()),
    })

    await screen.findByRole('option', { name: /INV\/2026-27\/0001/ })
    await user.selectOptions(screen.getByLabelText(/this corrects/), 'inv-1')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('documents:update')).toHaveLength(1))
    expect(sentTo(bridge, 'documents:update')?.['originalDocumentId']).toBe('inv-1')
  })

  /*
   * THE LINE COPY. A full return is the common case and retyping an invoice to record one
   * is work software exists to remove. What crosses is what a person typed; the tax is
   * asked of the regime again on save, against the CREDIT NOTE's own date.
   */
  it('copies the invoice lines into an empty draft', async () => {
    const user = userEvent.setup()
    renderScreen(<DocumentEditor {...correcting()} kind="credit-note" />, {
      bridge: correctingBridge(note({ lines: [] })),
    })

    await screen.findByRole('option', { name: /INV\/2026-27\/0001/ })
    await user.selectOptions(screen.getByLabelText(/this corrects/), 'inv-1')

    await waitFor(() =>
      expect(screen.getByLabelText('Description, line 1')).toHaveValue('Ball bearing 6203'),
    )
    expect(screen.getByLabelText('Unit price, line 1')).toHaveValue('500.00')
  })

  /*
   * AND NEVER OVER WORK. Somebody correcting a mis-click in the picker must not lose what
   * they typed — a part return is typed by hand, and it is the case where the copy would
   * be actively wrong.
   */
  it('leaves lines somebody has typed alone', async () => {
    const user = userEvent.setup()
    renderScreen(<DocumentEditor {...correcting()} kind="credit-note" />, {
      bridge: correctingBridge(note({ lines: [] })),
    })

    await screen.findByRole('option', { name: /INV\/2026-27\/0001/ })
    await user.type(screen.getByLabelText('Description, line 1'), 'Two returned')
    await user.selectOptions(screen.getByLabelText(/this corrects/), 'inv-1')

    await waitFor(() => expect(screen.getByLabelText(/this corrects/)).toHaveValue('inv-1'))
    expect(screen.getByLabelText('Description, line 1')).toHaveValue('Two returned')
  })

  /* The link is frozen at issue by 0013's own trigger, so the picker must not invite an
   * edit that would be refused. */
  it('cannot be re-pointed once issued', async () => {
    const issuedNote = note({
      status: 'issued',
      number: 'CRN/2026-27/0001',
      entryId: 'entry-1',
      originalDocumentId: 'inv-1',
    })
    renderScreen(<DocumentEditor {...correcting()} kind="credit-note" />, {
      bridge: correctingBridge(issuedNote, issuedNote),
    })

    await waitFor(() => expect(screen.getByLabelText(/this corrects/)).toBeDisabled())
  })

  /*
   * A SETTLEMENT PANEL ON A REFUND, WHICH THERE WAS NOT UNTIL 0015. The gate used to be
   * `postsToLedger && direction === 'charge'`, and the reason it was there is worth
   * keeping: a credit note's movement on the account is negative, so its "outstanding"
   * was money owed BACK with no screen anywhere to act on it, and a Record-a-receipt
   * button beside it offered an operation that did not exist.
   *
   * Both halves are now false. `settlementFor` reads the figure in the DOCUMENT's own
   * facing, so this is what is left to refund rather than a negative; and the button
   * reaches the refund editor, which exists.
   */
  it('is asked what has been refunded against it', async () => {
    const issuedNote = note({ status: 'issued', number: 'CRN/2026-27/0001', entryId: 'entry-1' })
    const { bridge } = renderScreen(<DocumentEditor {...correcting()} kind="credit-note" />, {
      bridge: correctingBridge(
        issuedNote,
        issuedNote,
        settlement({ movement: '500.00', allocated: '200.00', outstanding: '300.00' }),
      ),
    })

    await screen.findByLabelText('Customer')
    await waitFor(() => expect(bridge.callsTo('receipts:settlement')).toHaveLength(1))
    expect(screen.getByText('Outstanding')).toBeInTheDocument()
  })

  /*
   * AND THE BUTTON GOES TO THE REFUND EDITOR, NOT THE RECEIPT ONE. This is the assertion
   * that would have failed on the side-only lookup the screen used before 0015: a credit
   * note is sales-side, so "the voucher that settles this side" answered `receipt` — and
   * the button would have offered to take money IN against money the business owes back.
   */
  it('sends the user to record a refund, not a receipt', async () => {
    const user = userEvent.setup()
    const issuedNote = note({ status: 'issued', number: 'CRN/2026-27/0001', entryId: 'entry-1' })
    const navigate = vi.fn()
    renderScreen(<DocumentEditor {...correcting()} kind="credit-note" navigate={navigate} />, {
      bridge: correctingBridge(
        issuedNote,
        issuedNote,
        settlement({ movement: '500.00', allocated: '0.00', outstanding: '500.00' }),
      ),
    })

    await user.click(await screen.findByRole('button', { name: /Record a refund paid/ }))

    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ screenId: 'refund' }))
  })
})

describe('a debit note', () => {
  /*
   * THE OTHER HALF OF THE PICKER, and the mutation pass is why it is here. A credit note
   * corrects a `sales-invoice`, which is also what a hardcoded kind would ask for — so
   * every assertion about the picker passed against a screen that ignored the correction
   * mapping entirely. Only the purchase side can tell the two apart.
   */
  it('offers bills, not invoices', async () => {
    const base = bridgeFor(document({ kind: 'debit-note' }))
    const { bridge } = renderScreen(
      <DocumentEditor
        {...screenContext({ route: testRoute('debit-note', { id: 'doc-1' }) })}
        kind="debit-note"
      />,
      {
        bridge: {
          ...base,
          documents: {
            ...base.documents,
            list: () => Promise.resolve<Result<DocumentSummary[]>>({ ok: true, data: [] }),
          },
        } as BridgeStub,
      },
    )

    await waitFor(() => expect(bridge.callsTo('documents:list')).toHaveLength(1))
    expect(sentTo(bridge, 'documents:list')?.['kind']).toBe('purchase-bill')
  })

  it('names the bill in the picker label', async () => {
    const base = bridgeFor(document({ kind: 'debit-note' }))
    renderScreen(
      <DocumentEditor
        {...screenContext({ route: testRoute('debit-note', { id: 'doc-1' }) })}
        kind="debit-note"
      />,
      {
        bridge: {
          ...base,
          documents: {
            ...base.documents,
            list: () => Promise.resolve<Result<DocumentSummary[]>>({ ok: true, data: [] }),
          },
        } as BridgeStub,
      },
    )

    expect(await screen.findByLabelText(/The purchase bill this corrects/)).toBeInTheDocument()
  })
})

describe('a quotation', () => {
  const quote = (over: Partial<Document> = {}): Document => document({ kind: 'quotation', ...over })

  const quoting = (id = 'doc-1') => screenContext({ route: testRoute('quotation', { id }) })

  /*
   * THE SENTENCE THAT MUST NOT BE SHARED. "Nothing is in the books until it is issued" is
   * false of a quotation in the direction that costs something: issuing one still puts
   * nothing there. A user taught that issuing is what posts would be surprised by their
   * first credit note.
   */
  it('never says its draft will reach the books when issued', async () => {
    renderScreen(<DocumentEditor {...quoting()} kind="quotation" />, {
      bridge: bridgeFor(quote()),
    })

    await screen.findByLabelText('Customer')
    expect(screen.queryByText(/Nothing is in the books until it is issued/)).toBeNull()
    expect(screen.getByText(/never reaches the books/)).toBeInTheDocument()
  })

  it('is still issued, and still numbered', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<DocumentEditor {...quoting()} kind="quotation" />, {
      bridge: bridgeFor(quote(), quote({ status: 'issued', number: 'QTN/2026-27/0001' })),
    })

    await user.click(await screen.findByRole('button', { name: 'Issue' }))

    await waitFor(() => expect(bridge.callsTo('documents:issue')).toHaveLength(1))
    const toasts = within(screen.getByRole('region', { name: 'Notifications' }))
    expect(await toasts.findByText(/QTN\/2026-27\/0001/)).toBeInTheDocument()
    expect(toasts.getByText(/puts nothing in the books/)).toBeInTheDocument()
  })

  /* It has no entry to reverse, so a cancellation toast promising one would be a
   * sentence about something that did not happen. */
  it('is cancelled without anything being reversed', async () => {
    const user = userEvent.setup()
    const issuedQuote = quote({ status: 'issued', number: 'QTN/2026-27/0001' })
    renderScreen(<DocumentEditor {...quoting()} kind="quotation" />, {
      bridge: bridgeFor(issuedQuote, quote({ status: 'cancelled', number: 'QTN/2026-27/0001' })),
    })

    await user.click(await screen.findByRole('button', { name: 'Cancel this quotation' }))

    const toasts = within(screen.getByRole('region', { name: 'Notifications' }))
    expect(await toasts.findByText(/nothing posted to reverse/)).toBeInTheDocument()
  })

  /* Nothing was ever received against a quotation, because nothing was ever owed. */
  it('is never asked what has been received against it', async () => {
    const issuedQuote = quote({ status: 'issued', number: 'QTN/2026-27/0001' })
    const { bridge } = renderScreen(<DocumentEditor {...quoting()} kind="quotation" />, {
      bridge: bridgeFor(issuedQuote, issuedQuote, settlement()),
    })

    await screen.findByLabelText('Customer')
    expect(bridge.callsTo('receipts:settlement')).toHaveLength(0)
  })
})

describe('a document of another kind', () => {
  /** A credit note bridge that also answers the corrections picker's query. */
  const bridge = (stored: Document): BridgeStub => {
    const base = bridgeFor(stored)
    return {
      ...base,
      documents: {
        ...base.documents,
        list: () => Promise.resolve<Result<DocumentSummary[]>>({ ok: true, data: [] }),
      },
    } as BridgeStub
  }

  const asCreditNote = (
    <DocumentEditor
      {...screenContext({ route: testRoute('credit-note', { id: 'doc-1' }) })}
      kind="credit-note"
    />
  )

  /*
   * THE ONE HAZARD ONE EDITOR FOR FIVE KINDS CREATES. The kind comes from the route and
   * so does the id, independently — so a hand-built link or a stale Back can load an
   * invoice into the credit note editor. Nothing would look wrong: the heading would say
   * Credit note, the corrections picker would appear, and the save would be refused by
   * 0013's trigger naming a document the user had just been shown.
   *
   * The screen says so and adopts NOTHING. Asserting only on the message would pass
   * against a screen that showed the notice and drew the invoice underneath it.
   */
  it('refuses an invoice, and draws none of it', async () => {
    renderScreen(asCreditNote, { bridge: bridge(document({ kind: 'sales-invoice' })) })

    expect(await screen.findByText(/not a credit note/)).toBeInTheDocument()
    expect(screen.getByLabelText('Customer')).toHaveValue('')
    expect(screen.getByLabelText('Description, line 1')).toHaveValue('')
  })

  it('draws the one it was asked for', async () => {
    renderScreen(asCreditNote, { bridge: bridge(document({ kind: 'credit-note' })) })

    await waitFor(() => expect(screen.getByLabelText('Customer')).toHaveValue('party-1'))
    expect(screen.getByLabelText('Description, line 1')).toHaveValue('Ball bearing 6203')
    expect(screen.queryByText(/not a credit note/)).toBeNull()
  })
})

describe('the registrations', () => {
  it('registers an editor for every kind the shared table knows', () => {
    expect(documentEditorScreens.map((definition) => definition.id)).toEqual(
      DOCUMENT_KINDS.map((definition) => definition.kind),
    )
  })

  /* An editor is reached from its register or from a row, never from the sidebar — there
   * is no such thing as "the" credit note to land on. */
  it('puts none of them in the sidebar', () => {
    for (const definition of documentEditorScreens) {
      expect(definition.nav).toBeUndefined()
    }
  })
})
