/*
 * The aged report, rendered.
 *
 * The wording, the overdue flag and where a row opens are covered as pure functions next
 * door in `ageing-view.test.ts`. What is covered only here is what the screen asks main
 * for and what it does with the answer — and three of those are the whole reason 0014-3
 * was a batch rather than a table:
 *
 *   THE FOOT NAMES THE ACCOUNT AND ITS BALANCE. That pair of figures is the claim the
 *   report makes, and putting it on the page is what lets somebody check this against the
 *   balance sheet without reading any code.
 *
 *   A REPORT THAT DOES NOT TIE STILL DRAWS. The notice is loud and it is not a
 *   replacement for the rows: the rows are where the difference is.
 *
 *   THE ROW THAT NAMES NOBODY IS DRAWN AND MARKED. Hiding it is the one thing that would
 *   make this page disagree with the account it claims to equal.
 */

import type { JSX } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AgedItem, AgedPartyRow, AgedReport as Report, Result } from '@shared/dto'
import { TRADE_SIDES, type TradeSide } from '@shared/documents'
import { renderScreen, screenContext, type BridgeStub } from '../../test/harness'
import { agedReportScreens, AgedReport } from './AgedReport'

/* Four columns rather than main's five, so nothing here can be passing because it
 * happens to match the table `domain/reports` holds. The screen draws what arrives. */
const BUCKETS = [
  { label: 'Not yet due', fromDays: null, toDays: 0 },
  { label: '1-30 days', fromDays: 1, toDays: 30 },
  { label: '31-60 days', fromDays: 31, toDays: 60 },
  { label: 'Over 60 days', fromDays: 61, toDays: null },
]

function item(over: Partial<AgedItem> = {}): AgedItem {
  return {
    source: 'document',
    sourceId: 'document-1',
    kind: 'sales-invoice',
    number: 'INV/2026-27/0001',
    date: '2026-04-01',
    dueDate: '2026-05-01',
    daysOverdue: 45,
    bucket: 2,
    amount: '118000.00',
    ...over,
  }
}

function party(over: Partial<AgedPartyRow> = {}): AgedPartyRow {
  return {
    partyId: 'party-1',
    partyName: 'Sunrise Components',
    buckets: ['0.00', '0.00', '118000.00', '0.00'],
    onAccount: '0.00',
    total: '118000.00',
    items: [item()],
    ...over,
  }
}

function report(over: Partial<Report> = {}): Report {
  return {
    side: 'sales',
    asAtDate: '2026-06-15',
    accountId: 'account-1',
    accountCode: '1300',
    accountName: 'Accounts Receivable',
    buckets: BUCKETS,
    parties: [party()],
    totals: {
      buckets: ['0.00', '0.00', '118000.00', '0.00'],
      onAccount: '0.00',
      overdue: '118000.00',
      total: '118000.00',
    },
    controlBalance: '118000.00',
    ties: true,
    ...over,
  }
}

const returning = (value: Report): BridgeStub => ({
  reports: { aged: () => Promise.resolve<Result<Report>>({ ok: true, data: value }) },
})

const aged = (side: TradeSide = 'sales', navigate = (): void => {}): JSX.Element => (
  <AgedReport {...screenContext({ navigate })} side={side} />
)

const rowFor = async (name: string): Promise<HTMLElement> =>
  (await screen.findByRole('button', { name: new RegExp(name) })).closest('tr') as HTMLElement

/*
 * A cell's figure, EXACTLY — never `toHaveTextContent`, which matches a SUBSTRING.
 * '-5,000.00' contains '5,000.00', so a sign flip passes every such assertion, and this is
 * a page whose whole subject is credits standing against debts. `toHaveTextContent('')`
 * is worse still: every string contains the empty one, so it asserts nothing.
 *
 * Found by a mutation that swapped a party's on-account figure for its total and survived.
 */
const figureIn = (cell: HTMLElement | undefined): string => cell?.textContent ?? '<no cell>'

// ---- What it asks for -------------------------------------------------------

