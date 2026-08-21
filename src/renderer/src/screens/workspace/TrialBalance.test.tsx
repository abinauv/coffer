/*
 * The trial balance, rendered.
 *
 * `sectionsOf` and `formatAmount` are covered as pure functions next door. What is
 * covered only here is that the screen puts their output on the page: that the figure
 * against an account is that account's figure, that the range the user typed is the
 * range that was asked for, and — the one this screen exists for — that a report which
 * does not tie says so in words rather than showing a quietly wrong total.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { AccountType, Result, TrialBalance as Report, TrialBalanceRow } from '@shared/dto'
import { DEFAULT_REGIME, renderScreen, type BridgeStub } from '../../test/harness'
import { TrialBalance } from './TrialBalance'

function line(
  code: string,
  name: string,
  type: AccountType,
  debit: string,
  credit: string,
): TrialBalanceRow {
  return {
    accountId: code,
    code,
    name,
    type,
    debit,
    credit,
    debitBalance: debit,
    creditBalance: credit,
  }
}

/*
 * Deliberately NOT in the order the report must come out in.
 *
 * Listed asset-first, this fixture would pass whether the screen sorted the sections or
 * left them in the order they arrived — mutation testing found exactly that, because the
 * natural order of a chart of accounts is also the order a report is read in. A fixture
 * that happens to agree with the expected answer tests nothing about how it was reached.
 */
const ROWS = [
  line('6200', 'Rent', 'expense', '17500.00', '0.00'),
  line('1200', 'Bank', 'asset', '125000.00', '0.00'),
  line('4100', 'Sales', 'income', '0.00', '58000.50'),
  line('2100', 'Trade Payables', 'liability', '0.00', '32000.00'),
  line('1300', 'Trade Receivables', 'asset', '47500.50', '0.00'),
  line('3100', 'Capital', 'equity', '0.00', '100000.00'),
]

function report(over: Partial<Report> = {}): Report {
  return {
    fromDate: null,
    toDate: null,
    rows: ROWS,
    totalDebit: '190000.50',
    totalCredit: '190000.50',
    balanced: true,
    ...over,
  }
}

function bridgeReturning(value: Report | Result<Report>): BridgeStub {
  return {
    ledger: {
      trialBalance: () =>
        Promise.resolve('ok' in value ? value : ({ ok: true, data: value } as Result<Report>)),
    },
  }
}

/** The row for an account, by the code in its first cell. */
async function rowFor(code: string): Promise<HTMLElement> {
  const cell = await screen.findByText(code)
  const row = cell.closest('tr')
  if (row === null) throw new Error(`No row around the cell for ${code}`)
  return row
}

/*
 * The two figure cells of a row, as [debit, credit].
 *
 * By position, because which column a figure lands in is the whole claim. Asserting
 * that '1,25,000.00' appears somewhere in the row passes just as happily when the two
 * columns have been swapped, and a trial balance with its sides reversed is the one
 * defect this report cannot be allowed to have.
 */
function figuresOf(row: HTMLElement): [string, string] {
  const cells = [...row.querySelectorAll('td.ledger-table__figure')].map(
    (cell) => cell.textContent ?? '',
  )
  if (cells.length !== 2) throw new Error(`Expected two figure cells, found ${cells.length}`)
  return [cells[0] ?? '', cells[1] ?? '']
}

