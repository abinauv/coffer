/*
 * The document registers, rendered.
 *
 * ONE COMPONENT, FIVE REGISTRATIONS (0013-2). Most of what follows renders it as the
 * sales-invoice register, because that is the screen the paging and filtering rules were
 * written against and they are not per-kind. What IS per-kind gets its own section at the
 * bottom: the query it sends, the words it uses, and the editor it opens.
 *
 * `statusTone` and `formatAmount` are covered as pure functions next door. What is
 * covered only here is what the screen asks main for and what it does with the answer:
 * that the filters reach the query rather than being applied to a page after it arrives,
 * that a draft is shown as a draft rather than as a blank number, and — the one this
 * screen most needs — that PAGING IS HONEST.
 *
 * The repository truncates a page at 500 whatever it is asked for. A register that did
 * not page would show the first page of a busy year and look complete, so this one asks
 * for one row more than it draws and uses the extra as the answer to "is there another
 * page". The tests below assert both halves of that: the extra row is requested, and it
 * is not drawn.
 */

import type { JSX } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { DocumentListRow, Result } from '@shared/dto'
import { chargesOnTerms, DOCUMENT_KINDS, type DocumentKind } from '@shared/documents'
import { renderScreen, screenContext, type BridgeStub } from '../../test/harness'
import { documentRegisterScreens, DocumentRegister } from './DocumentRegister'

/** The register for one kind. Defaults to the invoice, which most tests below want. */
const register = (kind: DocumentKind = 'sales-invoice'): JSX.Element => (
  <DocumentRegister {...screenContext()} kind={kind} />
)

function invoice(over: Partial<DocumentListRow> = {}): DocumentListRow {
  return {
    id: 'doc-1',
    kind: 'sales-invoice',
    status: 'issued',
    number: 'INV/2026-27/0001',
    date: '2026-04-15',
    dueDate: '2026-05-15',
    partyId: 'party-1',
    partyName: 'Sunrise Components',
    grandTotal: '125000.00',
    settlement: 'open',
    ...over,
  }
}

const ROWS: DocumentListRow[] = [
  invoice(),
  invoice({
    id: 'doc-2',
    status: 'draft',
    number: null,
    partyName: 'Kaveri Metals',
    grandTotal: '4720.50',
    settlement: null,
  }),
  invoice({
    id: 'doc-3',
    status: 'cancelled',
    number: 'INV/2026-27/0002',
    partyName: 'Nilgiri Traders',
    grandTotal: '900.00',
    settlement: null,
  }),
]

const listing = (rows: DocumentListRow[]): BridgeStub => ({
  documents: { list: () => Promise.resolve<Result<DocumentListRow[]>>({ ok: true, data: rows }) },
})

/** The filters the last query carried, for asserting that a click reached main. */
const lastQuery = (bridge: {
  lastCallTo(channel: string): { args: readonly unknown[] } | undefined
}) => bridge.lastCallTo('documents:list')?.args[0] as Record<string, unknown> | undefined

const rowFor = async (number: string): Promise<HTMLElement> =>
  (await screen.findByText(number)).closest('tr') as HTMLElement

