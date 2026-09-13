/*
 * The workspace dashboard, rendered. The screen has never had a test until now.
 *
 * What the wording, the ordering and the routing decide is covered as pure functions next
 * door in `overview-view.test.ts`. What is covered only here is what the screen ASKS main
 * for, what it does with each answer, and what it keeps doing when one of them fails —
 * plus the four things this screen has always done and nothing has ever checked: proving
 * which company is open, backing it up, changing the passphrase, and closing it.
 *
 * FIXTURE DATES ARE ALL IN 2019, which the real clock cannot be in. The ageing reports
 * come back stamped `2019-07-31` while the REQUEST has to carry today — so a screen that
 * printed its own clock under the "As at" heading, or sent the report's date back to
 * main, fails here. A fixture set near today would have proved neither.
 *
 * FIXTURES ARE ORDERED TO DISAGREE WITH THE ANSWER. The newest thing in these books is a
 * receipt, and it is the LAST row of the receipts list; the newest document is the SECOND
 * row of the documents list; and the worst overdue item is not the first item of the
 * first report. A screen that took row one of anything gets a different answer.
 */

import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgedItem,
  AgedPartyRow,
  AgedReport,
  CompanyProfile,
  CompanySummary,
  DocumentSummary,
  PartySummary,
  ReceiptSummary,
  RegimeDescription,
  Result,
} from '@shared/dto'
import {
  DEFAULT_REGIME,
  renderScreen,
  screenContext,
  type BridgeStub,
  type RenderedScreen,
} from '../../test/harness'
import { Overview } from './Overview'

// ---- Fixtures ---------------------------------------------------------------

const ACME: CompanySummary = {
  id: 'acme',
  displayName: 'Acme Pvt Ltd',
  filePath: '/books/acme.coffer',
  vaultPath: '/books/acme.coffer.vault',
  lastOpenedAt: '2019-08-14T09:30:00.000Z',
  createdAt: '2019-08-01T09:30:00.000Z',
  availability: 'ok',
}

const ok = <T,>(data: T): Promise<Result<T>> => Promise.resolve({ ok: true, data })
const fails = <T,>(code: string, message: string): Promise<Result<T>> =>
  Promise.resolve({ ok: false, error: { code, message } })

const BUCKETS = [
  { label: 'Not yet due', fromDays: null, toDays: 0 },
  { label: '1-30 days', fromDays: 1, toDays: 30 },
  { label: 'Over 30 days', fromDays: 31, toDays: null },
]

function item(over: Partial<AgedItem> = {}): AgedItem {
  return {
    source: 'document',
    sourceId: 'document-1',
    kind: 'sales-invoice',
    number: 'INV/2019-20/0001',
    date: '2019-04-02',
    dueDate: '2019-05-02',
    daysOverdue: 12,
    bucket: 1,
    amount: '1180.00',
    ...over,
  }
}

function party(over: Partial<AgedPartyRow> = {}): AgedPartyRow {
  return {
    partyId: 'party-1',
    partyName: 'Sunrise Components',
    buckets: ['0.00', '1180.00', '0.00'],
    onAccount: '0.00',
    total: '1180.00',
    items: [item()],
    ...over,
  }
}

/*
 * The receivables report. Every column carries a DIFFERENT figure, so a panel that read
 * the columns in the wrong order, or printed one column's money under another's heading,
 * cannot pass by coincidence.
 */
const RECEIVABLES: AgedReport = {
  side: 'sales',
  asAtDate: '2019-07-31',
  accountId: 'account-receivable',
  accountCode: '1300',
  accountName: 'Accounts Receivable',
  buckets: BUCKETS,
  parties: [
    party(),
    party({
      partyId: 'party-2',
      partyName: 'Halide Metals',
      buckets: ['0.00', '0.00', '9000.00'],
      onAccount: '5000.00',
      total: '4000.00',
      items: [
        /* A credit note, three hundred days old and owed by nobody. `bucket` being null
         * is what says so, and it must never wear the overdue badge. */
        item({
          sourceId: 'document-3',
          kind: 'credit-note',
          number: 'CN/2019-20/0001',
          bucket: null,
          daysOverdue: 300,
          amount: '-5000.00',
        }),
        item({
          sourceId: 'document-2',
          number: 'INV/2019-20/0002',
          daysOverdue: 90,
          bucket: 2,
          amount: '9000.00',
        }),
      ],
    }),
  ],
  totals: {
    buckets: ['200000.00', '1180.00', '1234567.00'],
    onAccount: '5000.00',
    overdue: '1235747.00',
    total: '1430747.00',
  },
  controlBalance: '1430747.00',
  ties: true,
}

const PAYABLES: AgedReport = {
  side: 'purchase',
  asAtDate: '2019-07-31',
  accountId: 'account-payable',
  accountCode: '2100',
  accountName: 'Accounts Payable',
  buckets: BUCKETS,
  parties: [
    party({
      partyId: 'party-3',
      partyName: 'Tamil Coir',
      buckets: ['0.00', '0.00', '4500.00'],
      onAccount: '0.00',
      total: '4500.00',
      items: [
        item({
          source: 'document',
          sourceId: 'document-4',
          kind: 'purchase-bill',
          number: 'BILL/2019-20/0007',
          daysOverdue: 45,
          bucket: 2,
          amount: '4500.00',
        }),
      ],
    }),
  ],
  totals: {
    buckets: ['1000.00', '2000.00', '3000.00'],
    onAccount: '0.00',
    overdue: '5000.00',
    total: '6000.00',
  },
  controlBalance: '6000.00',
  ties: true,
}

