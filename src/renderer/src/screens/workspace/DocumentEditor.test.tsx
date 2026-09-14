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
 * AND THE FOURTH, ADDED IN 0017: WHAT A STORED LINE KEEPS WHEN NOBODY TOUCHES IT. The
 * item, the unit, the charge flag and the account were stored, drawn nowhere and sent
 * nowhere, so opening a document and pressing Save wrote back lines with all four stripped
 * off and nothing on screen changed. Those tests assert on WHAT CROSSED THE BOUNDARY for
 * the reason this file keeps repeating: a picker whose value matches no option falls back
 * to the first one, so a control can read perfectly while the state behind it is empty —
 * and here the state behind it did not exist at all.
 *
 * WHAT IS OUTSTANDING IS ASKED FOR SEPARATELY, and the tests at the foot of this file say
 * why that is the right shape: it is a fact about the ledger rather than a field on the
 * document, so a draft is never asked about at all, and a cancelled invoice comes back at
 * nothing without the screen knowing anything about reversals.
 */

import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  Account,
  Document,
  DocumentLineDto,
  DocumentListRow,
  DocumentOffsetDto,
  DocumentSettlement,
  DocumentStatusDto,
  ItemSummary,
  OpenDocument,
  PartySummary,
  Result,
  UnitOfMeasure,
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

/*
 * The three master lists a line is picked from.
 *
 * ORDERED TO DISAGREE WITH EVERY EXPECTED ANSWER, which is the only reason they are in
 * this order. The item every test picks is the SECOND one, the unit is the SECOND one and
 * the account is the THIRD — so "picking an item fills the description" cannot pass
 * against a screen that always takes row one, and a `<select>` falling back to its first
 * option cannot look like a choice. `Ball bearing 6203` is first on purpose too: it is
 * what the stored document already says, so a picker that did nothing at all would leave
 * the assertions reading correctly.
 */
const ITEMS: ItemSummary[] = [
  {
    id: 'item-1',
    code: 'BRG-6203',
    name: 'Ball bearing 6203',
    kind: 'goods',
    unitCode: 'NOS',
    classificationCode: '8482',
    taxRatePct: '18.000',
    salePrice: '500.00',
    purchasePrice: null,
    salesAccountId: null,
    purchaseAccountId: null,
    isSold: true,
    isPurchased: true,
    isCharge: false,
    isArchived: false,
  },
  {
    id: 'item-2',
    code: 'SEAL-25',
    name: 'Oil seal 25x40',
    kind: 'goods',
    unitCode: 'KGS',
    classificationCode: '4016',
    taxRatePct: '12.000',
    salePrice: '90.00',
    purchasePrice: null,
    salesAccountId: null,
    purchaseAccountId: null,
    isSold: true,
    isPurchased: true,
    isCharge: false,
    isArchived: false,
  },
  /* An item that IS a charge — freight, sold by the consignment. */
  {
    id: 'item-3',
    code: null,
    name: 'Freight',
    kind: 'service',
    unitCode: null,
    classificationCode: '9965',
    taxRatePct: '5.000',
    salePrice: null,
    purchasePrice: null,
    salesAccountId: null,
    purchaseAccountId: null,
    isSold: true,
    isPurchased: true,
    isCharge: true,
    isArchived: false,
  },
]

const UNITS: UnitOfMeasure[] = [
  { code: 'NOS', name: 'Numbers', decimalPlaces: 0, regimeCode: 'NOS', isArchived: false },
  { code: 'KGS', name: 'Kilograms', decimalPlaces: 3, regimeCode: 'KGS', isArchived: false },
]

function chartAccount(over: Partial<Account> = {}): Account {
  return {
    id: 'acc-sales',
    code: '4000',
    name: 'Sales',
    type: 'income',
    normalBalance: 'credit',
    parentId: null,
    isGroup: false,
    isArchived: false,
    description: null,
    depth: 1,
    roles: [],
    ...over,
  }
}

/* A group first and an archived account last, so both filters have something to catch. */
const ACCOUNTS: Account[] = [
  chartAccount({ id: 'acc-group', code: '5000', name: 'Direct Expenses', isGroup: true }),
  chartAccount(),
  chartAccount({ id: 'acc-courier', code: '5210', name: 'Courier and Postage', type: 'expense' }),
  chartAccount({ id: 'acc-old', code: '5900', name: 'Closed Expense', isArchived: true }),
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
    originalDocumentNumber: null,
    originalDocumentDate: null,
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
    offset: '0.00',
    outstanding: '1180.00',
    receipts: [],
    offsets: [],
    ...over,
  }
}

/** One of the charge documents a credit note's picker offers, as main lists it. */
function openInvoice(over: Partial<OpenDocument> = {}): OpenDocument {
  return {
    id: 'inv-1',
    kind: 'sales-invoice',
    number: 'INV/2026-27/0001',
    date: '2026-04-15',
    grandTotal: '1180.00',
    outstanding: '1180.00',
    ...over,
  }
}

/** One credit note set against one invoice, as either end's settlement reports it. */
function offsetRow(over: Partial<DocumentOffsetDto> = {}): DocumentOffsetDto {
  return {
    offsetId: 'off-1',
    documentId: 'crn-1',
    documentKind: 'credit-note',
    documentNumber: 'CRN/2026-27/0001',
    documentDate: '2026-04-20',
    amount: '300.00',
    ...over,
  }
}

/**
 * The master lists behind the line pickers. Every test gets them; a test ABOUT one passes
 * its own — `{ units: [] }` is a company on its first day, which seeds no units at all.
 */
interface Masters {
  items?: ItemSummary[]
  units?: UnitOfMeasure[]
  accounts?: Account[]
}