describe('what it asks main for', () => {
  it('asks for one kind and nothing else, because a quotation is not an invoice', async () => {
    const { bridge } = renderScreen(register(), { bridge: listing(ROWS) })

    await waitFor(() => expect(bridge.callsTo('documents:list')).toHaveLength(1))
    expect(lastQuery(bridge)?.['kind']).toBe('sales-invoice')
  })

  /* THE PAGING MECHANISM. One more row than the screen draws — the extra is how Next
   * knows there is somewhere to go, with no count query to disagree with the list. */
  it('asks for one row more than it will draw', async () => {
    const { bridge } = renderScreen(register(), { bridge: listing(ROWS) })

    await waitFor(() => expect(bridge.callsTo('documents:list')).toHaveLength(1))
    expect(lastQuery(bridge)?.['limit']).toBe(51)
    expect(lastQuery(bridge)?.['offset']).toBe(0)
  })

  /*
   * FILTERED BY MAIN, NOT BY THE PAGE. A status filter applied to the rows already
   * fetched would filter one page of a register and call the result the answer — the
   * drafts on page two would not appear, and nothing on screen would say so.
   */
  it('sends the status filter to main rather than filtering the page it has', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(register(), { bridge: listing(ROWS) })

    await screen.findByText('Sunrise Components')
    await user.click(screen.getByRole('button', { name: 'Drafts' }))

    await waitFor(() => expect(bridge.callsTo('documents:list')).toHaveLength(2))
    expect(lastQuery(bridge)?.['status']).toBe('draft')
  })

  it('leaves the status out entirely when the filter is All', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(register(), { bridge: listing(ROWS) })

    await screen.findByText('Sunrise Components')
    await user.click(screen.getByRole('button', { name: 'Drafts' }))
    await waitFor(() => expect(bridge.callsTo('documents:list')).toHaveLength(2))
    await user.click(screen.getByRole('button', { name: 'All' }))

    await waitFor(() => expect(bridge.callsTo('documents:list')).toHaveLength(3))
    /* Absent, not `status: ''` — main would reject that, and it means something else. */
    expect(lastQuery(bridge)).not.toHaveProperty('status')
  })

  /* Typing is not searching. A query per keystroke would put one read of the books on
   * every letter of a customer's name. */
  it('searches when the search is submitted, not on every keystroke', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(register(), { bridge: listing(ROWS) })

    await screen.findByText('Sunrise Components')
    await user.type(screen.getByPlaceholderText(/Search by number/), 'Kaveri')

    expect(bridge.callsTo('documents:list')).toHaveLength(1)

    await user.keyboard('{Enter}')
    await waitFor(() => expect(bridge.callsTo('documents:list')).toHaveLength(2))
    expect(lastQuery(bridge)?.['search']).toBe('Kaveri')
  })
})

describe('what it draws', () => {
  it('shows a document number, a customer and a total', async () => {
    renderScreen(register(), { bridge: listing(ROWS) })

    const row = await rowFor('INV/2026-27/0001')
    expect(within(row).getByText('Sunrise Components')).toBeInTheDocument()
    expect(within(row).getByText('1,25,000.00')).toBeInTheDocument()
    expect(within(row).getByText('Issued')).toBeInTheDocument()
  })

  /*
   * A draft has no number and must not borrow one. A blank cell reads as a number that
   * failed to load; the word says which of the two it is.
   *
   * ASSERTED ON THE NUMBER CELL, NOT ON THE ROW. The first version looked for the text
   * 'Draft' anywhere in the row and passed against a screen that rendered nothing at all
   * where the number goes — because the STATUS BADGE two cells along also says 'Draft'.
   * A mutation deleting the fallback survived. Cell zero is the number column.
   */
  it('says Draft in the number column where an unissued document has none', async () => {
    renderScreen(register(), { bridge: listing(ROWS) })

    const row = (await screen.findByText('Kaveri Metals')).closest('tr') as HTMLElement
    const cells = within(row).getAllByRole('cell')

    expect(cells[0]).toHaveTextContent('Draft')
    expect(within(row).getByText('4,720.50')).toBeInTheDocument()
  })

  it('formats every total the way the regime writes numbers', async () => {
    renderScreen(register(), {
      bridge: listing(ROWS),
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
      },
    })

    const row = await rowFor('INV/2026-27/0001')
    expect(within(row).getByText('125.000,00')).toBeInTheDocument()
  })

  it('does not total the page, because the total of a page means nothing', async () => {
    renderScreen(register(), { bridge: listing(ROWS) })

    await screen.findByText('Sunrise Components')
    /* 125000.00 + 4720.50 + 900.00 = 130620.50. Nothing on the page should say it. */
    expect(screen.queryByText('1,30,620.50')).toBeNull()
  })

  it('explains an empty register rather than showing an empty table', async () => {
    renderScreen(register(), { bridge: listing([]) })

    expect(await screen.findByText('No sales invoices yet')).toBeInTheDocument()
    expect(screen.getByText(/needs a customer and the business details/)).toBeInTheDocument()
  })

  it('says something different when a filter is what emptied it', async () => {
    const user = userEvent.setup()
    let call = 0
    renderScreen(register(), {
      bridge: {
        documents: {
          list: () => {
            call += 1
            return Promise.resolve<Result<DocumentListRow[]>>({
              ok: true,
              data: call === 1 ? ROWS : [],
            })
          },
        },
      },
    })

    await screen.findByText('Sunrise Components')
    await user.click(screen.getByRole('button', { name: 'Cancelled' }))

    expect(await screen.findByText('Nothing matches that')).toBeInTheDocument()
    expect(screen.queryByText('No sales invoices yet')).toBeNull()
  })

  it('shows what main said when the register cannot be read', async () => {
    renderScreen(register(), {
      bridge: {
        documents: {
          list: () =>
            Promise.resolve<Result<DocumentListRow[]>>({
              ok: false,
              error: { code: 'NO_COMPANY_OPEN', message: 'Open a company first.' },
            }),
        },
      },
    })

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(/Open a company first/)).toBeInTheDocument()
  })
})