function document(over: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    id: 'document-1',
    kind: 'sales-invoice',
    status: 'issued',
    number: 'INV/2019-20/0001',
    date: '2019-04-02',
    dueDate: '2019-05-02',
    partyId: 'party-1',
    partyName: 'Sunrise Components',
    grandTotal: '1180.00',
    ...over,
  }
}

function receipt(over: Partial<ReceiptSummary> = {}): ReceiptSummary {
  return {
    id: 'receipt-1',
    kind: 'receipt',
    status: 'posted',
    number: 'RC/2019-20/0001',
    date: '2019-04-05',
    partyId: 'party-1',
    partyName: 'Sunrise Components',
    amount: '500.00',
    allocated: '0.00',
    unallocated: '500.00',
    ...over,
  }
}

/* Oldest FIRST, which is not the order the panel draws them in. */
const DOCUMENTS: DocumentSummary[] = [
  document(),
  document({
    id: 'document-2',
    number: 'INV/2019-20/0002',
    date: '2019-06-30',
    grandTotal: '9000.00',
  }),
  document({
    id: 'document-3',
    kind: 'credit-note',
    status: 'cancelled',
    number: 'CN/2019-20/0001',
    date: '2019-05-11',
    partyId: 'party-2',
    partyName: 'Halide Metals',
    grandTotal: '5000.00',
  }),
]

/* The newest thing in these books is the LAST row of this list. */
const RECEIPTS: ReceiptSummary[] = [
  receipt({
    id: 'receipt-2',
    kind: 'payment',
    status: 'cancelled',
    number: 'PY/2019-20/0001',
    date: '2019-03-15',
    partyId: 'party-3',
    partyName: 'Tamil Coir',
    amount: '7080.00',
  }),
  receipt({ id: 'receipt-3', number: 'RC/2019-20/0002', date: '2019-07-20', amount: '3000.00' }),
]

const DRAFTS: DocumentSummary[] = [
  document({
    id: 'draft-1',
    status: 'draft',
    number: null,
    date: '2019-06-02',
    grandTotal: '2360.00',
  }),
  document({
    id: 'draft-2',
    kind: 'purchase-bill',
    status: 'draft',
    number: null,
    date: '2019-05-20',
    partyId: 'party-3',
    partyName: 'Tamil Coir',
    grandTotal: '7080.00',
  }),
]

const PROFILE: CompanyProfile = {
  legalName: 'Acme Private Limited',
  tradeName: 'Acme',
  registrationNumber: '29AABCU9603R1ZM',
  jurisdictionCode: '29',
  countryCode: 'in',
  addressLine1: '1 Industrial Estate',
  addressLine2: null,
  city: 'Bengaluru',
  postalCode: '560001',
  email: null,
  phone: null,
  createdAt: '2019-08-01T09:30:00.000Z',
  updatedAt: '2019-08-01T09:30:00.000Z',
}

// ---- The bridge -------------------------------------------------------------

interface Books {
  sales?: () => Promise<Result<AgedReport>>
  purchase?: () => Promise<Result<AgedReport>>
  drafts?: () => Promise<Result<DocumentSummary[]>>
  documents?: () => Promise<Result<DocumentSummary[]>>
  receipts?: () => Promise<Result<ReceiptSummary[]>>
  profile?: () => Promise<Result<CompanyProfile | null>>
  parties?: () => Promise<Result<PartySummary[]>>
}

/*
 * ONE `documents:list` CHANNEL, TWO QUESTIONS. The screen asks it twice — once for the
 * drafts and once for what happened lately — and the stub answers on the INPUT rather
 * than on call order, so a screen that dropped the status filter would be handed the
 * wrong list and fail here rather than quietly listing every document as a draft.
 */
function bridgeFor(books: Books = {}): BridgeStub {
  return {
    reports: {
      aged: (input) =>
        input.side === 'sales'
          ? (books.sales ?? (() => ok(RECEIVABLES)))()
          : (books.purchase ?? (() => ok(PAYABLES)))(),
    },
    documents: {
      list: (input) =>
        input?.status === 'draft'
          ? (books.drafts ?? (() => ok(DRAFTS)))()
          : (books.documents ?? (() => ok(DOCUMENTS)))(),
    },
    receipts: { list: () => (books.receipts ?? (() => ok(RECEIPTS)))() },
    companyProfile: { get: () => (books.profile ?? (() => ok(null)))() },
    parties: { list: () => (books.parties ?? (() => ok([])))() },
    companies: { close: () => ok(undefined) },
  }
}

interface MountOptions {
  books?: Books
  bridge?: BridgeStub
  codes?: number
  /** False renders the screen with no company open, which is a real frame of the shell. */
  isOpen?: boolean
  regime?: RegimeDescription
}