/** A bridge that serves one document and echoes a chosen answer back from every write. */
function bridgeFor(
  stored: Document | null,
  answer: Document = document(),
  settled: DocumentSettlement = settlement(),
  open: OpenDocument[] = [],
  masters: Masters = {},
): BridgeStub {
  return {
    parties: {
      list: () => Promise.resolve<Result<PartySummary[]>>({ ok: true, data: CUSTOMERS }),
    },
    /*
     * THE THREE LISTS A LINE IS PICKED FROM, ANSWERED HERE FOR THE REASON `openForOffset`
     * IS. The harness fails a test by name on any channel nothing answers, so the moment
     * the grid grew an item column every test in this file would have failed on a missing
     * stub, for a reason that had nothing to do with what it was asserting.
     */
    items: {
      list: () =>
        Promise.resolve<Result<ItemSummary[]>>({ ok: true, data: masters.items ?? ITEMS }),
    },
    units: {
      list: () =>
        Promise.resolve<Result<UnitOfMeasure[]>>({ ok: true, data: masters.units ?? UNITS }),
    },
    ledger: {
      listAccounts: () =>
        Promise.resolve<Result<Account[]>>({ ok: true, data: masters.accounts ?? ACCOUNTS }),
    },
    documents: {
      /* `settlement` is asked for any document that has posted. A draft never reaches it,
       * which is what the first test in `what has been received` asserts. It is on this
       * group rather than on `receipts` since 0016, when what settles a document stopped
       * being only money. */
      settlement: () => Promise.resolve<Result<DocumentSettlement>>({ ok: true, data: settled }),
      /*
       * THE OFFSET PICKER IS ANSWERED HERE RATHER THAN IN THE CREDIT NOTE SECTION, and
       * that is not tidiness. The harness fails a test by name on any channel nothing
       * answers, so the moment the panel started asking for this, every test that renders
       * an ISSUED credit or debit note failed on a missing stub — for a reason that had
       * nothing to do with what it was asserting. A default that answers with an empty
       * list keeps those tests about their own subject; the tests that are about the
       * picker pass `open`.
       */
      openForOffset: () => Promise.resolve<Result<OpenDocument[]>>({ ok: true, data: open }),
      /* `offset` answers with the note's whole settlement, which is what the panel
       * adopts. The default echoes the same one back; a test about adopting it sends a
       * different one. */
      offset: () => Promise.resolve<Result<DocumentSettlement>>({ ok: true, data: settled }),
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

/** The cell one of a line's controls sits in. Scoped to the CELL, never to the row. */
const cellOf = (control: HTMLElement): HTMLElement => control.closest('td') as HTMLElement

/** The lines of the last save, as they crossed the bridge. */
const linesSentTo = (
  bridge: { lastCallTo(channel: string): { args: readonly unknown[] } | undefined },
  channel: string,
): Record<string, unknown>[] => sentTo(bridge, channel)?.['lines'] as Record<string, unknown>[]

describe('what a stored line keeps when nothing is touched', () => {
  /*
   * THE TEST THIS BATCH EXISTS FOR, AND IT FAILED AGAINST THE CODE BEFORE IT.
   *
   * `itemId`, `unitCode`, `isCharge` and `accountId` were on `DocumentLineInput` from the
   * start, validated by the handler, stored by the repository and honoured by the posting
   * rule — and `LineDraft` carried none of them. So opening a saved document and pressing
   * Save wrote back lines with the item stripped off, the unit gone and any account
   * override discarded, and the screen looked identical before and after. That is data
   * loss with nothing on screen to notice it by, which is why it is asserted at the
   * BOUNDARY rather than on the picker: a control can read correctly while the state
   * behind it is empty, and here the state behind it did not exist at all.
   */
  it('keeps the item a stored line names', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document({ lines: [line({ itemId: 'item-2' })] })),
    })

    await waitFor(() => expect(screen.getByLabelText('Customer')).toHaveValue('party-1'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('documents:update')).toHaveLength(1))
    expect(linesSentTo(bridge, 'documents:update')[0]?.['itemId']).toBe('item-2')
  })

  it('keeps the unit a stored line was counted in', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document({ lines: [line({ unitCode: 'KGS' })] })),
    })

    await waitFor(() => expect(screen.getByLabelText('Customer')).toHaveValue('party-1'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('documents:update')).toHaveLength(1))
    expect(linesSentTo(bridge, 'documents:update')[0]?.['unitCode']).toBe('KGS')
  })

  /* A charge line that came back as an ordinary one would move freight out of
   * `freight-outward` and into sales, and a dropped override would move a bought service
   * out of its own expense account and into purchases. Neither shows on the document. */
  it('keeps a charge line a charge, and the account it was pointed at', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document({ lines: [line({ isCharge: true, accountId: 'acc-courier' })] })),
    })

    await waitFor(() => expect(screen.getByLabelText('Customer')).toHaveValue('party-1'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('documents:update')).toHaveLength(1))
    expect(linesSentTo(bridge, 'documents:update')[0]).toMatchObject({
      isCharge: true,
      accountId: 'acc-courier',
    })
  })

  /* And a line that picked nothing still says nothing, which is what keeps free text
   * exactly as legal as it was before any of this existed. */
  it('says nothing about an item, a unit or an account on a free-text line', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document()),
    })

    await waitFor(() => expect(screen.getByLabelText('Customer')).toHaveValue('party-1'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('documents:update')).toHaveLength(1))
    const sent = linesSentTo(bridge, 'documents:update')[0]
    expect(sent).not.toHaveProperty('itemId')
    expect(sent).not.toHaveProperty('unitCode')
    expect(sent).not.toHaveProperty('isCharge')
    expect(sent).not.toHaveProperty('accountId')
  })
})