describe('paging', () => {
  const page = (count: number, prefix: string): DocumentListRow[] =>
    Array.from({ length: count }, (_unused, index) =>
      invoice({
        id: `${prefix}-${index}`,
        number: `${prefix}/${index}`,
        partyName: `Party ${index}`,
      }),
    )

  it('offers no paging at all when everything fits on one page', async () => {
    renderScreen(register(), { bridge: listing(ROWS) })

    await screen.findByText('Sunrise Components')
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
  })

  /* THE EXTRA ROW IS NOT DRAWN. It exists only to answer the question, and a register
   * that showed 51 rows on a page of 50 would drift by one every page. */
  it('draws a page and keeps the extra row back', async () => {
    renderScreen(register(), { bridge: listing(page(51, 'A')) })

    await screen.findByText('Party 0')
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled()
    expect(screen.queryByText('Party 50')).toBeNull()
    expect(screen.getByText('Party 49')).toBeInTheDocument()
  })

  it('asks for the next page by offset, and can come back', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(register(), {
      bridge: listing(page(51, 'A')),
    })

    await screen.findByText('Party 0')
    await user.click(screen.getByRole('button', { name: 'Next' }))

    await waitFor(() => expect(lastQuery(bridge)?.['offset']).toBe(50))
    expect(screen.getByText('Page 2')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Previous' }))
    await waitFor(() => expect(lastQuery(bridge)?.['offset']).toBe(0))
  })

  /*
   * A refinement starts again at page one. Staying on page 4 of a filter that now matches
   * six documents shows an empty register, which reads as "there are none" — the worst
   * possible answer to give about somebody's invoices.
   */
  it('returns to the first page when the filter changes', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(register(), {
      bridge: listing(page(51, 'A')),
    })

    await screen.findByText('Party 0')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(lastQuery(bridge)?.['offset']).toBe(50))

    await user.click(screen.getByRole('button', { name: 'Drafts' }))

    await waitFor(() => expect(lastQuery(bridge)?.['offset']).toBe(0))
    expect(lastQuery(bridge)?.['status']).toBe('draft')
  })

  it('returns to the first page when the search changes', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(register(), {
      bridge: listing(page(51, 'A')),
    })

    await screen.findByText('Party 0')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(lastQuery(bridge)?.['offset']).toBe(50))

    await user.type(screen.getByPlaceholderText(/Search by number/), 'Kaveri{Enter}')

    await waitFor(() => expect(lastQuery(bridge)?.['search']).toBe('Kaveri'))
    expect(lastQuery(bridge)?.['offset']).toBe(0)
  })
})