describe('the query', () => {
  it("asks for today's report, on the side it was registered for", async () => {
    const { bridge } = renderScreen(aged('purchase'), { bridge: returning(report()) })
    await screen.findByRole('button', { name: /Sunrise Components/ })

    /* Today from the local calendar, built here rather than imported: a hardcoded date
     * would satisfy a pattern match and show every user the same wrong day. */
    const now = new Date()
    const pad = (value: number) => String(value).padStart(2, '0')
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

    expect(bridge.lastCallTo('reports:aged')?.args[0]).toEqual({
      side: 'purchase',
      asAtDate: today,
    })
  })

  it('sends the date the user picked', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(aged(), { bridge: returning(report()) })
    await screen.findByRole('button', { name: /Sunrise Components/ })

    await user.clear(screen.getByLabelText('As at'))
    await user.type(screen.getByLabelText('As at'), '2026-03-31')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(bridge.callsTo('reports:aged')).toHaveLength(2))
    expect(bridge.lastCallTo('reports:aged')?.args[0]).toEqual({
      side: 'sales',
      asAtDate: '2026-03-31',
    })
  })

  it('shows a failure from main instead of an empty table', async () => {
    renderScreen(aged(), {
      bridge: {
        reports: {
          aged: () =>
            Promise.resolve({
              ok: false,
              error: { code: 'ROLE_UNMAPPED', message: 'No account is mapped to receivable.' },
            }),
        },
      },
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('No account is mapped')
    expect(screen.queryByText('Sunrise Components')).toBeNull()
  })
})

// ---- The table --------------------------------------------------------------

describe('the columns', () => {
  it('draws a column for every bucket the report sent', async () => {
    renderScreen(aged(), { bridge: returning(report()) })

    for (const bucket of BUCKETS) {
      expect(await screen.findByRole('columnheader', { name: bucket.label })).toBeInTheDocument()
    }
  })

  /* The labels are ages PAST DUE, not ages. On 30-day terms the two differ by a month on
   * every invoice, so the full sentence sits on the header. */
  it('says what a column covers in full', async () => {
    renderScreen(aged(), { bridge: returning(report()) })

    const header = await screen.findByRole('columnheader', { name: '31-60 days' })
    expect(header).toHaveAttribute('title', '31 to 60 days past due')
  })

  it("puts a party's figure in the column it belongs to", async () => {
    renderScreen(aged(), { bridge: returning(report()) })

    const cells = within(await rowFor('Sunrise Components')).getAllByRole('cell')
    /* Party, four buckets, on account, total. The figure is in the third bucket, and the
     * columns it is not in are EMPTY rather than nought — the printed convention, and the
     * thing that makes the one figure findable by eye. */
    expect(figureIn(cells[3])).toBe('1,18,000.00')
    expect(figureIn(cells[1])).toBe('')
    expect(figureIn(cells[6])).toBe('1,18,000.00')
  })

  /*
   * "LESS ON ACCOUNT", NOT "ON ACCOUNT". `total` is the columns less this figure, and
   * main sends it as a positive quantity. A reader adding across a row headed "On
   * account" would be out by twice it — and the renderer may not flip the sign, because
   * that is arithmetic on money.
   */
  it('heads the credit column as a deduction', async () => {
    renderScreen(aged(), { bridge: returning(report()) })
    expect(await screen.findByRole('columnheader', { name: 'Less on account' })).toBeInTheDocument()
  })

  it('shows money on account as the positive figure main sent', async () => {
    renderScreen(aged(), {
      bridge: returning(
        report({
          parties: [
            party({
              buckets: ['0.00', '0.00', '0.00', '0.00'],
              onAccount: '5000.00',
              total: '-5000.00',
              items: [
                item({
                  source: 'receipt',
                  kind: 'receipt',
                  sourceId: 'receipt-1',
                  number: 'RCT/2026-27/0001',
                  bucket: null,
                  amount: '-5000.00',
                }),
              ],
            }),
          ],
          totals: {
            buckets: ['0.00', '0.00', '0.00', '0.00'],
            onAccount: '5000.00',
            overdue: '0.00',
            total: '-5000.00',
          },
          controlBalance: '-5000.00',
        }),
      ),
    })

    const cells = within(await rowFor('Sunrise Components')).getAllByRole('cell')
    /* Positive in its own column, and the total it is deducted from is negative. The two
     * are the same money and they do not have the same sign — which is why the heading
     * says "Less on account" and why nothing here flips one to match the other. */
    expect(figureIn(cells[5])).toBe('5,000.00')
    expect(figureIn(cells[6])).toBe('-5,000.00')
  })
})