describe('the item a line is', () => {
  /* Only what this side deals in. An item is very often both bought and sold, so this
   * narrows the picker rather than saying what the item is. */
  it('asks for the items this side sells', async () => {
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document()),
    })

    await waitFor(() => expect(bridge.callsTo('items:list')).toHaveLength(1))
    expect(sentTo(bridge, 'items:list')?.['side']).toBe('sold')
  })

  it('offers what main listed, above an option for a line that is no item at all', async () => {
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document()),
    })

    const picker = await screen.findByLabelText('Item, line 1')
    const offered = within(cellOf(picker))
      .getAllByRole('option')
      .map((option) => option.textContent)

    expect(offered).toEqual([
      'None — type the line yourself',
      'BRG-6203 — Ball bearing 6203',
      'SEAL-25 — Oil seal 25x40',
      'Freight',
    ])
  })

  /*
   * WHAT CROSSED THE BOUNDARY, not what the picker reads. A `<select>` shows its first
   * option when its value matches none, so a screen that recorded nothing at all would
   * still LOOK as though an item had been chosen — and the item picked here is the second
   * in the list precisely so that "it took row one" cannot pass.
   */
  it('fills the line from the item that was picked, and sends its id', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document()),
    })

    await waitFor(() => expect(screen.getByLabelText('Customer')).toHaveValue('party-1'))
    await user.selectOptions(screen.getByLabelText('Item, line 1'), 'item-2')

    /* The boxes first, because a user edits them from here — and then what actually
     * crossed, because the two are different claims and only the second one is safe. */
    expect(screen.getByLabelText('Item, line 1')).toHaveValue('item-2')
    expect(screen.getByLabelText('Description, line 1')).toHaveValue('Oil seal 25x40')
    expect(screen.getByLabelText('Unit, line 1')).toHaveValue('KGS')
    expect(screen.getByLabelText('Unit price, line 1')).toHaveValue('90.00')

    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('documents:update')).toHaveLength(1))
    expect(linesSentTo(bridge, 'documents:update')[0]).toMatchObject({
      itemId: 'item-2',
      description: 'Oil seal 25x40',
      unitCode: 'KGS',
      unitPrice: '90.00',
      ratePct: '12.000',
      classificationCode: '4016',
    })
  })

  /*
   * THE DECISION, WRITTEN DOWN. A line is a COPY of an item and not a reference to one —
   * `dto.ts` says a line stores its own description, price and rate so that repricing an
   * item later cannot rewrite history. So the id is what the line IS and the description
   * is what was PRINTED, and typing over the printing does not make it another item.
   */
  it('is still that item after the description is rewritten', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document()),
    })

    await waitFor(() => expect(screen.getByLabelText('Customer')).toHaveValue('party-1'))
    await user.selectOptions(screen.getByLabelText('Item, line 1'), 'item-2')
    const description = screen.getByLabelText('Description, line 1')
    await user.clear(description)
    await user.type(description, 'Oil seal, as agreed on the phone')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('documents:update')).toHaveLength(1))
    expect(linesSentTo(bridge, 'documents:update')[0]).toMatchObject({
      itemId: 'item-2',
      description: 'Oil seal, as agreed on the phone',
    })
  })

  /*
   * An item that IS freight brings the flag with it, so the commonest charge line on a
   * document needs nobody to remember the box. It also has no standard price — and an item
   * that states no price states nothing about one, so the figure already in the box stays
   * where it is rather than being cleared out from under somebody.
   */
  it('takes the charge flag from an item that is freight, and asks no price of it', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document()),
    })

    await waitFor(() => expect(screen.getByLabelText('Customer')).toHaveValue('party-1'))
    await user.selectOptions(screen.getByLabelText('Item, line 1'), 'item-3')
    expect(screen.getByLabelText('Unit price, line 1')).toHaveValue('500.00')

    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('documents:update')).toHaveLength(1))
    expect(linesSentTo(bridge, 'documents:update')[0]).toMatchObject({
      itemId: 'item-3',
      description: 'Freight',
      isCharge: true,
      unitPrice: '500.00',
    })
  })

  /* The inverse, and it is not an undo: what was seeded became the line's own text the
   * moment it landed, so unpicking must not empty the line somebody is looking at. */
  it('stops being an item without emptying what was printed', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document({ lines: [line({ itemId: 'item-2' })] })),
    })

    await waitFor(() => expect(screen.getByLabelText('Customer')).toHaveValue('party-1'))
    await user.selectOptions(screen.getByLabelText('Item, line 1'), '')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('documents:update')).toHaveLength(1))
    const sent = linesSentTo(bridge, 'documents:update')[0]
    expect(sent).not.toHaveProperty('itemId')
    expect(sent?.['description']).toBe('Ball bearing 6203')
  })

  /*
   * AN ARCHIVED ITEM IS NOT IN THE PICKER AND IS STILL ON THE INVOICE. `items.list` leaves
   * archived items out, so without an option of its own the control would fall back to
   * displaying the FIRST item in the list — an issued invoice naming goods it was never
   * made of, convincingly and with nothing to notice it by.
   */
  it('shows an item the list no longer offers rather than the first one it does', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document({ lines: [line({ itemId: 'item-archived' })] })),
    })

    const picker = await screen.findByLabelText('Item, line 1')
    await waitFor(() => expect(picker).toHaveValue('item-archived'))
    expect(
      within(cellOf(picker)).getByRole('option', { name: 'An item that is no longer listed' }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(bridge.callsTo('documents:update')).toHaveLength(1))
    expect(linesSentTo(bridge, 'documents:update')[0]?.['itemId']).toBe('item-archived')
  })
})

describe('the unit a quantity is counted in', () => {
  it('offers the units main listed, and none as an answer of its own', async () => {
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document()),
    })

    const picker = await screen.findByLabelText('Unit, line 1')
    const offered = within(cellOf(picker))
      .getAllByRole('option')
      .map((option) => option.textContent)

    expect(offered).toEqual(['No unit', 'NOS — Numbers', 'KGS — Kilograms'])
  })

  it('sends the unit that was chosen', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document()),
    })

    await waitFor(() => expect(screen.getByLabelText('Customer')).toHaveValue('party-1'))
    await user.selectOptions(screen.getByLabelText('Unit, line 1'), 'KGS')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('documents:update')).toHaveLength(1))
    expect(linesSentTo(bridge, 'documents:update')[0]?.['unitCode']).toBe('KGS')
  })

  /*
   * NO UNITS IS THE FIRST-RUN STATE, NOT A BROKEN CONTROL. `setUpBooks` seeds none at all,
   * so every company starts here — and a picker with one option must read as "a line needs
   * none" rather than as a list that failed to arrive.
   */
  it('says so when the books have no units, and leaves the picker usable', async () => {
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document(), document(), settlement(), [], { units: [] }),
    })

    const picker = await screen.findByLabelText('Unit, line 1')
    expect(picker).toBeEnabled()
    expect(within(cellOf(picker)).getAllByRole('option')).toHaveLength(1)
    expect(screen.getByText(/No units are set up yet/)).toBeInTheDocument()
  })

  /* And the sentence is not said where it is untrue — which is a real absence, because
   * the same string renders in the test above. */
  it('says nothing about setting units up once there are some', async () => {
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document()),
    })

    await screen.findByLabelText('Unit, line 1')
    expect(screen.queryByText(/No units are set up yet/)).toBeNull()
  })

  /* A line with no unit is a complete line, and always was. */
  it('sends a line with no unit at all, and sends it', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document(), document(), settlement(), [], { units: [] }),
    })

    await waitFor(() => expect(screen.getByLabelText('Customer')).toHaveValue('party-1'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('documents:update')).toHaveLength(1))
    const sent = linesSentTo(bridge, 'documents:update')
    expect(sent).toHaveLength(1)
    expect(sent[0]).not.toHaveProperty('unitCode')
  })
})