describe('the other four kinds', () => {
  /*
   * THE QUERY IS THE WHOLE OF THE PER-KIND BEHAVIOUR, and it is what a shared component
   * makes easy to get wrong: one stale `kind` in the fetch and the credit note register
   * lists invoices, with every heading on the page still saying "Credit notes". Asked of
   * every kind rather than of one, so a sixth is covered by the loop it arrives in.
   */
  it('asks for its own kind, whichever kind it was registered as', async () => {
    for (const definition of DOCUMENT_KINDS) {
      const { bridge, unmount } = renderScreen(register(definition.kind), {
        bridge: listing(ROWS),
      })

      await waitFor(() => expect(bridge.callsTo('documents:list')).toHaveLength(1))
      expect(lastQuery(bridge)?.['kind']).toBe(definition.kind)
      unmount()
    }
  })

  it('heads the purchase register with the vendor, not the customer', async () => {
    renderScreen(register('purchase-bill'), { bridge: listing(ROWS) })

    expect(await screen.findByRole('columnheader', { name: 'Vendor' })).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Customer' })).toBeNull()
  })

  it('heads the sales register with the customer', async () => {
    renderScreen(register('credit-note'), { bridge: listing(ROWS) })

    expect(await screen.findByRole('columnheader', { name: 'Customer' })).toBeInTheDocument()
  })

  /*
   * COUNTED FROM THE KIND TABLE, so a sixth kind cannot arrive with a column of dashes.
   * The register asks `chargesOnTerms` rather than testing the kind, which is the same
   * question migration 0014's trigger asks and the same one issuing asks.
   */
  it('shows the due column for exactly the kinds that fall due', async () => {
    for (const definition of DOCUMENT_KINDS) {
      const { unmount } = renderScreen(register(definition.kind), { bridge: listing(ROWS) })
      await screen.findByRole('columnheader', { name: 'Number' })

      const due = screen.queryByRole('columnheader', { name: 'Due' })
      expect(due === null, `${definition.kind} draws the due column`).toBe(
        !chargesOnTerms(definition.kind),
      )
      unmount()
    }
  })

  /*
   * ASSERTED ON THE CELL, NOT ON THE ROW, for the reason the Draft test above gives: the
   * document date sits in the cell beside this one, and a version that drew the wrong one
   * of the two would satisfy any assertion made about the row as a whole. Cell two is Due.
   */
  it('shows the date an invoice falls due, in its own column', async () => {
    renderScreen(register('sales-invoice'), { bridge: listing(ROWS) })

    const cells = within(await rowFor('INV/2026-27/0001')).getAllByRole('cell')

    expect(cells[1]).toHaveTextContent('2026-04-15')
    expect(cells[2]).toHaveTextContent('2026-05-15')
  })

  /* A draft has none, and a blank cell reads as a date that failed to load. */
  it('draws a dash where a draft has no due date', async () => {
    renderScreen(register('sales-invoice'), {
      bridge: listing([invoice({ status: 'draft', number: null, dueDate: null })]),
    })

    const cells = within(await rowFor('Sunrise Components')).getAllByRole('cell')

    expect(cells[2]).toHaveTextContent('—')
  })

  it('names the kind on the button that starts one', async () => {
    renderScreen(register('debit-note'), { bridge: listing(ROWS) })

    expect(await screen.findByRole('button', { name: 'New debit note' })).toBeInTheDocument()
  })

  /* An empty register names what is missing. Saying "No invoices yet" on the credit note
   * screen would send somebody looking in the wrong place. */
  it('names its own kind when it is empty', async () => {
    renderScreen(register('quotation'), { bridge: listing([]) })

    expect(await screen.findByText('No quotations yet')).toBeInTheDocument()
  })

  /*
   * WHERE A ROW LEADS. Every register opens ITS OWN editor, and this is the assertion a
   * shared component most needs: a route built from a fixed string would send every kind
   * to the invoice editor, which would then load a credit note and draw it as an invoice.
   */
  it('opens the editor for its own kind', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()

    renderScreen(<DocumentRegister {...screenContext({ navigate })} kind="purchase-bill" />, {
      bridge: listing(ROWS),
    })

    await user.click(await screen.findByRole('button', { name: 'INV/2026-27/0001' }))
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ screenId: 'purchase-bill', params: { id: 'doc-1' } }),
    )
  })
})

describe('the registrations', () => {
  /*
   * The rail is built from these, so a kind missing one is a kind with no way in. The
   * count is asserted against the shared table rather than against 5, so adding a kind
   * without a screen fails here rather than in somebody's hands.
   */
  it('registers a screen for every kind the shared table knows', () => {
    expect(documentRegisterScreens.map((definition) => definition.title)).toEqual(
      DOCUMENT_KINDS.map((definition) => definition.pluralLabel),
    )
  })

  it('puts every one of them in the rail', () => {
    for (const definition of documentRegisterScreens) {
      expect(definition.nav).toBeDefined()
    }
  })
})