// ---- The claim the report makes ---------------------------------------------

describe('the foot', () => {
  /*
   * The whole point of the page being a decomposition rather than a list. Naming the
   * account beside its balance is what lets somebody hold this against the balance sheet.
   */
  it('names the account it decomposes and states its balance', async () => {
    renderScreen(aged(), { bridge: returning(report()) })

    const foot = (await screen.findByText(/Balance on 1300 · Accounts Receivable/)).closest(
      'tr',
    ) as HTMLElement
    const cells = within(foot).getAllByRole('cell')
    /* Three cells: the name, one spanning every column it is not in, and the figure. The
     * span is what puts the balance under Total — directly beneath the figure it claims
     * to equal, which is the only place the two can be compared by eye. */
    expect(cells).toHaveLength(3)
    expect(cells[1]).toHaveAttribute('colspan', String(BUCKETS.length + 1))
    expect(figureIn(cells[2])).toBe('1,18,000.00')
  })

  it("totals the report under the debt's own name", async () => {
    renderScreen(aged(), { bridge: returning(report()) })
    expect(await screen.findByText('Owed to the business')).toBeInTheDocument()
  })

  it('calls the same figure something else on the purchase side', async () => {
    renderScreen(aged('purchase'), {
      bridge: returning(report({ side: 'purchase', accountName: 'Accounts Payable' })),
    })
    expect(await screen.findByText('Owed by the business')).toBeInTheDocument()
    /* And the parties in the first column are vendors, not customers. */
    expect(screen.getByRole('columnheader', { name: 'Vendor' })).toBeInTheDocument()
  })
})