describe('a charge line', () => {
  /*
   * THE USER'S WORDS. `isCharge` is the field; freight and packing are what somebody is
   * looking at. The posting rule sends a line carrying it to `freight-outward` on a sale
   * and `freight-inward` on a purchase — which is not a mirror of one treatment, because
   * carriage a supplier charges is part of what the goods cost and outward freight is a
   * selling cost being recovered.
   */
  it('marks freight as a charge rather than as goods sold', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document()),
    })

    await waitFor(() => expect(screen.getByLabelText('Customer')).toHaveValue('party-1'))
    await user.click(screen.getByLabelText('Freight or packing, line 1'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('documents:update')).toHaveLength(1))
    expect(linesSentTo(bridge, 'documents:update')[0]?.['isCharge']).toBe(true)
  })

  it('shows a stored charge line as one', async () => {
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document({ lines: [line({ isCharge: true })] })),
    })

    await waitFor(() => expect(screen.getByLabelText('Freight or packing, line 1')).toBeChecked())
  })
})

describe('the account a line posts to', () => {
  /*
   * NEVER A GROUP. A group totals its children and accepts no posting of its own, so
   * offering one offers a save main refuses. The archived one is out for the ordinary
   * reason. Both are in the fixture, and the group is FIRST — so a missing filter would
   * leave it as the option the control falls back to.
   */
  it('offers only the accounts a line may post to', async () => {
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document()),
    })

    const picker = await screen.findByLabelText('Account, line 1')
    const offered = within(cellOf(picker))
      .getAllByRole('option')
      .map((option) => option.textContent)

    expect(offered).toEqual([
      'Wherever this line normally posts',
      '4000 — Sales',
      '5210 — Courier and Postage',
    ])
  })

  /*
   * WHAT MAKES AN EXPENSE ENTRY POSSIBLE AT ALL. Without this, every line of a purchase
   * bill posts to Purchases, and the courier bill a business actually receives has nowhere
   * to go. `valueAccountFor` reads the line's own account before it reads the role.
   */
  it('sends the account a line was pointed at', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document()),
    })

    await waitFor(() => expect(screen.getByLabelText('Customer')).toHaveValue('party-1'))
    await user.selectOptions(screen.getByLabelText('Account, line 1'), 'acc-courier')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('documents:update')).toHaveLength(1))
    expect(linesSentTo(bridge, 'documents:update')[0]?.['accountId']).toBe('acc-courier')
  })

  /* An account archived after the document was issued is not in the list and is still
   * where that line posted — the same fallback trap as an archived item. */
  it('shows an account the list no longer offers rather than the first one it does', async () => {
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(document({ lines: [line({ accountId: 'acc-old' })] })),
    })

    const picker = await screen.findByLabelText('Account, line 1')
    await waitFor(() => expect(picker).toHaveValue('acc-old'))
    expect(
      within(cellOf(picker)).getByRole('option', { name: 'An account that is no longer listed' }),
    ).toBeInTheDocument()
  })
})