function mount(
  options: MountOptions = {},
): RenderedScreen & { navigate: ReturnType<typeof vi.fn> } {
  const navigate = vi.fn()
  const rendered = renderScreen(<Overview {...screenContext({ navigate })} />, {
    bridge: options.bridge ?? bridgeFor(options.books),
    company: options.isOpen === false ? null : ACME,
    recoveryCodesRemaining: options.codes ?? 5,
    ...(options.regime === undefined ? {} : { regime: options.regime }),
  })
  return Object.assign(rendered, { navigate })
}

// ---- Reading the page -------------------------------------------------------

/** A dashboard panel, by the heading that names it. Every assertion is scoped to one. */
const findPanel = (name: string): Promise<HTMLElement> => screen.findByRole('region', { name })

/** Today, built here rather than imported: a hardcoded date proves nothing about a clock. */
function today(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/*
 * The figure beside a label, FROM THE CELL BESIDE IT — never `toHaveTextContent` on the
 * row, which matches a substring anywhere in it. '1,180.00' appears inside '11,180.00',
 * and a row assertion cannot tell the two columns apart at all.
 */
function figureFor(region: HTMLElement, label: string): string {
  const rows = [...region.querySelectorAll('tr')]
  const row = rows.find((candidate) => candidate.querySelector('td')?.textContent === label)
  if (!row) {
    const labels = rows.map((candidate) => candidate.querySelector('td')?.textContent).join(' | ')
    throw new Error(`No row labelled '${label}' in this panel. Rows: ${labels}`)
  }
  return [...row.querySelectorAll('td')][1]?.textContent ?? '<no figure cell>'
}

/** Every body row of a panel's table, as its cells. */
function bodyRows(region: HTMLElement): HTMLElement[] {
  return [...region.querySelectorAll('tbody tr')].filter(
    (row): row is HTMLElement => row instanceof HTMLElement,
  )
}

function cells(row: HTMLElement): string[] {
  return [...row.querySelectorAll('td')].map((cell) => cell.textContent ?? '')
}

function cellAt(row: HTMLElement | undefined, index: number): string {
  if (row === undefined) return '<no row>'
  return cells(row)[index] ?? '<no cell>'
}

/**
 * The badge on one step of the first-run checklist, once its read has finished.
 *
 * WAITED FOR, AND NOT ON THE BADGE ITSELF. `Not checked` is both "the read failed" and
 * "the read has not happened yet", so an assertion that stopped at the first matching
 * frame would pass against a panel that had asked main nothing. The wait is on the
 * PARTIES step reaching a settled word — both reads land in one tick — and the assertion
 * on the step in question is made after it.
 */
async function stepBadges(panel: HTMLElement): Promise<string[]> {
  await waitFor(() => {
    const settled = [...panel.querySelectorAll('li')][1]?.textContent ?? ''
    expect(settled.includes('To do') || settled.includes('Done')).toBe(true)
  })
  return [...panel.querySelectorAll('li')].map((step) => {
    const badge = step.querySelector('.badge')
    return badge?.textContent ?? '<no badge>'
  })
}

/** The first column of every row: a number, or the word standing in for one. */
function numbersIn(region: HTMLElement): string[] {
  return bodyRows(region).map((row) => cellAt(row, 0))
}

// ---- What it asks main for --------------------------------------------------

describe('the reads', () => {
  it('asks for both ageing reports as at today, and for the same day', async () => {
    const { bridge } = mount()
    await findPanel('What customers owe you')

    await waitFor(() => expect(bridge.callsTo('reports:aged')).toHaveLength(2))
    expect(bridge.callsTo('reports:aged').map((call) => call.args[0])).toEqual([
      { side: 'sales', asAtDate: today() },
      { side: 'purchase', asAtDate: today() },
    ])
  })

  it('asks the document register twice — once for drafts, once for what is recent', async () => {
    const { bridge } = mount()
    await findPanel('Drafts not yet issued')

    await waitFor(() => expect(bridge.callsTo('documents:list')).toHaveLength(2))
    expect(bridge.callsTo('documents:list').map((call) => call.args[0])).toEqual([
      { status: 'draft', limit: 6 },
      { limit: 6 },
    ])
  })

  it('asks for a page of receipts rather than all of them', async () => {
    const { bridge } = mount()
    await findPanel('Lately')

    expect(bridge.lastCallTo('receipts:list')?.args[0]).toEqual({ limit: 6 })
  })

  it('does not pull the party master on a company that already has books', async () => {
    /* `parties.list` has no limit and answers with every party there is. The checklist is
     * the only thing that needs it, and a stocked company never shows the checklist. */
    const { bridge } = mount()
    await findPanel('Lately')

    expect(bridge.callsTo('parties:list')).toHaveLength(0)
    expect(bridge.callsTo('companyProfile:get')).toHaveLength(0)
  })

  it('reads nothing at all until a company is open', async () => {
    /* Every channel here needs one and answers NO_COMPANY_OPEN without it. */
    const { bridge } = mount({ isOpen: false })
    expect(await screen.findByRole('heading', { name: 'No company is open' })).toBeVisible()

    expect(bridge.callsTo('reports:aged')).toHaveLength(0)
    expect(bridge.callsTo('documents:list')).toHaveLength(0)
    expect(bridge.callsTo('receipts:list')).toHaveLength(0)
  })

  it('asks again when Refresh is pressed', async () => {
    const user = userEvent.setup()
    const { bridge } = mount()
    await findPanel('Lately')

    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(bridge.callsTo('reports:aged')).toHaveLength(4))
  })
})