describe('when it does not tie', () => {
  const broken = report({ controlBalance: '120000.00', ties: false })

  it('says so, loudly, with both figures', async () => {
    renderScreen(aged(), { bridge: returning(broken) })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('This report does not agree with the account')
    expect(alert).toHaveTextContent('come to 1,18,000.00')
    expect(alert).toHaveTextContent('stands at 1,20,000.00')
  })

  /* NOT the difference. Subtracting two amounts is money arithmetic (§1.7), and 2,000.00
   * appears on this page only if the renderer worked it out. */
  it('states the two figures and does not subtract them', async () => {
    renderScreen(aged(), { bridge: returning(broken) })

    await screen.findByRole('alert')
    expect(screen.queryByText(/2,000\.00/)).toBeNull()
  })

  /*
   * THE ROWS ARE THE DIAGNOSIS. A page that refused to draw would leave somebody holding
   * a number they cannot explain and nothing to look at.
   */
  it('still draws every row', async () => {
    renderScreen(aged(), { bridge: returning(broken) })

    expect(await screen.findByRole('button', { name: /Sunrise Components/ })).toBeInTheDocument()

    /* And the foot still states the ACCOUNT's balance rather than the report's own total.
     * Showing the total twice would make a page that does not tie look as though it did. */
    const foot = screen.getByText(/Balance on 1300/).closest('tr') as HTMLElement
    expect(within(foot).getByText('1,20,000.00')).toBeInTheDocument()
  })

  it('says nothing of the sort when it ties', async () => {
    renderScreen(aged(), { bridge: returning(report()) })
    await screen.findByRole('button', { name: /Sunrise Components/ })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

// ---- The row that names nobody ----------------------------------------------

describe('a line with no party', () => {
  const orphaned = report({
    parties: [
      party(),
      party({
        partyId: null,
        partyName: 'Not attributed to a party',
        buckets: ['0.00', '2000.00', '0.00', '0.00'],
        total: '2000.00',
        items: [
          item({
            source: 'journal',
            kind: null,
            sourceId: 'entry-1',
            number: 'JV/2026-27/0007',
            bucket: 1,
            amount: '2000.00',
          }),
        ],
      }),
    ],
    totals: {
      buckets: ['0.00', '2000.00', '118000.00', '0.00'],
      onAccount: '0.00',
      overdue: '120000.00',
      total: '120000.00',
    },
    controlBalance: '120000.00',
  })

  /* Dropping it is the one thing that would make the foot disagree with the account. */
  it('draws it like any other row', async () => {
    renderScreen(aged(), { bridge: returning(orphaned) })

    const cells = within(await rowFor('Not attributed to a party')).getAllByRole('cell')
    /* In its column, and in the total — the same figure twice, as any other row. */
    expect(figureIn(cells[2])).toBe('2,000.00')
    expect(figureIn(cells[6])).toBe('2,000.00')
  })

  it('marks it as what it is', async () => {
    renderScreen(aged(), { bridge: returning(orphaned) })

    const row = await rowFor('Not attributed to a party')
    expect(within(row).getByText('No party')).toBeInTheDocument()
  })

  it('explains once what such a row means', async () => {
    renderScreen(aged(), { bridge: returning(orphaned) })
    expect(await screen.findByText('A line on this account names no party')).toBeInTheDocument()
  })

  it('says nothing of the sort when every line names one', async () => {
    renderScreen(aged(), { bridge: returning(report()) })
    await screen.findByRole('button', { name: /Sunrise Components/ })
    expect(screen.queryByText('A line on this account names no party')).toBeNull()
  })
})

// ---- The drill-down ---------------------------------------------------------

describe('a party opened up', () => {
  it('shows nothing until it is asked', async () => {
    renderScreen(aged(), { bridge: returning(report()) })
    await screen.findByRole('button', { name: /Sunrise Components/ })
    expect(screen.queryByText('INV/2026-27/0001')).toBeNull()
  })

  it('shows the items behind the figures', async () => {
    const user = userEvent.setup()
    renderScreen(aged(), { bridge: returning(report()) })

    await user.click(await screen.findByRole('button', { name: /Sunrise Components/ }))

    const row = (await screen.findByText('INV/2026-27/0001')).closest('tr') as HTMLElement
    expect(within(row).getByText('Sales invoice')).toBeInTheDocument()
    expect(within(row).getByText('2026-05-01')).toBeInTheDocument()
    expect(within(row).getByText('31-60 days')).toBeInTheDocument()
    expect(within(row).getByText('1,18,000.00')).toBeInTheDocument()
  })

  it('closes again', async () => {
    const user = userEvent.setup()
    renderScreen(aged(), { bridge: returning(report()) })

    const toggle = await screen.findByRole('button', { name: /Sunrise Components/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('INV/2026-27/0001')).toBeNull()
  })

  /*
   * THE FLAG THE REGISTER DELIBERATELY DOES NOT HAVE. A register cannot say it, because a
   * document does not know what has been paid against it. Every item here is money still
   * standing on the account as at the date.
   */
  it('says how late an item is', async () => {
    const user = userEvent.setup()
    renderScreen(aged(), { bridge: returning(report()) })

    await user.click(await screen.findByRole('button', { name: /Sunrise Components/ }))
    const row = (await screen.findByText('INV/2026-27/0001')).closest('tr') as HTMLElement
    expect(within(row).getByText('45 days overdue')).toBeInTheDocument()
  })

  it('does not call a credit overdue, however old it is', async () => {
    const user = userEvent.setup()
    renderScreen(aged(), {
      bridge: returning(
        report({
          parties: [
            party({
              items: [
                item({
                  source: 'receipt',
                  kind: 'receipt',
                  sourceId: 'receipt-1',
                  number: 'RCT/2026-27/0001',
                  bucket: null,
                  daysOverdue: 400,
                  amount: '-5000.00',
                }),
              ],
            }),
          ],
        }),
      ),
    })

    await user.click(await screen.findByRole('button', { name: /Sunrise Components/ }))
    const row = (await screen.findByText('RCT/2026-27/0001')).closest('tr') as HTMLElement
    expect(within(row).queryByText(/overdue/)).toBeNull()
    expect(within(row).getByText('On account')).toBeInTheDocument()
    /* The item's own amount, signed exactly as main sent it — not the party's total, and
     * not flipped to agree with the positive figure in the on-account column. */
    expect(within(row).getByText('-5,000.00')).toBeInTheDocument()
    /* A receipt's due date is a sort key, not a day it falls payable. */
    expect(within(row).getByText('—')).toBeInTheDocument()
  })

  it('opens a document in its own editor', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    renderScreen(aged('sales', navigate), { bridge: returning(report()) })

    await user.click(await screen.findByRole('button', { name: /Sunrise Components/ }))
    await user.click(await screen.findByRole('button', { name: 'INV/2026-27/0001' }))

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ screenId: 'sales-invoice', params: { id: 'document-1' } }),
    )
  })

  /* A journal entry has no editor in this product, so its number is text. A button here
   * would be a route to a screen that does not resolve — a blank page, not a message. */
  it('leaves a journal entry as text rather than a dead link', async () => {
    const user = userEvent.setup()
    renderScreen(aged(), {
      bridge: returning(
        report({
          parties: [
            party({
              items: [
                item({
                  source: 'journal',
                  kind: null,
                  sourceId: 'entry-1',
                  number: 'JV/2026-27/0007',
                }),
              ],
            }),
          ],
        }),
      ),
    })

    await user.click(await screen.findByRole('button', { name: /Sunrise Components/ }))
    expect(await screen.findByText('JV/2026-27/0007')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'JV/2026-27/0007' })).toBeNull()
    const row = (screen.getByText('JV/2026-27/0007') as HTMLElement).closest('tr') as HTMLElement
    expect(within(row).getByText('Journal entry')).toBeInTheDocument()
  })

  /* A different day is a different set of rows, and one party's items under another's
   * figures is worse than closing them. */
  it('closes everything when the date changes', async () => {
    const user = userEvent.setup()
    renderScreen(aged(), { bridge: returning(report()) })

    await user.click(await screen.findByRole('button', { name: /Sunrise Components/ }))
    await screen.findByText('INV/2026-27/0001')

    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(screen.queryByText('INV/2026-27/0001')).toBeNull())
  })
})