describe('creating one', () => {
  it('will not create without a customer, a date and a line', async () => {
    renderScreen(<DocumentEditor {...creating()} kind="sales-invoice" />, {
      bridge: bridgeFor(null),
    })

    expect(await screen.findByRole('button', { name: 'Create draft' })).toBeDisabled()
  })

  /*
   * ONE FIELD AT A TIME, ASSERTING AFTER EACH — because a button that goes from disabled
   * to enabled somewhere in a block of four actions is a button no assertion has watched.
   * What this proves is that the item picker fills in enough of a line to SEND it: the
   * description and the price arrive together from the item, and neither was typed.
   */
  it('fills a new line from an item, one field at a time', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<DocumentEditor {...creating()} kind="sales-invoice" />, {
      bridge: bridgeFor(null, document({ id: 'doc-9' })),
    })

    const create = await screen.findByRole('button', { name: 'Create draft' })
    expect(create).toBeDisabled()

    await user.selectOptions(screen.getByLabelText('Customer'), 'party-1')
    expect(create).toBeDisabled()

    await user.type(screen.getByLabelText('Date'), '2026-04-15')
    expect(create).toBeDisabled()

    await user.selectOptions(screen.getByLabelText('Item, line 1'), 'item-2')
    expect(create).toBeEnabled()

    await user.click(create)
    await waitFor(() => expect(bridge.callsTo('documents:create')).toHaveLength(1))
    expect(linesSentTo(bridge, 'documents:create')[0]).toMatchObject({
      itemId: 'item-2',
      description: 'Oil seal 25x40',
      quantity: '1',
      unitPrice: '90.00',
      unitCode: 'KGS',
    })
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
    expect(bridge.callsTo('documents:settlement')).toHaveLength(0)
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

/*
 * WHAT WAS OFFSET AGAINST IT, WHICH IS NOT WHAT WAS PAID (0016).
 *
 * A credit note set against an invoice settles it and moves no money, so before this
 * panel existed an invoice reduced by one showed a smaller outstanding with nothing on
 * the page to explain it. The figures arrive as two — `allocated` and `offset` — and are
 * drawn as two, because "who paid this" and "what did we credit against it" are different
 * questions with different lists behind them.
 *
 * THE HEADING IS THE ASSERTION WORTH THE MOST HERE. A charge document's offsets are refund
 * documents, and which refund document depends on the side: a purchase bill is settled by
 * a debit note. A screen that wrote "Credit note" into the markup would be right on the
 * sales side and wrong on the other, and nothing about the sales-side test could see it.
 */
describe('what has been offset against it', () => {
  const issued = () => document({ status: 'issued', number: 'INV/2026-27/0001' })

  /** The figure cell of the row whose label matches, which is never the label cell. */
  const figureIn = (label: RegExp): HTMLElement => {
    const row = screen.getByText(label).closest('tr') as HTMLElement
    return within(row).getAllByRole('cell')[1] as HTMLElement
  }

  /*
   * THREE FIGURES THAT DISAGREE, on purpose. Main sends what money settled, what documents
   * settled, and what is left; a panel that printed one of them twice would look entirely
   * ordinary against a fixture where two of them were equal.
   */
  it('prints what documents settled it apart from what money settled it', async () => {
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(
        issued(),
        issued(),
        settlement({
          movement: '1180.00',
          allocated: '500.00',
          offset: '300.00',
          outstanding: '380.00',
        }),
      ),
    })

    await screen.findByText('Outstanding')
    expect(figureIn(/Settled against this sales invoice/)).toHaveTextContent(/^500\.00$/)
    expect(figureIn(/Less credit notes set against it/)).toHaveTextContent(/^300\.00$/)
    expect(figureIn(/^Outstanding$/)).toHaveTextContent(/^380\.00$/)
  })

  /*
   * THE COLUMN CARRIES THE SIGN AND THE FIGURE KEEPS THE ONE IT ARRIVED WITH (§1.7). The
   * offset is taken OFF the movement to reach the outstanding underneath it, and main
   * sends it as a positive quantity — so the heading says "Less" and the cell says
   * 300.00. A screen that negated its copy would show the same credit as -300.00 here and
   * as 300.00 in the list below, which is one page contradicting itself.
   */
  it('says the offset is subtracted rather than printing a negative', async () => {
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(
        issued(),
        issued(),
        settlement({ offset: '300.00', outstanding: '880.00', offsets: [offsetRow()] }),
      ),
    })

    await screen.findByText('Outstanding')
    expect(figureIn(/Less credit notes set against it/)).toHaveTextContent(/^300\.00$/)
    const listed = screen.getByText('CRN/2026-27/0001').closest('tr') as HTMLElement
    expect(within(listed).getAllByRole('cell')[2]).toHaveTextContent(/^300\.00$/)
  })

  it('names the credit notes that were set against it, with their dates', async () => {
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(
        issued(),
        issued(),
        settlement({ offset: '300.00', outstanding: '880.00', offsets: [offsetRow()] }),
      ),
    })

    expect(await screen.findByRole('columnheader', { name: 'Credit note' })).toBeInTheDocument()
    const row = (await screen.findByText('CRN/2026-27/0001')).closest('tr') as HTMLElement
    const cells = within(row).getAllByRole('cell')
    expect(cells[1]).toHaveTextContent(/^2026-04-20$/)
    expect(cells[2]).toHaveTextContent(/^300\.00$/)
  })

  /*
   * TWO LISTS, NOT ONE. The receipt and the credit note settled the same invoice by
   * different amounts, and each figure has to appear under its own heading — a panel that
   * drew the offsets into the receipts table would still show both numbers somewhere.
   */
  it('keeps the money and the credit in separate lists', async () => {
    renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(
        issued(),
        issued(),
        settlement({
          allocated: '500.00',
          offset: '300.00',
          outstanding: '380.00',
          receipts: [
            {
              receiptId: 'rct-1',
              number: 'RCT/2026-27/0001',
              date: '2026-04-18',
              amount: '500.00',
            },
          ],
          offsets: [offsetRow()],
        }),
      ),
    })

    const receipt = (await screen.findByText('RCT/2026-27/0001')).closest('tr') as HTMLElement
    expect(within(receipt).getAllByRole('cell')[2]).toHaveTextContent(/^500\.00$/)
    const offset = screen.getByText('CRN/2026-27/0001').closest('tr') as HTMLElement
    expect(within(offset).getAllByRole('cell')[2]).toHaveTextContent(/^300\.00$/)
  })

  /*
   * AND THE OTHER SIDE, which is what makes the heading a rule rather than a string. A
   * purchase bill is settled by a DEBIT note; a screen with the sales-side word written
   * into it passes every test above and tells a buyer their supplier raised them a credit
   * note.
   */
  it('heads a bill offsets with the debit note, not the credit note', async () => {
    const bill = document({ kind: 'purchase-bill', status: 'issued', number: 'BILL/2026-27/0001' })
    renderScreen(
      <DocumentEditor
        {...screenContext({ route: testRoute('purchase-bill', { id: 'doc-1' }) })}
        kind="purchase-bill"
      />,
      {
        bridge: bridgeFor(
          bill,
          bill,
          settlement({
            offset: '300.00',
            outstanding: '880.00',
            offsets: [
              offsetRow({ documentKind: 'debit-note', documentNumber: 'DBN/2026-27/0001' }),
            ],
          }),
        ),
      },
    )

    expect(await screen.findByRole('columnheader', { name: 'Debit note' })).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Credit note' })).toBeNull()
    expect(screen.getByText(/Less debit notes set against it/)).toBeInTheDocument()
  })

  /* The invoice is the settled end, never the settling one: the set is owned by the note.
   * So there is no picker here and nothing is asked for one. */
  it('is never asked what an invoice could be set against', async () => {
    const { bridge } = renderScreen(<DocumentEditor {...editing()} kind="sales-invoice" />, {
      bridge: bridgeFor(
        issued(),
        issued(),
        settlement({ offset: '300.00', outstanding: '880.00' }),
      ),
    })

    /* The settlement panel is on screen, and then one more flush: the fetch this is
     * asserting the absence of would be made from the effect that panel's own answer
     * wakes, so a check run any earlier passes against every screen ever written. */
    await screen.findByText('Outstanding')
    await act(async () => {})

    expect(bridge.callsTo('documents:openForOffset')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /^Save what this/ })).toBeNull()
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

  /* And for what it BUYS. Same argument as the vendor list next door, one table down:
   * plenty of items are both, so the side narrows the picker rather than describing the
   * item — and a bill offering only what the business sells would offer nothing at all to
   * the firm that resells nothing it buys. */
  it('asks main for what this side buys, not for what it sells', async () => {
    const { bridge } = renderScreen(<DocumentEditor {...purchase()} kind="purchase-bill" />, {
      bridge: bridgeFor(bill()),
    })

    await waitFor(() => expect(bridge.callsTo('items:list')).toHaveLength(1))
    expect(sentTo(bridge, 'items:list')?.['side']).toBe('purchased')
  })

  /*
   * AND IT DOES NOT SEED A PRICE. `ItemSummary` carries a sale price and no purchase one,
   * which is also the better answer: what a line on a bill costs is what the supplier
   * BILLED, and a stored standard cost put in the box is a figure that agrees with nobody's
   * paperwork and is one keystroke from being accepted. Everything else the item says
   * still fills in.
   */
  it('fills a bill line from the item but leaves the price to the supplier', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<DocumentEditor {...purchase()} kind="purchase-bill" />, {
      bridge: bridgeFor(bill()),
    })

    await waitFor(() => expect(screen.getByLabelText('Vendor')).toHaveValue('party-1'))
    await user.selectOptions(screen.getByLabelText('Item, line 1'), 'item-2')
    expect(screen.getByLabelText('Unit price, line 1')).toHaveValue('500.00')

    await user.clear(screen.getByLabelText('Unit price, line 1'))
    await user.type(screen.getByLabelText('Unit price, line 1'), '84.50')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('documents:update')).toHaveLength(1))
    expect(linesSentTo(bridge, 'documents:update')[0]).toMatchObject({
      itemId: 'item-2',
      description: 'Oil seal 25x40',
      unitPrice: '84.50',
    })
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

  const INVOICES: DocumentListRow[] = [
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
      settlement: 'open',
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
        list: () => Promise.resolve<Result<DocumentListRow[]>>({ ok: true, data: INVOICES }),
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
    await waitFor(() => expect(bridge.callsTo('documents:settlement')).toHaveLength(1))
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

/*
 * THE PANEL THAT SETS A CREDIT NOTE AGAINST THE INVOICES IT SETTLES (0016).
 *
 * A credit note is a pool of money drawn down by refunds and by offsets, which is a
 * receipt's shape exactly — so it gets a receipt's allocation table, and every assertion
 * here has a twin in ReceiptEditor.test.tsx. What differs is that both ends are documents:
 * the set is owned by the REFUND end, and the invoice's screen shows the result.
 *
 * WHAT CROSSED THE BRIDGE IS WHAT IS ASSERTED. The rows are the picker's own answer, so a
 * screen that dropped a line, sent a blank as a zero, or sent one end's id where the other
 * belonged would still draw a table with the right figures in it.
 */
describe('what a credit note settles', () => {
  const issuedNote = (over: Partial<Document> = {}): Document =>
    document({
      kind: 'credit-note',
      status: 'issued',
      number: 'CRN/2026-27/0001',
      entryId: 'entry-1',
      ...over,
    })

  const offsetting = (id = 'doc-1') => screenContext({ route: testRoute('credit-note', { id }) })

  /** What a note has on it before anything is set against it. */
  const noteSettlement = (over: Partial<DocumentSettlement> = {}): DocumentSettlement =>
    settlement({ movement: '1180.00', allocated: '0.00', offset: '0.00', ...over })

  /** The credit note bridge, which also answers the corrections picker's query. */
  function noteBridge(
    settled: DocumentSettlement = noteSettlement(),
    open: OpenDocument[] = [openInvoice()],
    stored: Document = issuedNote(),
  ): BridgeStub {
    const base = bridgeFor(stored, stored, settled, open)
    return {
      ...base,
      documents: {
        ...base.documents,
        list: () => Promise.resolve<Result<DocumentListRow[]>>({ ok: true, data: [] }),
      },
    } as BridgeStub
  }

  /** A stub that answers differently the second time, for asserting on a re-read. */
  function answering<T>(...answers: readonly T[]): () => Promise<Result<T>> {
    let asked = 0
    return () => {
      const answer = answers[Math.min(asked, answers.length - 1)] as T
      asked += 1
      return Promise.resolve<Result<T>>({ ok: true, data: answer })
    }
  }

  const saveOffsets = 'Save what this credit note settles'

  /*
   * IT ASKS ABOUT THE NOTE, not about the party and a kind. `openForOffset` takes the
   * document because both of those are already on it — a picker handed them separately
   * could be given one customer's note and another customer's id, which is what 0016's
   * same-party trigger exists for.
   */
  it('asks main what this note may be set against, naming the note', async () => {
    const { bridge } = renderScreen(<DocumentEditor {...offsetting()} kind="credit-note" />, {
      bridge: noteBridge(),
    })

    await waitFor(() => expect(bridge.callsTo('documents:openForOffset')).toHaveLength(1))
    expect(bridge.lastCallTo('documents:openForOffset')?.args[0]).toBe('doc-1')
  })

  it('lists the open invoices with what is left on each', async () => {
    renderScreen(<DocumentEditor {...offsetting()} kind="credit-note" />, {
      bridge: noteBridge(noteSettlement(), [
        openInvoice(),
        openInvoice({
          id: 'inv-2',
          number: 'INV/2026-27/0002',
          grandTotal: '2360.00',
          outstanding: '400.00',
        }),
      ]),
    })

    const row = (await screen.findByText('INV/2026-27/0002')).closest('tr') as HTMLElement
    const cells = within(row).getAllByRole('cell')
    expect(cells[2]).toHaveTextContent(/^2,360\.00$/)
    expect(cells[3]).toHaveTextContent(/^400\.00$/)
  })

  /* Read off the document table rather than written out — a debit note settles purchase
   * bills, and the assertion for that is in the debit note section. */
  it('heads the picker with the invoice, which is what a credit note settles', async () => {
    renderScreen(<DocumentEditor {...offsetting()} kind="credit-note" />, {
      bridge: noteBridge(),
    })

    expect(await screen.findByRole('columnheader', { name: 'Sales invoices' })).toBeInTheDocument()
  })

  /*
   * A COPY, NOT A SUM. The figure the button writes is the one main computed against the
   * ledger — already net of what other notes and receipts took, which is the case anything
   * the renderer worked out would get wrong.
   */
  it('settles one in full with exactly the figure main sent', async () => {
    const user = userEvent.setup()
    renderScreen(<DocumentEditor {...offsetting()} kind="credit-note" />, {
      bridge: noteBridge(noteSettlement(), [openInvoice({ outstanding: '680.00' })]),
    })

    await user.click(await screen.findByRole('button', { name: 'Settle in full' }))
    expect(screen.getByLabelText('Set against INV/2026-27/0001')).toHaveValue('680.00')
  })

  /* The rows a note already settles come back as available — main puts its own offsets
   * back on the picker — and the box is seeded from them, or the line the panel is
   * showing could not be reduced. */
  it('seeds a line from what the note already settles', async () => {
    renderScreen(<DocumentEditor {...offsetting()} kind="credit-note" />, {
      bridge: noteBridge(
        noteSettlement({
          offset: '300.00',
          outstanding: '880.00',
          offsets: [offsetRow({ documentId: 'inv-1', documentNumber: 'INV/2026-27/0001' })],
        }),
      ),
    })

    await waitFor(() =>
      expect(screen.getByLabelText('Set against INV/2026-27/0001')).toHaveValue('300.00'),
    )
  })

  /*
   * EACH INVOICE APPEARS ONCE, in the panel that can change it. The settlement below draws
   * a read-only list of the same offsets when it is the CHARGE end looking at them — and
   * at this end that list would be the picker's own rows printed a second time, with the
   * figures in the boxes above and no way to tell which pair a user should read. Counted
   * rather than asserted absent: a second table would still show the right number.
   */
  it('shows each invoice once, in the panel that can change it', async () => {
    renderScreen(<DocumentEditor {...offsetting()} kind="credit-note" />, {
      bridge: noteBridge(
        noteSettlement({
          offset: '300.00',
          outstanding: '880.00',
          offsets: [offsetRow({ documentId: 'inv-1', documentNumber: 'INV/2026-27/0001' })],
        }),
      ),
    })

    await screen.findByLabelText('Set against INV/2026-27/0001')
    expect(screen.getAllByText('INV/2026-27/0001')).toHaveLength(1)
  })

  /*
   * THE WHOLE SET CROSSES, AND A BLANK IS NOT A ZERO. Main refuses an offset of nothing,
   * so a row nobody filled in is left out — a panel that sent '0.00' would have every save
   * refused for a line the user never touched.
   *
   * The lines are filled in ONE AT A TIME with an assertion after each. Typing both and
   * asserting once passes just as happily against a panel that keeps only the last box it
   * was given.
   */
  it('sends every line that was filled in, and leaves the blank one out', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<DocumentEditor {...offsetting()} kind="credit-note" />, {
      bridge: noteBridge(noteSettlement(), [
        openInvoice(),
        openInvoice({ id: 'inv-2', number: 'INV/2026-27/0002' }),
        openInvoice({ id: 'inv-3', number: 'INV/2026-27/0003' }),
      ]),
    })

    const first = await screen.findByLabelText('Set against INV/2026-27/0001')
    await user.type(first, '100.00')
    expect(first).toHaveValue('100.00')

    const second = screen.getByLabelText('Set against INV/2026-27/0002')
    await user.type(second, '250.00')
    expect(second).toHaveValue('250.00')
    expect(first).toHaveValue('100.00')

    await user.click(screen.getByRole('button', { name: saveOffsets }))

    await waitFor(() => expect(bridge.callsTo('documents:offset')).toHaveLength(1))
    expect(sentTo(bridge, 'documents:offset')).toEqual({
      refundDocumentId: 'doc-1',
      offsets: [
        { chargeDocumentId: 'inv-1', amount: '100.00' },
        { chargeDocumentId: 'inv-2', amount: '250.00' },
      ],
    })
  })

  /*
   * AN EMPTY SET IS A REAL ANSWER, and it is the only way back from a match somebody
   * regrets: it takes every offset off and puts the credit back on account. A panel that
   * refused to send an empty list would leave a wrongly matched invoice matched for ever.
   */
  it('clears every offset when the last line is emptied', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<DocumentEditor {...offsetting()} kind="credit-note" />, {
      bridge: noteBridge(
        noteSettlement({
          offset: '300.00',
          outstanding: '880.00',
          offsets: [offsetRow({ documentId: 'inv-1', documentNumber: 'INV/2026-27/0001' })],
        }),
      ),
    })

    const box = await screen.findByLabelText('Set against INV/2026-27/0001')
    await waitFor(() => expect(box).toHaveValue('300.00'))
    await user.clear(box)
    await user.click(screen.getByRole('button', { name: saveOffsets }))

    await waitFor(() => expect(bridge.callsTo('documents:offset')).toHaveLength(1))
    expect(sentTo(bridge, 'documents:offset')).toEqual({
      refundDocumentId: 'doc-1',
      offsets: [],
    })
  })

  /*
   * IT ADOPTS WHAT CAME BACK AND READS THE PICKER AGAIN, and the second half is the one
   * that is easy to miss. `documents.offset` answers with the note's new settlement, so
   * the FIGURES are right without a second call — but every "outstanding" in the picker is
   * a figure about a DIFFERENT document, and settling one of them has just changed it. A
   * panel that adopted the answer and left the rows alone would show what each invoice had
   * left before the save.
   *
   * The save is released inside `act`, because awaiting the promise is not waiting for the
   * screen: the release schedules the state changes, and it is React that has to flush
   * them before anything on the page can be asserted on.
   */
  it('adopts the settlement it is answered with, and re-reads the picker', async () => {
    const user = userEvent.setup()
    let release: (answer: Result<DocumentSettlement>) => void = () => {}
    const saved = new Promise<Result<DocumentSettlement>>((resolve) => {
      release = resolve
    })

    const base = noteBridge(noteSettlement(), [openInvoice()])
    const { bridge } = renderScreen(<DocumentEditor {...offsetting()} kind="credit-note" />, {
      bridge: {
        ...base,
        documents: {
          ...base.documents,
          openForOffset: answering(
            [openInvoice({ outstanding: '1180.00' })],
            [openInvoice({ outstanding: '900.00' })],
          ),
          offset: () => saved,
        },
      } as BridgeStub,
    })

    const box = await screen.findByLabelText('Set against INV/2026-27/0001')
    await user.type(box, '280.00')
    await user.click(screen.getByRole('button', { name: saveOffsets }))

    /* In flight: the save is not offered twice. */
    expect(screen.getByRole('button', { name: saveOffsets })).toBeDisabled()

    await act(async () => {
      release({
        ok: true,
        data: noteSettlement({ offset: '280.00', outstanding: '900.00' }),
      })
    })

    await waitFor(() => expect(bridge.callsTo('documents:openForOffset')).toHaveLength(2))
    const row = (await screen.findByText('INV/2026-27/0001')).closest('tr') as HTMLElement
    expect(within(row).getAllByRole('cell')[3]).toHaveTextContent(/^900\.00$/)
    /* By CELL, because the picker heads a column "Outstanding" as well — one is what is
     * left on an invoice and the other is what is left on the note. */
    const outstanding = screen
      .getByRole('cell', { name: 'Outstanding' })
      .closest('tr') as HTMLElement
    expect(within(outstanding).getAllByRole('cell')[1]).toHaveTextContent(/^900\.00$/)
  })

  /*
   * MAIN'S SENTENCE, WITH THE FIGURES IN IT. The cap is the repository's and it names both
   * amounts — a screen that paraphrased would drop the one thing the user needs, which is
   * how much of the note is actually left.
   */
  it("shows main's refusal when more is set than the note has left", async () => {
    const user = userEvent.setup()
    const base = noteBridge()
    renderScreen(<DocumentEditor {...offsetting()} kind="credit-note" />, {
      bridge: {
        ...base,
        documents: {
          ...base.documents,
          offset: () =>
            Promise.resolve<Result<DocumentSettlement>>({
              ok: false,
              error: {
                code: 'OFFSET_EXCEEDS_DOCUMENT',
                message:
                  'CRN/2026-27/0001 has 500.00 left to set against anything, and 900.00 was set. Reduce the lines until they come to what is left.',
              },
            }),
        },
      } as BridgeStub,
    })

    await user.type(await screen.findByLabelText('Set against INV/2026-27/0001'), '900.00')
    await user.click(screen.getByRole('button', { name: saveOffsets }))

    expect(await screen.findByText(/has 500\.00 left to set against anything/)).toBeInTheDocument()
  })

  /*
   * THE GATES. A draft has posted nothing, so there is no movement for a line to draw on;
   * a cancelled note's movement has been reversed to nothing. `setOffsets` refuses both
   * with one sentence, and a picker whose save is always refused teaches a user to
   * distrust the panel when what they needed was to issue the note.
   *
   * THE CANCELLED ONE IS WHERE THE STATUS CHECK IS LOAD-BEARING, and it is worth saying
   * which of the two tests can see it. A draft is refused twice over — it is never asked
   * for a settlement either, and the panel has nothing to seed its lines from — so
   * replacing `isOffsetEditable` with `canOffset` alone leaves the draft test green. A
   * cancelled note HAS a settlement, so it is the one where this gate is the only thing
   * standing between the user and a picker main refuses line by line. Which is also why
   * the assertion waits for the settlement panel rather than for the lede: the fetch it is
   * asserting the absence of would be made after the settlement arrives, and a check run
   * before that passes against every screen ever written.
   */
  it('offers no picker on a draft, and asks for nothing', async () => {
    const { bridge } = renderScreen(<DocumentEditor {...offsetting()} kind="credit-note" />, {
      bridge: noteBridge(noteSettlement(), [openInvoice()], document({ kind: 'credit-note' })),
    })

    await screen.findByRole('button', { name: 'Issue' })
    await act(async () => {})

    expect(bridge.callsTo('documents:openForOffset')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: saveOffsets })).toBeNull()
  })

  it('offers no picker on a cancelled one, and asks for nothing', async () => {
    const { bridge } = renderScreen(<DocumentEditor {...offsetting()} kind="credit-note" />, {
      bridge: noteBridge(
        noteSettlement({ movement: '0.00', outstanding: '0.00' }),
        [openInvoice()],
        issuedNote({ status: 'cancelled' }),
      ),
    })

    /* By CELL: the settlement panel is on screen, so anything the picker was going to ask
     * for has been asked for by now. The picker heads a COLUMN "Outstanding", which is why
     * this cannot be `findByText`. */
    await screen.findByRole('cell', { name: 'Outstanding' })
    await act(async () => {})

    expect(bridge.callsTo('documents:openForOffset')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: saveOffsets })).toBeNull()
  })

  /* Nothing of theirs to settle is an ordinary thing to hold, not an unfinished job — and
   * it is said out loud rather than drawn as an empty table. */
  it('says the credit stays on account when they have nothing open', async () => {
    renderScreen(<DocumentEditor {...offsetting()} kind="credit-note" />, {
      bridge: noteBridge(noteSettlement(), []),
    })

    expect(
      await screen.findByText('There is nothing of theirs to set this credit note against'),
    ).toBeInTheDocument()
    expect(screen.getByText(/stays on account/)).toBeInTheDocument()
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
            list: () => Promise.resolve<Result<DocumentListRow[]>>({ ok: true, data: [] }),
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
            list: () => Promise.resolve<Result<DocumentListRow[]>>({ ok: true, data: [] }),
          },
        } as BridgeStub,
      },
    )

    expect(await screen.findByLabelText(/The purchase bill this corrects/)).toBeInTheDocument()
  })

  /*
   * AND THE OTHER HALF OF THE OFFSET PANEL, for the reason above. A credit note settles a
   * `sales-invoice`, which is also what a hardcoded heading and a hardcoded picker would
   * name — so every assertion in `what a credit note settles` passes against a screen that
   * ignores the kind table. Only the purchase side can tell the two apart.
   */
  it('sets a debit note against purchase bills, not invoices', async () => {
    const issuedNote = document({
      kind: 'debit-note',
      status: 'issued',
      number: 'DBN/2026-27/0001',
      entryId: 'entry-1',
    })
    const base = bridgeFor(issuedNote, issuedNote, settlement(), [
      openInvoice({ kind: 'purchase-bill', number: 'BILL/2026-27/0001' }),
    ])
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
            list: () => Promise.resolve<Result<DocumentListRow[]>>({ ok: true, data: [] }),
          },
        } as BridgeStub,
      },
    )

    expect(await screen.findByRole('columnheader', { name: 'Purchase bills' })).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Sales invoices' })).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Save what this debit note settles' }),
    ).toBeInTheDocument()
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
    expect(bridge.callsTo('documents:settlement')).toHaveLength(0)
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
        list: () => Promise.resolve<Result<DocumentListRow[]>>({ ok: true, data: [] }),
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