// ---- What is owed, each way -------------------------------------------------

describe('what is owed', () => {
  it("shows the report's own date and control account, not this machine's clock", async () => {
    mount()
    const panel = await findPanel('What customers owe you')
    expect(within(panel).getByText(/As at 2019-07-31/)).toHaveTextContent(
      'As at 2019-07-31 · 1300 · Accounts Receivable',
    )
  })

  it('puts each column of figures under its own heading', async () => {
    mount()
    const panel = await findPanel('What customers owe you')

    expect(figureFor(panel, 'Not yet due')).toBe('2,00,000.00')
    expect(figureFor(panel, '1-30 days')).toBe('1,180.00')
    expect(figureFor(panel, 'Over 30 days')).toBe('12,34,567.00')
  })

  it('heads the credit column "Less on account" and prints the figure as main sent it', async () => {
    /* The renderer may not flip a sign (CONVENTIONS §1.7). Main sends what stands to the
     * party's credit as a POSITIVE quantity, and `total` is already net of it — so the
     * heading carries the subtraction and the figure keeps the sign it arrived with. */
    mount()
    const panel = await findPanel('What customers owe you')
    expect(figureFor(panel, 'Less on account')).toBe('5,000.00')
  })

  it("foots with the report's own total under the side's name for it", async () => {
    mount()
    const panel = await findPanel('What customers owe you')
    expect(figureFor(panel, 'Owed to the business')).toBe('14,30,747.00')
  })

  it('does not draw the payables report in the receivables panel', async () => {
    mount()
    const owed = await findPanel('What you owe suppliers')

    expect(within(owed).getByText(/2100 · Accounts Payable/)).toBeVisible()
    expect(figureFor(owed, 'Owed by the business')).toBe('6,000.00')
    expect(figureFor(owed, 'Not yet due')).toBe('1,000.00')
  })

  it('takes the grouping from the regime rather than assuming India', async () => {
    /* Hard-coding the lakh/crore grouping was a bug removed in 2.2e-2. The same figure,
     * under a regime that groups in threes, must read differently. */
    mount({
      regime: {
        ...DEFAULT_REGIME,
        numberFormat: { ...DEFAULT_REGIME.numberFormat, groupSizes: [3] },
      },
    })
    const panel = await findPanel('What customers owe you')

    expect(figureFor(panel, 'Owed to the business')).toBe('1,430,747.00')
  })

  it('says so when the report does not agree with its account, and still draws the figures', async () => {
    mount({ books: { sales: () => ok({ ...RECEIVABLES, ties: false }) } })
    const panel = await findPanel('What customers owe you')

    expect(within(panel).getByRole('alert')).toHaveTextContent('does not agree with the account')
    expect(figureFor(panel, 'Owed to the business')).toBe('14,30,747.00')
  })

  it('offers a way through to the full report', async () => {
    const user = userEvent.setup()
    const { navigate } = mount()
    const panel = await findPanel('What customers owe you')

    await user.click(within(panel).getByRole('button', { name: 'Open the aged receivables' }))
    expect(navigate).toHaveBeenCalledWith({
      area: 'workspace',
      screenId: 'aged-sales',
      params: {},
    })
  })

  it('says nothing is outstanding rather than drawing an empty table', async () => {
    mount({
      books: {
        sales: () =>
          ok({
            ...RECEIVABLES,
            parties: [],
            totals: {
              buckets: ['0.00', '0.00', '0.00'],
              onAccount: '0.00',
              overdue: '0.00',
              total: '0.00',
            },
            controlBalance: '0.00',
          }),
      },
    })
    const panel = await findPanel('What customers owe you')

    expect(within(panel).getByText('Nothing outstanding')).toBeVisible()
  })
})

// ---- What needs attention ---------------------------------------------------

