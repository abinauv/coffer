/*
 * The Overview, rendered.
 *
 * What the wording, the ordering and the counting decide is covered as pure functions next
 * door in `overview-view.test.ts`. What is covered only here is what the screen ASKS main
 * for, where each answer lands, and what it keeps doing when one of them fails.
 *
 * FIXTURE DATES ARE ALL IN 2019, which the real clock cannot be in. The reports come back
 * stamped 2019 while the REQUEST has to carry today, so a screen that sent the report's
 * date back to main, or printed the report's date as today's, fails here.
 *
 * FIXTURES ARE ORDERED TO DISAGREE WITH THE ANSWER. The party owed longest is the second in
 * the report, and the worst overdue item is not the first item of the first report.
 */

import type { JSX } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  AccountingPeriod,
  AgedItem,
  AgedPartyRow,
  AgedReport,
  CompanyProfile,
  CompanySummary,
  DocumentListRow,
  OverviewFigures,
  PartySummary,
  RegimeDescription,
  Result,
} from '@shared/dto'
import { useCommands } from '@renderer/store/commands'
import { formatDate } from '../lib/dates'
import {
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
  lastBackup: null,
  remindsAboutBackups: false,
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
        /* A credit note three hundred days old: owed by nobody, and never the oldest charge. */
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
  ...RECEIVABLES,
  side: 'purchase',
  accountId: 'account-payable',
  accountCode: '2100',
  accountName: 'Accounts Payable',
  parties: [
    party({
      partyId: 'party-3',
      partyName: 'Tamil Coir',
      total: '4500.00',
      items: [
        item({
          sourceId: 'document-4',
          kind: 'purchase-bill',
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
}

const FIGURES: OverviewFigures = {
  asAtDate: '2019-07-31',
  cashAndBank: {
    total: '276905.00',
    accounts: [
      { accountId: 'a', code: '1100', name: 'Cash in Hand', balance: '4905.00' },
      { accountId: 'b', code: '1210', name: 'HDFC Current', balance: '200000.00' },
      { accountId: 'c', code: '1220', name: 'SBI', balance: '72000.00' },
    ],
  },
  monthToDate: { fromDate: '2019-07-01', toDate: '2019-07-31', netProfit: '-48220.00' },
}

const NEWEST_DRAFT: DocumentListRow = {
  id: 'draft-1',
  kind: 'sales-invoice',
  status: 'draft',
  number: null,
  date: '2019-06-02',
  dueDate: null,
  partyId: 'party-1',
  partyName: 'Sunrise Components',
  grandTotal: '2360.00',
  settlement: null,
}

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

const PERIODS: AccountingPeriod[] = [
  {
    id: 'p1',
    fiscalYearLabel: '2019-20',
    index: 1,
    label: 'Apr 2019',
    startDate: '2019-04-01',
    endDate: '2020-03-31',
    status: 'open',
    closedAt: null,
  },
]

// ---- The bridge -------------------------------------------------------------

interface Books {
  sales?: () => Promise<Result<AgedReport>>
  purchase?: () => Promise<Result<AgedReport>>
  figures?: () => Promise<Result<OverviewFigures>>
  documentCount?: () => Promise<Result<number>>
  receiptCount?: () => Promise<Result<number>>
  draftCount?: () => Promise<Result<number>>
  newestDraft?: () => Promise<Result<DocumentListRow[]>>
  profile?: () => Promise<Result<CompanyProfile | null>>
  parties?: () => Promise<Result<PartySummary[]>>
}

/*
 * ONE `documents:count` CHANNEL, TWO QUESTIONS. The stub answers on the INPUT rather than
 * on call order, so a screen that dropped the draft filter would be handed every document
 * as a draft and fail here rather than quietly miscounting.
 */
function bridgeFor(books: Books = {}): BridgeStub {
  return {
    reports: {
      aged: (input) =>
        input.side === 'sales'
          ? (books.sales ?? (() => ok(RECEIVABLES)))()
          : (books.purchase ?? (() => ok(PAYABLES)))(),
      overviewFigures: () => (books.figures ?? (() => ok(FIGURES)))(),
      taxReturnsDue: () => ok([]),
    },
    documents: {
      count: (input) =>
        input?.status === 'draft'
          ? (books.draftCount ?? (() => ok(2)))()
          : (books.documentCount ?? (() => ok(40)))(),
      list: () => (books.newestDraft ?? (() => ok([NEWEST_DRAFT])))(),
    },
    receipts: { count: () => (books.receiptCount ?? (() => ok(12)))() },
    companyProfile: { get: () => (books.profile ?? (() => ok(null)))() },
    parties: { list: () => (books.parties ?? (() => ok([])))() },
    ledger: { listPeriods: () => ok(PERIODS) },
  }
}

/** Runs a command by id, as the palette would, so a test can reach one with no button. */
function RunCommand({ id }: { id: string }): JSX.Element {
  const { run } = useCommands()
  return (
    <button type="button" onClick={() => run(id)}>
      run {id}
    </button>
  )
}

interface MountOptions {
  books?: Books
  codes?: number
  isOpen?: boolean
  regime?: RegimeDescription
}

function mount(
  options: MountOptions = {},
): RenderedScreen & { navigate: ReturnType<typeof vi.fn> } {
  const navigate = vi.fn()
  const rendered = renderScreen(
    <>
      <Overview {...screenContext({ navigate })} />
      <RunCommand id="company.refresh-overview" />
    </>,
    {
      bridge: bridgeFor(options.books),
      company: options.isOpen === false ? null : ACME,
      recoveryCodesRemaining: options.codes ?? 5,
      ...(options.regime === undefined ? {} : { regime: options.regime }),
    },
  )
  return Object.assign(rendered, { navigate })
}

const findPanel = (name: string): Promise<HTMLElement> => screen.findByRole('region', { name })

/** Today, built here rather than imported: a hardcoded date proves nothing about a clock. */
function today(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** The figure card under a label: its value and its note, once the value has arrived. */
async function figure(label: string): Promise<{ value: HTMLElement; note: string }> {
  const term = await screen.findByText(label, { selector: 'dt' })
  const card = term.parentElement as HTMLElement
  await waitFor(() => expect(card.querySelector('[aria-busy]')).toBeNull())
  const [value, note] = [...card.querySelectorAll('dd')]
  return { value: value as HTMLElement, note: note?.textContent ?? '<no note>' }
}

// ---- What it asks main for --------------------------------------------------

describe('the reads', () => {
  it('asks for both ageing reports and the figures as at today, and for the same day', async () => {
    const { bridge } = mount()
    await findPanel('Needs your attention')

    await waitFor(() => expect(bridge.callsTo('reports:aged')).toHaveLength(2))
    expect(bridge.callsTo('reports:aged').map((call) => call.args[0])).toEqual([
      { side: 'sales', asAtDate: today() },
      { side: 'purchase', asAtDate: today() },
    ])
    expect(bridge.lastCallTo('reports:overviewFigures')?.args[0]).toEqual({ asAtDate: today() })
  })

  it('counts the books rather than listing them, and asks for one draft', async () => {
    const { bridge } = mount()
    await findPanel('Needs your attention')

    await waitFor(() => expect(bridge.callsTo('documents:count')).toHaveLength(2))
    expect(bridge.callsTo('documents:count').map((call) => call.args[0])).toEqual([
      undefined,
      { status: 'draft' },
    ])
    expect(bridge.callsTo('receipts:count')).toHaveLength(1)
    expect(bridge.lastCallTo('documents:list')?.args[0]).toEqual({ status: 'draft', limit: 1 })
  })

  it('does not pull the party master on a company that already has books', async () => {
    const { bridge } = mount()
    await findPanel('Needs your attention')

    expect(bridge.callsTo('parties:list')).toHaveLength(0)
    expect(bridge.callsTo('companyProfile:get')).toHaveLength(0)
  })

  it('reads nothing at all until a company is open', async () => {
    const { bridge } = mount({ isOpen: false })
    expect(await screen.findByRole('heading', { name: 'No company is open' })).toBeVisible()

    expect(bridge.callsTo('reports:aged')).toHaveLength(0)
    expect(bridge.callsTo('documents:count')).toHaveLength(0)
  })

  it('asks again when the palette refreshes it', async () => {
    const user = userEvent.setup()
    const { bridge } = mount()
    await findPanel('Needs your attention')
    await waitFor(() => expect(bridge.callsTo('reports:aged')).toHaveLength(2))

    await user.click(screen.getByRole('button', { name: 'run company.refresh-overview' }))
    await waitFor(() => expect(bridge.callsTo('reports:aged')).toHaveLength(4))
  })
})

// ---- The head of the page -------------------------------------------------------

describe('the heading', () => {
  it('says what day it is as at, and the financial year the books name', async () => {
    mount()

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeVisible()
    expect(
      await screen.findByText(`As at ${formatDate(today())} · financial year 2019-20`),
    ).toBeVisible()
  })

  it('records a receipt and raises a sales invoice from the two buttons at the top', async () => {
    const user = userEvent.setup()
    const { navigate } = mount()
    await findPanel('Needs your attention')

    await user.click(screen.getByRole('button', { name: 'Record receipt' }))
    expect(navigate).toHaveBeenLastCalledWith({
      area: 'workspace',
      screenId: 'receipt',
      params: {},
    })

    await user.click(screen.getByRole('button', { name: 'New sales invoice' }))
    expect(navigate).toHaveBeenLastCalledWith({
      area: 'workspace',
      screenId: 'sales-invoice',
      params: {},
    })
  })
})

// ---- The four figures ---------------------------------------------------------

describe('the figures', () => {
  it('prints what customers owe and what is owed to suppliers as the reports total them', async () => {
    mount()

    const owed = await figure('Owed to you')
    expect(owed.value).toHaveTextContent('14,30,747.00')
    expect(owed.note).toBe('2 unpaid · 2 overdue')

    const owe = await figure('You owe')
    expect(owe.value).toHaveTextContent('6,000.00')
    expect(owe.note).toBe('1 unpaid · 1 overdue')
  })

  it('prints cash and bank, and how many accounts it counted', async () => {
    mount()

    const cash = await figure('Cash and bank')
    expect(cash.value).toHaveTextContent('2,76,905.00')
    expect(cash.note).toBe('across 3 accounts')
  })

  /* The sign is in the figure and the ink is the second signal (design.md §6). */
  it('keeps the sign on a month that lost money, and marks it negative', async () => {
    mount()

    const month = await figure('This month, net')
    expect(month.value).toHaveTextContent('-48,220.00')
    expect(month.value).toHaveAttribute('data-tone', 'negative')
    expect(month.note).toBe('1–31 Jul · income less expenses')
  })

  it('takes the grouping from the regime rather than assuming India', async () => {
    mount({
      regime: {
        id: 'pt',
        label: 'Portugal — IVA',
        registrationLabel: 'NIF',
        numberFormat: {
          groupSizes: [3],
          decimalSeparator: ',',
          groupSeparator: '.',
          currencyCode: 'EUR',
          currencySymbol: '€',
        },
        jurisdictions: [],
        taxRates: [],
        taxComponents: [],
        classification: { code: null, label: 'CPA', validLengths: [] },
        returnForms: [],
      },
    })

    expect((await figure('Owed to you')).value).toHaveTextContent('1.430.747,00')
  })

  it('says a figure could not be read, and leaves the others standing', async () => {
    mount({ books: { figures: () => fails('ROLE_UNMAPPED', 'No account fills the bank role.') } })

    const cash = await figure('Cash and bank')
    expect(cash.note).toBe('Could not be read')
    expect(await screen.findByText(/No account fills the bank role/)).toBeVisible()
    expect((await figure('Owed to you')).value).toHaveTextContent('14,30,747.00')
  })

  it('does not add anything up itself', async () => {
    mount()
    await figure('You owe')
    /* Receivables less payables would be 14,24,747.00. Nothing on the page may say it. */
    expect(screen.queryByText(/14,24,747/)).toBeNull()
  })
})

// ---- Owed to you, oldest first ------------------------------------------------

describe('owed to you, oldest first', () => {
  it('lists the party owed longest first, with their own total', async () => {
    mount()
    const panel = await findPanel('Owed to you, oldest first')

    const rows = await within(panel).findAllByRole('row')
    const body = rows.filter((row) => within(row).queryAllByRole('cell').length > 0)
    expect(body.map((row) => within(row).getAllByRole('cell')[0]?.textContent)).toEqual([
      'Halide Metals',
      'Sunrise Components',
    ])
    expect(body[0]).toHaveTextContent('90 days overdue')
    expect(body[0]).toHaveTextContent('4,000.00')
  })

  it('opens the aged receivables', async () => {
    const user = userEvent.setup()
    const { navigate } = mount()
    const panel = await findPanel('Owed to you, oldest first')

    await user.click(within(panel).getByRole('button', { name: 'Aged receivables' }))
    expect(navigate).toHaveBeenCalledWith({ area: 'workspace', screenId: 'aged-sales', params: {} })
  })

  it('says nobody owes anything rather than drawing an empty table', async () => {
    mount({ books: { sales: () => ok({ ...RECEIVABLES, parties: [] }) } })
    const panel = await findPanel('Owed to you, oldest first')

    expect(await within(panel).findByText('Nobody owes you anything today.')).toBeVisible()
  })
})

// ---- Needs your attention -------------------------------------------------------

describe('needs your attention', () => {
  it('lists what is late on both sides and the drafts, worst first', async () => {
    mount()
    const panel = await findPanel('Needs your attention')

    const items = await within(panel).findAllByRole('listitem')
    expect(items.map((entry) => entry.querySelector('.attention__title')?.textContent)).toEqual([
      '2 invoices are past the due date',
      '1 bill is past the due date',
      '2 drafts not yet issued',
    ])
    expect(within(panel).getByText('3 items')).toBeVisible()
    expect(within(panel).getByText('Oldest is 90 days · Halide Metals')).toBeVisible()
  })

  it('opens the newest draft in the editor for its own kind', async () => {
    const user = userEvent.setup()
    const { navigate } = mount()
    const panel = await findPanel('Needs your attention')

    await user.click(await within(panel).findByRole('button', { name: 'Open the newest' }))
    expect(navigate).toHaveBeenCalledWith({
      area: 'workspace',
      screenId: 'sales-invoice',
      params: { id: 'draft-1' },
    })
  })

  it('says when the recovery codes are gone', async () => {
    mount({ codes: 0 })
    const panel = await findPanel('Needs your attention')

    expect(await within(panel).findByText('No recovery codes remain')).toBeVisible()
  })

  it('says nothing needs attention only when every read answered', async () => {
    const quiet: Books = {
      sales: () => ok({ ...RECEIVABLES, parties: [] }),
      purchase: () => ok({ ...PAYABLES, parties: [] }),
      draftCount: () => ok(0),
      newestDraft: () => ok([]),
    }
    const { unmount } = mount({ books: quiet })
    expect(
      await within(await findPanel('Needs your attention')).findByText(
        /Nothing needs your attention/,
      ),
    ).toBeVisible()
    unmount()

    mount({ books: { ...quiet, purchase: () => fails('IPC_FAILED', 'That did not work.') } })
    const panel = await findPanel('Needs your attention')
    expect(await within(panel).findByText(/Part of the books could not be read/)).toBeVisible()
    expect(within(panel).queryByText(/Nothing needs your attention/)).toBeNull()
  })
})

// ---- A company with nothing in it -------------------------------------------

describe('a company with nothing in it yet', () => {
  const empty: Books = { documentCount: () => ok(0), receiptCount: () => ok(0) }

  /**
   * The badge on each step, once both of the checklist's reads have landed. `Not checked`
   * is also the answer before anything came back, so the wait is on the parties step.
   */
  async function stepBadges(panel: HTMLElement): Promise<string[]> {
    await waitFor(() => {
      const settled = [...panel.querySelectorAll('li')][1]?.textContent ?? ''
      expect(settled.includes('To do') || settled.includes('Done')).toBe(true)
    })
    return [...panel.querySelectorAll('li')].map(
      (step) => step.querySelector('.badge')?.textContent ?? '<no badge>',
    )
  }

  it('points at what to do first instead of showing four noughts', async () => {
    mount({ books: empty })
    const panel = await findPanel('Start here')

    expect(
      within(panel).getByText('The books are empty, which is the correct state on day one'),
    ).toBeVisible()
    expect(screen.queryByText('Owed to you', { selector: 'dt' })).toBeNull()
    /* On day one the invoice editor cannot issue anything, so the top buttons are not offered. */
    expect(screen.queryByRole('button', { name: 'New sales invoice' })).toBeNull()
  })

  it('reads the profile and the parties only once the books turn out to be empty', async () => {
    const { bridge } = mount({ books: empty })
    await findPanel('Start here')

    await waitFor(() => expect(bridge.callsTo('parties:list')).toHaveLength(1))
    expect(bridge.callsTo('companyProfile:get')).toHaveLength(1)
  })

  it('does not take a count that failed for an empty company', async () => {
    mount({ books: { ...empty, receiptCount: () => fails('IPC_FAILED', 'That did not work.') } })
    await findPanel('Needs your attention')

    expect(screen.queryByRole('region', { name: 'Start here' })).toBeNull()
  })

  it('marks a step already done rather than asking for it twice', async () => {
    mount({ books: { ...empty, profile: () => ok(PROFILE) } })
    const panel = await findPanel('Start here')

    expect(await stepBadges(panel)).toEqual(['Done', 'To do', 'To do'])
  })

  it('says it does not know rather than guessing when a step’s read failed', async () => {
    mount({
      books: {
        ...empty,
        profile: () => fails('IPC_FAILED', 'That action could not be completed.'),
      },
    })
    const panel = await findPanel('Start here')

    expect(await stepBadges(panel)).toEqual(['Not checked', 'To do', 'To do'])
  })

  it('sends the first step to the business details, and says where they live', async () => {
    const user = userEvent.setup()
    const { navigate } = mount({ books: empty })
    const panel = await findPanel('Start here')

    await user.click(within(panel).getByRole('button', { name: 'Company → Business details' }))
    expect(navigate).toHaveBeenCalledWith({
      area: 'workspace',
      screenId: 'company-profile',
      params: {},
    })
  })

  it('offers the next step not yet done as the main action', async () => {
    const user = userEvent.setup()
    const { navigate } = mount({ books: { ...empty, profile: () => ok(PROFILE) } })
    const panel = await findPanel('Start here')

    await user.click(await within(panel).findByRole('button', { name: 'Add your first customer' }))
    expect(navigate).toHaveBeenCalledWith({ area: 'workspace', screenId: 'customers', params: {} })
  })
})