describe('TrialBalance', () => {
  it('asks for the whole ledger on mount, with no range', async () => {
    const { bridge } = renderScreen(<TrialBalance />, { bridge: bridgeReturning(report()) })

    await screen.findByText('Bank')
    expect(bridge.callsTo('ledger:trialBalance')).toHaveLength(1)
    /* An empty date field must not become `fromDate: ''`, which main would reject. */
    expect(bridge.lastCallTo('ledger:trialBalance')?.args[0]).toEqual({})
  })

  it('puts each account against its own figure, on its own side', async () => {
    renderScreen(<TrialBalance />, { bridge: bridgeReturning(report()) })

    const bank = await rowFor('1200')
    expect(within(bank).getByText('Bank')).toBeInTheDocument()
    /* A debit balance in the debit column, and nothing at all in the credit one —
     * a column of '0.00' against every account is noise to read past. */
    expect(figuresOf(bank)).toEqual(['1,25,000.00', ''])

    expect(figuresOf(await rowFor('2100'))).toEqual(['', '32,000.00'])
    expect(figuresOf(await rowFor('1300'))).toEqual(['47,500.50', ''])
  })

  /*
   * THE ONLY ASSERTION IN THE RENDERER THAT CAN TELL 2.2e-2 FROM WHAT CAME BEFORE IT.
   *
   * Every other figure in this suite is Indian, because the harness defaults to the
   * Indian regime — which is right, since those tests are about the trial balance and
   * not about grouping. But a screen that ignored the regime entirely and kept the old
   * hard-coded lakh/crore convention would pass every one of them.
   *
   * So: the same report, a regime that groups in threes and swaps both separators, and
   * the figures come out Portuguese. 1,25,000.00 becomes 125.000,00.
   */
  it('writes its figures the way the open company\u2019s regime writes numbers', async () => {
    renderScreen(<TrialBalance />, {
      bridge: bridgeReturning(report()),
      regime: {
        ...DEFAULT_REGIME,
        id: 'pt',
        label: 'Portugal \u2014 IVA',
        numberFormat: {
          groupSizes: [3],
          decimalSeparator: ',',
          groupSeparator: '.',
          currencyCode: 'EUR',
          currencySymbol: '\u20ac',
        },
      },
    })

    expect(figuresOf(await rowFor('1200'))).toEqual(['125.000,00', ''])
    expect(figuresOf(await rowFor('1300'))).toEqual(['47.500,50', ''])
  })

  it('groups the accounts under their headings, balance sheet before profit and loss', async () => {
    renderScreen(<TrialBalance />, { bridge: bridgeReturning(report()) })
    await screen.findByText('Bank')

    /* Read off the rendered table rather than from `sectionsOf`, which is what is
     * under test here: that each account is drawn beneath its own heading, in the
     * order a set of accounts is read. */
    const sections = [...screen.getByRole('table').querySelectorAll('tbody')].map((body) => ({
      heading: body.querySelector('th[scope="rowgroup"]')?.textContent,
      codes: [...body.querySelectorAll('td.ledger-table__code')].map((cell) => cell.textContent),
    }))

    expect(sections).toEqual([
      { heading: 'Assets', codes: ['1200', '1300'] },
      { heading: 'Liabilities', codes: ['2100'] },
      { heading: 'Equity', codes: ['3100'] },
      { heading: 'Income', codes: ['4100'] },
      { heading: 'Expenses', codes: ['6200'] },
    ])
  })

  it('says which range the figures cover', async () => {
    renderScreen(<TrialBalance />, {
      bridge: bridgeReturning(report({ fromDate: '2026-04-01', toDate: '2027-03-31' })),
    })

    /* A report with no dates on it is a report that cannot be checked against anything
     * later. Whatever range was summed has to be on the page with the figures. */
    expect(await screen.findByText('2026-04-01 to 2027-03-31')).toBeInTheDocument()
  })

  it('says so when the range is the whole ledger', async () => {
    renderScreen(<TrialBalance />, { bridge: bridgeReturning(report()) })
    expect(await screen.findByText('Everything in the books')).toBeInTheDocument()
  })

  it('subtotals each section', async () => {
    renderScreen(<TrialBalance />, { bridge: bridgeReturning(report()) })
    await screen.findByText('Bank')

    const assets = screen.getByText('Total assets').closest('tr')
    expect(assets).not.toBeNull()
    /* 1,25,000.00 + 47,500.50 — and the reason `sumAmounts` counts in paise. */
    expect(within(assets as HTMLElement).getByText('1,72,500.50')).toBeInTheDocument()
  })

  it('shows the totals it was given rather than re-adding the rows', async () => {
    /* Deliberately not the sum of ROWS. The report's own totals are what main
     * computed from the lines; recomputing them here would be a second opinion. */
    renderScreen(<TrialBalance />, {
      bridge: bridgeReturning(report({ totalDebit: '190000.50', totalCredit: '190000.50' })),
    })

    await screen.findByText('Bank')
    const table = screen.getByRole('table')
    const footer = table.querySelector('tfoot')
    expect(footer).not.toBeNull()
    expect(within(footer as HTMLElement).getAllByText('1,90,000.50')).toHaveLength(2)
  })

  /* The reason this screen exists. A trial balance that does not tie is not a
   * rendering problem, and must never be shown as a small red number. */
  it('says loudly when the report does not tie', async () => {
    renderScreen(<TrialBalance />, {
      bridge: bridgeReturning(
        report({ totalDebit: '190000.50', totalCredit: '189000.50', balanced: false }),
      ),
    })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('This trial balance does not tie')
    /* The whole sentence, not the two figures somewhere in it: swap them and the
     * message is still alarming, still specific, and wrong about which side is short. */
    expect(alert).toHaveTextContent(
      'Total debits are 1,90,000.50 and total credits are 1,89,000.50',
    )

    const footer = screen.getByRole('table').querySelector('tfoot tr')
    expect(figuresOf(footer as HTMLElement)).toEqual(['1,90,000.50', '1,89,000.50'])
  })

  it('says nothing of the sort when it does tie', async () => {
    renderScreen(<TrialBalance />, { bridge: bridgeReturning(report()) })

    await screen.findByText('Bank')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('sends the range the user typed, and only when they apply it', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<TrialBalance />, { bridge: bridgeReturning(report()) })
    await screen.findByText('Bank')

    await user.type(screen.getByLabelText('From'), '2026-04-01')
    await user.type(screen.getByLabelText('To'), '2027-03-31')

    /* Typing a date must not re-run the query on every keystroke. */
    expect(bridge.callsTo('ledger:trialBalance')).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(bridge.callsTo('ledger:trialBalance')).toHaveLength(2))
    expect(bridge.lastCallTo('ledger:trialBalance')?.args[0]).toEqual({
      fromDate: '2026-04-01',
      toDate: '2027-03-31',
    })
  })

  it('clears back to the whole ledger', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<TrialBalance />, { bridge: bridgeReturning(report()) })
    await screen.findByText('Bank')

    await user.type(screen.getByLabelText('From'), '2026-04-01')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(bridge.callsTo('ledger:trialBalance')).toHaveLength(2))

    await user.click(screen.getByRole('button', { name: 'Clear' }))

    await waitFor(() => expect(bridge.callsTo('ledger:trialBalance')).toHaveLength(3))
    expect(bridge.lastCallTo('ledger:trialBalance')?.args[0]).toEqual({})
    expect(screen.getByLabelText('From')).toHaveValue('')
  })

  it('offers no Clear button until there is something to clear', async () => {
    renderScreen(<TrialBalance />, { bridge: bridgeReturning(report()) })
    await screen.findByText('Bank')
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
  })

  it('says the books are empty rather than drawing an empty table', async () => {
    renderScreen(<TrialBalance />, {
      bridge: bridgeReturning(report({ rows: [], totalDebit: '0.00', totalCredit: '0.00' })),
    })

    expect(await screen.findByText('Nothing has been posted yet')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('shows a failure from main instead of a blank report', async () => {
    renderScreen(<TrialBalance />, {
      bridge: {
        ledger: {
          trialBalance: () =>
            Promise.resolve({
              ok: false,
              error: { code: 'NO_COMPANY_OPEN', message: 'Open a company first.' },
            }),
        },
      },
    })

    const alert = await screen.findByRole('alert')
    expect(alert).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('recovers when a later refresh succeeds', async () => {
    const user = userEvent.setup()
    let attempt = 0
    const { bridge } = renderScreen(<TrialBalance />, {
      bridge: {
        ledger: {
          trialBalance: () => {
            attempt += 1
            return Promise.resolve(
              attempt === 1
                ? { ok: false, error: { code: 'NO_COMPANY_OPEN', message: 'Open a company.' } }
                : { ok: true, data: report() },
            )
          },
        },
      },
    })

    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: 'Refresh' }))

    await waitFor(() => expect(bridge.callsTo('ledger:trialBalance')).toHaveLength(2))
    expect(await screen.findByText('Bank')).toBeInTheDocument()
    /* The stale failure must not sit above a report that has since loaded. */
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
