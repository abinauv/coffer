/*
 * The day book, rendered.
 *
 * What is covered only here: that entries are grouped under their own day, that each
 * day's total is the one main computed, and that an entry which has been reversed says
 * so — a day book that showed a reversed entry as ordinary would be read as a duplicate.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { DayBook as Book, JournalEntry, JournalLine } from '@shared/dto'
import { renderScreen, type BridgeStub } from '../../test/harness'
import { DayBook } from './DayBook'

function jline(id: string, code: string, name: string, debit: string, credit: string): JournalLine {
  return {
    id,
    lineNumber: 1,
    accountId: code,
    accountCode: code,
    accountName: name,
    debit,
    credit,
    narration: null,
    partyId: null,
    partyName: null,
  }
}

function entry(over: Partial<JournalEntry> & Pick<JournalEntry, 'id' | 'date'>): JournalEntry {
  return {
    entryNumber: `JV-${over.id}`,
    narration: 'A sale',
    sourceType: 'manual',
    sourceId: null,
    sourceNumber: null,
    periodId: 'p1',
    reversesEntryId: null,
    reversedByEntryId: null,
    lines: [
      jline(`${over.id}-1`, '1210', 'Bank Account', '1000.00', '0.00'),
      jline(`${over.id}-2`, '4100', 'Sales', '0.00', '1000.00'),
    ],
    total: '1000.00',
    postedAt: '2026-04-01T00:00:00.000Z',
    ...over,
  }
}

function book(over: Partial<Book> = {}): Book {
  return {
    fromDate: null,
    toDate: null,
    days: [
      {
        date: '2026-04-01',
        entries: [entry({ id: 'a', date: '2026-04-01' }), entry({ id: 'b', date: '2026-04-01' })],
        total: '2000.00',
      },
      { date: '2026-04-02', entries: [entry({ id: 'c', date: '2026-04-02' })], total: '1000.00' },
    ],
    entryCount: 3,
    total: '3000.00',
    ...over,
  }
}

function bridgeReturning(value: Book): BridgeStub {
  return { reports: { dayBook: () => Promise.resolve({ ok: true, data: value }) } }
}

describe('DayBook', () => {
  it('asks for the whole book on mount, with no range', async () => {
    const { bridge } = renderScreen(<DayBook />, { bridge: bridgeReturning(book()) })

    await screen.findByText(/JV-a/)
    expect(bridge.lastCallTo('reports:dayBook')?.args[0]).toEqual({})
  })

  it('puts each entry under its own day', async () => {
    renderScreen(<DayBook />, { bridge: bridgeReturning(book()) })
    await screen.findByText(/JV-a/)

    const sections = [...document.querySelectorAll('section')]
    expect(sections).toHaveLength(2)
    expect(sections[0]?.textContent).toContain('1 Apr 2026')
    expect(sections[0]?.textContent).toContain('JV-a')
    expect(sections[0]?.textContent).toContain('JV-b')
    expect(sections[0]?.textContent).not.toContain('JV-c')
    expect(sections[1]?.textContent).toContain('JV-c')
  })

  /* Totalled in main. A column of figures totalled by whoever drew it is how two parts
   * of one screen come to disagree. */
  it('shows the total main computed for each day', async () => {
    renderScreen(<DayBook />, { bridge: bridgeReturning(book()) })
    await screen.findByText(/JV-a/)

    const sections = [...document.querySelectorAll('section')]
    expect(sections[0]?.textContent).toContain('2,000.00')
    expect(sections[1]?.textContent).toContain('1,000.00')
  })

  it('says how many entries and what they come to', async () => {
    renderScreen(<DayBook />, { bridge: bridgeReturning(book()) })
    expect(await screen.findByText(/3 entries, 3,000.00 in total/)).toBeInTheDocument()
  })

  it('counts one entry in the singular', async () => {
    renderScreen(<DayBook />, {
      bridge: bridgeReturning(
        book({
          days: [
            {
              date: '2026-04-01',
              entries: [entry({ id: 'a', date: '2026-04-01' })],
              total: '1000.00',
            },
          ],
          entryCount: 1,
          total: '1000.00',
        }),
      ),
    })

    expect(await screen.findByText(/1 entry, 1,000.00 in total/)).toBeInTheDocument()
  })

  it('shows each line against its account, on its own side', async () => {
    renderScreen(<DayBook />, { bridge: bridgeReturning(book()) })

    const bank = (await screen.findAllByText('Bank Account'))[0]?.closest('tr')
    const figures = [...(bank?.querySelectorAll('td.ledger-table__figure') ?? [])].map(
      (cell) => cell.textContent,
    )
    /* A debit in the debit column and nothing at all in the credit one. */
    expect(figures).toEqual(['1,000.00', ''])
  })

  /*
   * A reversed entry shown as ordinary reads as a duplicate — the same figures twice,
   * with nothing saying why.
   */
  it('marks an entry that has been reversed, and the reversal itself', async () => {
    renderScreen(<DayBook />, {
      bridge: bridgeReturning(
        book({
          days: [
            {
              date: '2026-04-01',
              entries: [
                entry({ id: 'a', date: '2026-04-01', reversedByEntryId: 'b' }),
                entry({ id: 'b', date: '2026-04-01', reversesEntryId: 'a' }),
              ],
              total: '2000.00',
            },
          ],
          entryCount: 2,
          total: '2000.00',
        }),
      ),
    })

    const original = (await screen.findByText(/JV-a/)).closest('tr')
    expect(original?.textContent).toContain('reversed')

    const reversal = screen.getByText(/JV-b/).closest('tr')
    expect(reversal?.textContent).toContain('a reversal')
  })

  it('sends the range the user applied', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<DayBook />, { bridge: bridgeReturning(book()) })
    await screen.findByText(/JV-a/)

    await user.type(screen.getByLabelText('From'), '2026-04-01')
    await user.type(screen.getByLabelText('To'), '2026-04-30')
    expect(bridge.callsTo('reports:dayBook')).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(bridge.callsTo('reports:dayBook')).toHaveLength(2))
    expect(bridge.lastCallTo('reports:dayBook')?.args[0]).toEqual({
      fromDate: '2026-04-01',
      toDate: '2026-04-30',
    })
  })

  it('says the range is empty rather than drawing nothing', async () => {
    renderScreen(<DayBook />, {
      bridge: bridgeReturning(
        book({
          days: [],
          entryCount: 0,
          total: '0.00',
          fromDate: '2026-04-01',
          toDate: '2026-04-30',
        }),
      ),
    })

    expect(await screen.findByText('Nothing has been posted yet')).toBeInTheDocument()
    expect(
      screen.getByText(/1 Apr 2026 to 30 Apr 2026 — and no entry falls in it/),
    ).toBeInTheDocument()
  })

  it('shows a failure from main instead of an empty book', async () => {
    renderScreen(<DayBook />, {
      bridge: {
        reports: {
          dayBook: () =>
            Promise.resolve({
              ok: false,
              error: { code: 'NO_COMPANY_OPEN', message: 'Open a company first.' },
            }),
        },
      },
    })

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText(/JV-/)).toBeNull()
  })
})

/** `within` is imported for the figure assertions above; this keeps it honest. */
describe('the entry table', () => {
  it('names the entry and its narration in one heading', async () => {
    renderScreen(<DayBook />, { bridge: bridgeReturning(book()) })

    const heading = (await screen.findByText(/JV-a/)).closest('tr')
    expect(within(heading as HTMLElement).getByText(/JV-a · A sale/)).toBeInTheDocument()
  })
})