describe('what is overdue', () => {
  it('lists the latest first, across both sides of the trade', async () => {
    mount()
    const panel = await findPanel('Overdue')

    /* The fixture order is INV/0001 (12 days), INV/0002 (90) from the sales report and
     * then BILL/0007 (45) from the purchase one. A screen that concatenated the two would
     * show them in that order. */
    expect(numbersIn(panel)).toEqual(['INV/2019-20/0002', 'BILL/2019-20/0007', 'INV/2019-20/0001'])
  })

  it("never marks money standing to a party's credit as overdue", async () => {
    /* CN/2019-20/0001 is three hundred days old and owed by nobody. */
    mount()
    const panel = await findPanel('Overdue')
    expect(numbersIn(panel)).not.toContain('CN/2019-20/0001')
  })

  it('says how late each one is, in its own cell', async () => {
    mount()
    const panel = await findPanel('Overdue')
    const rows = bodyRows(panel)

    expect(cellAt(rows[0], 1)).toBe('Halide Metals')
    expect(cellAt(rows[0], 2)).toBe('90 days overdue')
    expect(cellAt(rows[0], 3)).toBe('9,000.00')
  })

  it('opens the document behind a row in its own editor', async () => {
    const user = userEvent.setup()
    const { navigate } = mount()
    const panel = await findPanel('Overdue')

    await user.click(within(panel).getByRole('button', { name: 'BILL/2019-20/0007' }))
    expect(navigate).toHaveBeenCalledWith({
      area: 'workspace',
      screenId: 'purchase-bill',
      params: { id: 'document-4' },
    })
  })

  it('says nothing is overdue only when both reports answered', async () => {
    mount({
      books: {
        sales: () => ok({ ...RECEIVABLES, parties: [] }),
        purchase: () => ok({ ...PAYABLES, parties: [] }),
      },
    })
    const panel = await findPanel('Overdue')

    expect(within(panel).getByText('Nothing is overdue')).toBeVisible()
  })

  it('refuses to say it when one of the two reports failed', async () => {
    /* A green tick over a query that never ran is the worst answer available here. */
    mount({
      books: {
        sales: () => fails('ROLE_UNMAPPED', 'No account is mapped to receivable.'),
        purchase: () => ok({ ...PAYABLES, parties: [] }),
      },
    })
    const panel = await findPanel('Overdue')

    expect(within(panel).queryByText('Nothing is overdue')).toBeNull()
    expect(within(panel).getByText(/nothing can be said about what is overdue/)).toBeVisible()
  })

  it('shows the half it has, and says it is a half, when one report failed', async () => {
    mount({
      books: { sales: () => fails('ROLE_UNMAPPED', 'No account is mapped to receivable.') },
    })
    const panel = await findPanel('Overdue')

    expect(numbersIn(panel)).toEqual(['BILL/2019-20/0007'])
    expect(
      within(panel).getByText(/could not be read, so this is what the other holds/),
    ).toBeVisible()
  })
})

describe('the drafts', () => {
  it('names a draft where the number goes rather than leaving the cell blank', async () => {
    mount()
    const panel = await findPanel('Drafts not yet issued')
    const rows = bodyRows(panel)

    expect(rows).toHaveLength(2)
    expect(cellAt(rows[0], 0)).toBe('Draft')
    expect(cellAt(rows[0], 1)).toBe('Sales invoice')
    expect(cellAt(rows[0], 2)).toBe('2019-06-02')
    expect(cellAt(rows[0], 5)).toBe('2,360.00')
  })

  it('opens a draft in the editor for its own kind', async () => {
    const user = userEvent.setup()
    const { navigate } = mount()
    const panel = await findPanel('Drafts not yet issued')

    await user.click(within(panel).getAllByRole('button', { name: 'Draft' })[1] as HTMLElement)
    expect(navigate).toHaveBeenCalledWith({
      area: 'workspace',
      screenId: 'purchase-bill',
      params: { id: 'draft-2' },
    })
  })

  it('says there are more when the extra row came back', async () => {
    /* The screen asks for one row more than it draws. The extra row IS the answer. */
    const six = [1, 2, 3, 4, 5, 6].map((n) =>
      document({ id: `draft-${String(n)}`, status: 'draft', number: null }),
    )
    mount({ books: { drafts: () => ok(six) } })
    const panel = await findPanel('Drafts not yet issued')

    expect(bodyRows(panel)).toHaveLength(5)
    expect(within(panel).getByText(/The 5 most recent are shown/)).toBeVisible()
  })

  it('does not claim there are more when exactly a full page came back', async () => {
    const five = [1, 2, 3, 4, 5].map((n) =>
      document({ id: `draft-${String(n)}`, status: 'draft', number: null }),
    )
    mount({ books: { drafts: () => ok(five) } })
    const panel = await findPanel('Drafts not yet issued')

    expect(bodyRows(panel)).toHaveLength(5)
    expect(within(panel).queryByText(/The 5 most recent are shown/)).toBeNull()
  })

  it('says the list worth being empty is empty', async () => {
    mount({ books: { drafts: () => ok([]) } })
    const panel = await findPanel('Drafts not yet issued')

    expect(within(panel).getByText('No drafts are waiting')).toBeVisible()
  })
})

// ---- What has happened lately -----------------------------------------------

describe('what happened lately', () => {
  it('interleaves documents and vouchers, newest first', async () => {
    mount()
    const panel = await findPanel('Lately')

    /* The newest is a RECEIPT, and it is the last row of the receipts fixture. Neither
     * list's own first row is the answer. */
    expect(numbersIn(panel)).toEqual([
      'RC/2019-20/0002',
      'INV/2019-20/0002',
      'CN/2019-20/0001',
      'INV/2019-20/0001',
      'PY/2019-20/0001',
    ])
  })

  it('names each row for what it is and marks its status', async () => {
    mount()
    const panel = await findPanel('Lately')
    const rows = bodyRows(panel)

    expect(cellAt(rows[2], 1)).toBe('Credit note')
    expect(cellAt(rows[2], 3)).toBe('Halide Metals')
    expect(cellAt(rows[2], 4)).toBe('Cancelled')
    expect(cellAt(rows[2], 5)).toBe('5,000.00')
  })

  it("takes a voucher's status from the receipt vocabulary, not the document one", async () => {
    mount()
    const panel = await findPanel('Lately')
    expect(cellAt(bodyRows(panel)[0], 4)).toBe('Posted')
  })

  it('opens a voucher in the editor for its own kind', async () => {
    const user = userEvent.setup()
    const { navigate } = mount()
    const panel = await findPanel('Lately')

    await user.click(within(panel).getByRole('button', { name: 'PY/2019-20/0001' }))
    expect(navigate).toHaveBeenCalledWith({
      area: 'workspace',
      screenId: 'payment',
      params: { id: 'receipt-2' },
    })
  })

  it('offers the day book as the way to see the rest', async () => {
    const user = userEvent.setup()
    const { navigate } = mount()
    const panel = await findPanel('Lately')

    await user.click(within(panel).getByRole('button', { name: 'Open the day book' }))
    expect(navigate).toHaveBeenCalledWith({
      area: 'workspace',
      screenId: 'day-book',
      params: {},
    })
  })
})