// ---- Nothing to show --------------------------------------------------------

describe('an empty report', () => {
  const nothing = report({
    parties: [],
    totals: {
      buckets: ['0.00', '0.00', '0.00', '0.00'],
      onAccount: '0.00',
      overdue: '0.00',
      total: '0.00',
    },
    controlBalance: '0.00',
  })

  it('says so in the words of the side it is on', async () => {
    renderScreen(aged(), { bridge: returning(nothing) })
    expect(
      await screen.findByText('No customer owes anything as at this date.'),
    ).toBeInTheDocument()
  })

  it('says something else on the purchase side', async () => {
    renderScreen(aged('purchase'), {
      bridge: returning({ ...nothing, side: 'purchase', accountName: 'Accounts Payable' }),
    })
    expect(
      await screen.findByText('Nothing is owed to any supplier as at this date.'),
    ).toBeInTheDocument()
  })
})

// ---- The registrations ------------------------------------------------------

describe('the registrations', () => {
  /* One per side of the trade, from the shared table. A third side added there gets a
   * report and a rail entry, and fails to compile until it has been named. */
  it('registers a screen for every side', () => {
    expect(agedReportScreens.map((definition) => definition.id)).toEqual(
      TRADE_SIDES.map((side) => `aged-${side}`),
    )
  })

  it('puts each in the rail of its own side', () => {
    expect(agedReportScreens.map((definition) => definition.nav?.group)).toEqual(
      TRADE_SIDES.map((side) => (side === 'sales' ? 'sales' : 'purchases')),
    )
  })

  /* One per section now, so no two can collide in a rail. */
  it('never puts two of them in the same section', () => {
    const groups = agedReportScreens.map((definition) => definition.nav?.group)
    expect(new Set(groups).size).toBe(groups.length)
  })
})