// ---- One panel failing ------------------------------------------------------

describe('a panel that fails', () => {
  it('says what went wrong in its own box and leaves the rest of the screen standing', async () => {
    mount({
      books: {
        sales: () => fails('ROLE_UNMAPPED', 'No account is mapped to receivable.'),
        purchase: () => fails('ROLE_UNMAPPED', 'No account is mapped to payable.'),
      },
    })

    const owed = await findPanel('What customers owe you')
    expect(within(owed).getByRole('alert')).toHaveTextContent('No account is mapped to receivable')

    /* Everything that did not depend on that read is exactly where it was. */
    const drafts = await findPanel('Drafts not yet issued')
    expect(bodyRows(drafts)).toHaveLength(2)

    const lately = await findPanel('Lately')
    expect(numbersIn(lately)[0]).toBe('RC/2019-20/0002')

    const company = await findPanel('This company')
    expect(within(company).getByText('/books/acme.coffer')).toBeVisible()
    expect(within(company).getAllByRole('button', { name: 'Back up now' })).toHaveLength(1)
  })

  it('lists the documents it has when the receipts could not be read', async () => {
    mount({ books: { receipts: () => fails('IPC_FAILED', 'That action could not be completed.') } })
    const panel = await findPanel('Lately')

    expect(within(panel).getByRole('alert')).toBeVisible()
    expect(numbersIn(panel)).toEqual(['INV/2019-20/0002', 'CN/2019-20/0001', 'INV/2019-20/0001'])
  })

  it('shows the failure from the drafts read instead of an empty list', async () => {
    mount({ books: { drafts: () => fails('IPC_FAILED', 'That action could not be completed.') } })
    const panel = await findPanel('Drafts not yet issued')

    expect(within(panel).getByRole('alert')).toBeVisible()
    expect(within(panel).queryByText('No drafts are waiting')).toBeNull()
  })
})

// ---- Before anything has answered -------------------------------------------

describe('while the reads are in flight', () => {
  it('says it is reading, and fills in when the answer lands', async () => {
    /* Awaiting the promise is not the same as waiting for the screen to change, so the
     * release is wrapped in `act` and React is given the chance to re-render. */
    let release: (value: Result<AgedReport>) => void = () => {}
    const pending = new Promise<Result<AgedReport>>((resolve) => {
      release = resolve
    })

    mount({ books: { sales: () => pending, purchase: () => pending } })

    const panel = await findPanel('What customers owe you')
    expect(within(panel).getByText('Reading the account…')).toBeVisible()

    await act(async () => {
      release({ ok: true, data: RECEIVABLES })
      await pending
    })

    expect(figureFor(panel, 'Owed to the business')).toBe('14,30,747.00')
  })
})

// ---- A company with nothing in it -------------------------------------------

describe('a company with nothing in it yet', () => {
  const empty: Books = { documents: () => ok([]), receipts: () => ok([]), drafts: () => ok([]) }

  it('points at what to do first instead of showing a screen of noughts', async () => {
    mount({ books: empty })
    const panel = await findPanel('Start here')

    expect(within(panel).getByText('Nothing has been raised in these books yet')).toBeVisible()
    expect(screen.queryByRole('region', { name: 'What customers owe you' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Lately' })).toBeNull()
  })

  it('reads the profile and the parties only once the books turn out to be empty', async () => {
    const { bridge } = mount({ books: empty })
    await findPanel('Start here')

    await waitFor(() => expect(bridge.callsTo('parties:list')).toHaveLength(1))
    expect(bridge.callsTo('companyProfile:get')).toHaveLength(1)
  })

  it('marks a step already done rather than asking for it twice', async () => {
    mount({ books: { ...empty, profile: () => ok(PROFILE) } })
    const panel = await findPanel('Start here')

    expect(await stepBadges(panel)).toEqual(['Done', 'To do', 'To do'])
  })

  it('counts a party that exists, whichever side of the trade it is on', async () => {
    const vendor: PartySummary = {
      id: 'party-3',
      name: 'Tamil Coir',
      registrationNumber: null,
      jurisdictionCode: '33',
      countryCode: 'in',
      isCustomer: false,
      isVendor: true,
      city: 'Pollachi',
      isArchived: false,
    }
    mount({ books: { ...empty, parties: () => ok([vendor]) } })
    const panel = await findPanel('Start here')

    expect(await stepBadges(panel)).toEqual(['To do', 'Done', 'To do'])
  })

  it('says it does not know rather than guessing when a step’s read failed', async () => {
    mount({
      books: {
        ...empty,
        profile: () => fails('IPC_FAILED', 'That action could not be completed.'),
      },
    })
    const panel = await findPanel('Start here')

    /* The parties read answered, so the profile's `Not checked` is the failure and not a
     * frame taken before anything came back. */
    expect(await stepBadges(panel)).toEqual(['Not checked', 'To do', 'To do'])
  })

  it('sends the first step to the business details', async () => {
    const user = userEvent.setup()
    const { navigate } = mount({ books: empty })
    const panel = await findPanel('Start here')

    await user.click(within(panel).getByRole('button', { name: 'Business details' }))
    expect(navigate).toHaveBeenCalledWith({
      area: 'workspace',
      screenId: 'company-profile',
      params: {},
    })
  })

  it('still offers the backup, because an empty company is still encrypted', async () => {
    mount({ books: empty })
    const company = await findPanel('This company')

    expect(within(company).getAllByRole('button', { name: 'Back up now' })).toHaveLength(1)
  })
})

// ---- The company's own state ------------------------------------------------

describe('which company is open', () => {
  it('names the file and the vault beside it', async () => {
    mount()
    const panel = await findPanel('This company')

    expect(within(panel).getByText('/books/acme.coffer')).toBeVisible()
    expect(within(panel).getByText('/books/acme.coffer.vault')).toBeVisible()
  })

  it('shows the company name as the heading of the screen', async () => {
    mount()
    expect(await screen.findByRole('heading', { name: 'Acme Pvt Ltd' })).toBeVisible()
  })

  it('warns when the last recovery code has been spent', async () => {
    mount({ codes: 0 })
    expect(await screen.findByText('No recovery codes remain')).toBeVisible()

    const panel = await findPanel('This company')
    expect(within(panel).getByText('None left')).toBeVisible()
  })

  it('marks two remaining as running low without the full warning', async () => {
    mount({ codes: 2 })
    const panel = await findPanel('This company')

    expect(within(panel).getByText('Running low')).toBeVisible()
    expect(screen.queryByText('No recovery codes remain')).toBeNull()
  })

  it('marks a healthy count neither way', async () => {
    mount()
    const panel = await findPanel('This company')

    expect(within(panel).getByText('5 unused')).toBeVisible()
    expect(within(panel).queryByText('Running low')).toBeNull()
  })
})

// ---- Backing up -------------------------------------------------------------

describe('backing up', () => {
  const backupBridge = (over: BridgeStub = {}): BridgeStub => ({
    ...bridgeFor(),
    system: {
      chooseDirectory: () => ok('/backups'),
      revealInFileManager: () => ok(undefined),
    },
    companies: {
      close: () => ok(undefined),
      backup: () =>
        ok({
          archivePath: '/backups/acme-2019.coffer-backup',
          sizeBytes: 2_500_000,
          createdAt: '2019-08-20T11:00:00.000Z',
        }),
    },
    ...over,
  })

  it('is offered twice — in the header and beside the sentence that says why', async () => {
    mount({ bridge: backupBridge() })
    await findPanel('This company')

    expect(screen.getAllByRole('button', { name: 'Back up now' })).toHaveLength(2)
  })

  it('asks where to put it and writes one archive holding both halves', async () => {
    const user = userEvent.setup()
    const { bridge } = mount({ bridge: backupBridge() })
    await findPanel('This company')

    await user.click(screen.getAllByRole('button', { name: 'Back up now' })[0] as HTMLElement)

    await waitFor(() => expect(bridge.callsTo('companies:backup')).toHaveLength(1))
    expect(bridge.lastCallTo('companies:backup')?.args[0]).toEqual({ directoryPath: '/backups' })
  })

  it('says where the archive went and how big it is', async () => {
    const user = userEvent.setup()
    mount({ bridge: backupBridge() })
    await findPanel('This company')

    await user.click(screen.getAllByRole('button', { name: 'Back up now' })[1] as HTMLElement)

    expect(await screen.findByText('Backup written')).toBeVisible()
    expect(screen.getByText(/\/backups\/acme-2019\.coffer-backup · 2\.4 MB/)).toBeVisible()
  })

  it('writes nothing when the folder picker is cancelled', async () => {
    const user = userEvent.setup()
    const { bridge } = mount({
      bridge: backupBridge({
        system: { chooseDirectory: () => ok(null), revealInFileManager: () => ok(undefined) },
      }),
    })
    await findPanel('This company')

    await user.click(screen.getAllByRole('button', { name: 'Back up now' })[0] as HTMLElement)

    await waitFor(() => expect(bridge.callsTo('system:chooseDirectory')).toHaveLength(1))
    expect(bridge.callsTo('companies:backup')).toHaveLength(0)
    expect(screen.queryByText('Backup written')).toBeNull()
  })

  it('says what went wrong when the archive could not be written', async () => {
    const user = userEvent.setup()
    mount({
      bridge: backupBridge({
        companies: {
          close: () => ok(undefined),
          backup: () => fails('BACKUP_FAILED', 'The folder is not writable.'),
        },
      }),
    })
    await findPanel('This company')

    await user.click(screen.getAllByRole('button', { name: 'Back up now' })[0] as HTMLElement)

    expect(await screen.findByText('The folder is not writable.')).toBeVisible()
    expect(screen.queryByText('Backup written')).toBeNull()
  })
})

// ---- Changing the passphrase ------------------------------------------------

describe('changing the passphrase', () => {
  const passphraseBridge: BridgeStub = {
    ...bridgeFor(),
    companies: {
      close: () => ok(undefined),
      checkPassphrase: () => ok({ score: 3, label: 'Strong', suggestion: null, isWeak: false }),
      changePassphrase: () => ok(undefined),
    },
  }

  async function openDialog(): Promise<HTMLElement> {
    const user = userEvent.setup()
    await findPanel('This company')
    /* The dialog's own submit button carries the same words, and a closed <dialog> is
     * not reliably hidden from the accessibility tree here. The header's is first in the
     * document, so it is taken by position rather than by a name that is not unique. */
    await user.click(screen.getAllByRole('button', { name: 'Change passphrase' })[0] as HTMLElement)
    return await screen.findByRole('dialog', { name: 'Change the passphrase' })
  }

  it('sends both passphrases and nothing else', async () => {
    const user = userEvent.setup()
    const { bridge } = mount({ bridge: passphraseBridge })
    const dialog = await openDialog()

    await user.type(screen.getByLabelText('Current passphrase'), 'the old one')
    await user.type(screen.getByLabelText('New passphrase'), 'a longer newer one')
    await user.type(screen.getByLabelText('New passphrase again'), 'a longer newer one')
    await user.click(within(dialog).getByRole('button', { name: 'Change passphrase' }))

    await waitFor(() => expect(bridge.callsTo('companies:changePassphrase')).toHaveLength(1))
    expect(bridge.lastCallTo('companies:changePassphrase')?.args[0]).toEqual({
      currentPassphrase: 'the old one',
      newPassphrase: 'a longer newer one',
    })
  })

  it('says afterwards that the recovery codes still work', async () => {
    const user = userEvent.setup()
    mount({ bridge: passphraseBridge })
    const dialog = await openDialog()

    await user.type(screen.getByLabelText('Current passphrase'), 'the old one')
    await user.type(screen.getByLabelText('New passphrase'), 'a longer newer one')
    await user.type(screen.getByLabelText('New passphrase again'), 'a longer newer one')
    await user.click(within(dialog).getByRole('button', { name: 'Change passphrase' }))

    expect(await screen.findByText('Passphrase changed')).toBeVisible()
    expect(screen.getByText(/recovery codes are unaffected/)).toBeVisible()
  })

  it('refuses to submit until the confirmation matches', async () => {
    const user = userEvent.setup()
    const { bridge } = mount({ bridge: passphraseBridge })
    const dialog = await openDialog()

    await user.type(screen.getByLabelText('Current passphrase'), 'the old one')
    await user.type(screen.getByLabelText('New passphrase'), 'a longer newer one')
    await user.type(screen.getByLabelText('New passphrase again'), 'a different thing')
    await user.click(within(dialog).getByRole('button', { name: 'Change passphrase' }))

    expect(within(dialog).getByText('These two do not match.')).toBeVisible()
    expect(bridge.callsTo('companies:changePassphrase')).toHaveLength(0)
  })

  it('keeps the dialog open and says why when main refuses', async () => {
    const user = userEvent.setup()
    mount({
      bridge: {
        ...passphraseBridge,
        companies: {
          close: () => ok(undefined),
          checkPassphrase: () => ok({ score: 3, label: 'Strong', suggestion: null, isWeak: false }),
          changePassphrase: () => fails('PASSPHRASE_INVALID', 'That passphrase did not work.'),
        },
      },
    })
    const dialog = await openDialog()

    await user.type(screen.getByLabelText('Current passphrase'), 'the wrong one')
    await user.type(screen.getByLabelText('New passphrase'), 'a longer newer one')
    await user.type(screen.getByLabelText('New passphrase again'), 'a longer newer one')
    await user.click(within(dialog).getByRole('button', { name: 'Change passphrase' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'That is not the current passphrase for this company.',
    )
    expect(screen.queryByText('Passphrase changed')).toBeNull()
  })
})

// ---- Closing ----------------------------------------------------------------

describe('closing the company', () => {
  it('asks main to close and leaves the dashboard behind', async () => {
    const user = userEvent.setup()
    const { bridge } = mount()
    await findPanel('This company')

    await user.click(screen.getByRole('button', { name: 'Close company' }))

    await waitFor(() => expect(bridge.callsTo('companies:close')).toHaveLength(1))
    expect(await screen.findByRole('heading', { name: 'No company is open' })).toBeVisible()
  })

  it('says what went wrong when main could not close it', async () => {
    const user = userEvent.setup()
    mount({
      bridge: {
        ...bridgeFor(),
        companies: { close: () => fails('IPC_FAILED', 'That action could not be completed.') },
      },
    })
    await findPanel('This company')

    await user.click(screen.getByRole('button', { name: 'Close company' }))
    expect(await screen.findByText('That action could not be completed.')).toBeVisible()
  })
})
