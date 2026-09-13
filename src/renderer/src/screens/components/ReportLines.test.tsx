/*
 * The statement table and the range toolbar, rendered.
 *
 * NOTHING HERE COMPUTES ANYTHING, and that is the property under test. Every figure
 * arrives as a decimal string already totalled by main (CONVENTIONS §1.7), so the
 * fixtures below are built to DISAGREE with anything a renderer might work out for
 * itself: the lines do not add up to the total, the rows are not in code order, and the
 * amounts are not the ones a naive re-derivation would produce. A table that recomputed
 * would be visibly wrong here and invisible against a tidy fixture.
 *
 * FIGURES ARE ASSERTED BY POSITION — the second cell of the row, never "somewhere in the
 * row". A figure found somewhere in a row is found just as happily after the two columns
 * are swapped.
 *
 * THE SIGN IS NEVER TOUCHED. A figure keeps the sign it arrived with; where one is
 * subtracted to reach a total the HEADING carries the word (CONVENTIONS §1.7). This
 * table adds "(contra)" beside a negative rather than flipping it, and both halves of
 * that are asserted.
 */

import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { RegimeDescription, ReportLine, ReportSection } from '@shared/dto'
import { DEFAULT_REGIME, renderScreen } from '../../test/harness'
import { RangeToolbar, ReportSectionTable } from './ReportLines'

function line(code: string, name: string, amount: string, depth = 0, isGroup = false): ReportLine {
  return { accountId: code, code, name, depth, isGroup, amount }
}

function section(type: ReportSection['type'], lines: ReportLine[], total: string): ReportSection {
  return { type, lines, total }
}

/*
 * Deliberately out of order and deliberately not adding up.
 *
 * The codes descend, so a table that sorted them would put 1100 first and be caught;
 * the total is not the sum of the lines, so a table that added them up would print
 * something other than what main sent.
 */
function unsortedSection(): ReportSection {
  return section(
    'asset',
    [
      line('5200', 'Trade Receivables', '820000.00', 0, true),
      line('1100', 'Petty Cash', '1450.50', 1),
      line('3050', 'Deposits Paid', '-15000.00', 2),
    ],
    '999999.99',
  )
}

/** The row whose first cell holds this code. */
function rowFor(code: string): HTMLElement {
  const cell = screen.getByText(new RegExp(`^${code} · `))
  const row = cell.closest('tr')
  if (row === null) throw new Error(`No row around the cell for ${code}`)
  return row
}

/** The figure CELL — the second column — of a row. Never the row. */
function figureCellOf(row: HTMLElement): HTMLElement {
  const cell = row.querySelectorAll('td')[1]
  if (!(cell instanceof HTMLElement)) throw new Error('That row has no second cell')
  return cell
}

/** The name cell's span, which is where the indent lives. */
function nameSpanOf(row: HTMLElement): HTMLElement {
  const span = row.querySelectorAll('td')[0]?.querySelector('span')
  if (!(span instanceof HTMLElement)) throw new Error('That row has no name cell')
  return span
}

/** The foot's total row, which is a different row from every line above it. */
function totalRow(): HTMLElement {
  const row = document.querySelector('tfoot tr')
  if (!(row instanceof HTMLElement)) throw new Error('The table has no foot')
  return row
}

describe('ReportSectionTable', () => {
  it('takes its heading from the section type, in the words a balance sheet uses', () => {
    /* 'Equity and reserves', not 'Equity'. The block carries the unclosed profit as
     * well as the capital accounts, and the profit line is the one a reader will look
     * for under a heading they did not expect. */
    renderScreen(
      <ReportSectionTable
        section={section('equity', [line('3100', 'Capital', '100000.00')], '100000.00')}
      />,
    )

    expect(screen.getByRole('columnheader', { name: 'Equity and reserves' })).toBeInTheDocument()
  })

  it('lets the screen override the heading', () => {
    renderScreen(
      <ReportSectionTable
        section={section('equity', [], '0.00')}
        heading="Equity, reserves and the year to date"
      />,
    )

    expect(
      screen.getByRole('columnheader', { name: 'Equity, reserves and the year to date' }),
    ).toBeInTheDocument()
  })

  it('names the total after whatever the heading turned out to be', () => {
    /* The default total label is built from the heading, so an overridden heading has
     * to carry through to it — otherwise the table says "Equity and reserves" at the
     * top and "Total equity" at the foot, about the same column of figures. */
    renderScreen(
      <ReportSectionTable section={section('equity', [line('3100', 'Capital', '5.00')], '5.00')} />,
    )

    expect(within(totalRow()).getByText('Total equity and reserves')).toBeInTheDocument()
  })

  it('lets the screen name the total line itself', () => {
    renderScreen(
      <ReportSectionTable
        section={unsortedSection()}
        heading="Assets"
        totalLabel="Total assets employed"
      />,
    )

    expect(within(totalRow()).getByText('Total assets employed')).toBeInTheDocument()
  })

  it('prints the rows in the order main sent them', () => {
    renderScreen(<ReportSectionTable section={unsortedSection()} />)

    /* Descending codes. A table that sorted by code, by name or by amount would put
     * these three in a different order and every one of those orders differs from
     * this one. */
    const rows = [...document.querySelectorAll('tbody tr')].map(
      (row) => row.querySelector('td')?.textContent,
    )
    expect(rows).toEqual(['5200 · Trade Receivables', '1100 · Petty Cash', '3050 · Deposits Paid'])
  })

  it('puts each account against its own figure, in the figure column', () => {
    renderScreen(<ReportSectionTable section={unsortedSection()} />)

    /* Scoped to the CELL. Each of these three amounts is unique, so a row-wide search
     * would pass with the columns swapped. */
    expect(figureCellOf(rowFor('5200'))).toHaveTextContent('8,20,000.00')
    expect(figureCellOf(rowFor('1100'))).toHaveTextContent('1,450.50')
  })

  it('prints the total main sent, not the sum of the rows above it', () => {
    renderScreen(<ReportSectionTable section={unsortedSection()} />)

    /* The lines come to 806,450.50 and the total says 999,999.99. The renderer never
     * computes money — it displays what main sent — so the disagreement is the test.
     * A table that added the column up would print the wrong one of these two. */
    expect(figureCellOf(totalRow())).toHaveTextContent('9,99,999.99')
  })

  it('keeps a negative negative, and gives the reader the word for it', () => {
    renderScreen(<ReportSectionTable section={unsortedSection()} />)

    const cell = figureCellOf(rowFor('3050'))
    /* Both halves. The sign is not flipped — flipping a sign is arithmetic, and a
     * screen that does it in one place and not another contradicts itself — and the
     * bare minus is not left to be read as a formatting quirk either. */
    expect(cell.textContent).toBe('-15,000.00 (contra)')
  })

  it('leaves a positive figure alone', () => {
    renderScreen(<ReportSectionTable section={unsortedSection()} />)

    /* The other side of the same condition: no word where none is warranted. */
    expect(figureCellOf(rowFor('1100')).textContent).toBe('1,450.50')
  })

  it('marks a negative TOTAL, not only the negative lines above it', () => {
    /*
     * A whole section in credit. The foot was bare until 0016 — every line above it
     * carried the word and the one figure a reader quotes did not.
     *
     * THE TOTAL DISAGREES WITH THE LINES ON PURPOSE, in size and not only in sign: at
     * -60,000.00 against a -15,000.00 line, a foot reading the wrong cell is visible.
     * And `toBe` on the whole cell rather than `toHaveTextContent`, because
     * `toHaveTextContent('15,000.00')` is a substring match that '-15,000.00 (contra)'
     * satisfies — the sign and the word are both what is under test here.
     */
    renderScreen(
      <ReportSectionTable
        section={section(
          'asset',
          [line('1210', 'Bank Account', '-15000.00'), line('1100', 'Petty Cash', '250.00', 1)],
          '-60000.00',
        )}
        totalLabel="Total assets"
      />,
    )

    expect(figureCellOf(totalRow()).textContent).toBe('-60,000.00 (contra)')
    /* And the line beside it, so this cannot pass by marking every cell in the table. */
    expect(figureCellOf(rowFor('1210')).textContent).toBe('-15,000.00 (contra)')
    expect(figureCellOf(rowFor('1100')).textContent).toBe('250.00')
  })

  it('leaves a positive total bare, and does so on the same rule as a line', () => {
    /* The other side of the condition on the FOOT specifically. Without it, marking
     * every total passes the test above and the word means nothing. The line here is
     * negative and the total is not, so a foot that read the line's sign would be
     * caught as well. */
    renderScreen(
      <ReportSectionTable
        section={section('asset', [line('3050', 'Deposits Paid', '-15000.00')], '82000.00')}
        totalLabel="Total assets"
      />,
    )

    expect(figureCellOf(totalRow()).textContent).toBe('82,000.00')
    expect(figureCellOf(rowFor('3050')).textContent).toBe('-15,000.00 (contra)')
  })

  it('does not call a total written as a negative zero a contra balance', () => {
    /* The foot takes the same reading of '-0.00' as the lines do. An emptied section
     * foots at zero and is not an overdraft. */
    renderScreen(
      <ReportSectionTable
        section={section('liability', [], '-0.00')}
        totalLabel="Total liabilities"
      />,
    )

    expect(figureCellOf(totalRow()).textContent).toBe('-0.00')
  })

  it('does not call a zero written with a minus sign a contra balance', () => {
    /* Main writes an exact decimal string and '-0.00' is one of the spellings zero can
     * arrive in. It is not an overdraft, and calling it one would put the word beside
     * every emptied account on the sheet. */
    renderScreen(
      <ReportSectionTable
        section={section('asset', [line('1900', 'Suspense', '-0.00')], '-0.00')}
      />,
    )

    expect(figureCellOf(rowFor('1900')).textContent).toBe('-0.00')
  })

  it('takes the grouping from the regime rather than choosing one', () => {
    /* The same figure under two regimes. A hard-coded grouping — the bug this batch
     * removed — renders 12,34,567.50 for everyone, which is right in India and wrong
     * everywhere else. */
    const flat: RegimeDescription = {
      ...DEFAULT_REGIME,
      id: 'test-flat',
      numberFormat: { ...DEFAULT_REGIME.numberFormat, groupSizes: [3] },
    }

    const indian = renderScreen(
      <ReportSectionTable
        section={section('asset', [line('1210', 'Bank', '1234567.50')], '1234567.50')}
      />,
    )
    expect(figureCellOf(rowFor('1210'))).toHaveTextContent('12,34,567.50')
    indian.unmount()

    renderScreen(
      <ReportSectionTable
        section={section('asset', [line('1210', 'Bank', '1234567.50')], '1234567.50')}
      />,
      { regime: flat },
    )
    expect(figureCellOf(rowFor('1210'))).toHaveTextContent('1,234,567.50')
  })

  it('marks the figure column so the digits line up down it', () => {
    renderScreen(<ReportSectionTable section={unsortedSection()} />)

    /* `.ledger-table__figure` is what carries `text-align: end` and `tabular-nums` in
     * screens.css — the stylesheet is not loaded in a test, so the hook is what can be
     * asserted. Checked on a line AND on the total: they are rendered by two different
     * pieces of markup and the foot is the one that gets forgotten. */
    expect(figureCellOf(rowFor('5200')).className).toContain('ledger-table__figure')
    expect(figureCellOf(totalRow()).className).toContain('ledger-table__figure')
  })

  it('indents a child under its parent, in proportion to its depth', () => {
    renderScreen(<ReportSectionTable section={unsortedSection()} />)

    /* Three depths. A single indented row would satisfy "not zero" while the tree was
     * flat below it. */
    expect(nameSpanOf(rowFor('5200')).style.paddingInlineStart).toBe('0rem')
    expect(nameSpanOf(rowFor('1100')).style.paddingInlineStart).toBe('1.25rem')
    expect(nameSpanOf(rowFor('3050')).style.paddingInlineStart).toBe('2.5rem')
  })

  it('marks a group row, and only a group row', () => {
    renderScreen(<ReportSectionTable section={unsortedSection()} />)

    expect(rowFor('5200').className).toContain('ledger-table__row--group')
    expect(rowFor('1100').className ?? '').not.toContain('ledger-table__row--group')
  })

  it('says a section is empty rather than drawing an empty table', () => {
    renderScreen(
      <ReportSectionTable
        section={section('liability', [], '0.00')}
        totalLabel="Total liabilities"
      />,
    )

    expect(screen.getByText('Nothing has been posted here.')).toBeInTheDocument()
    /* One row in the body — the sentence — and not a single account row behind it. */
    const body = document.querySelector('tbody')
    expect(within(body as HTMLElement).getAllByRole('row')).toHaveLength(1)
  })

  it('still foots an empty section, so the reader can see the nothing', () => {
    renderScreen(
      <ReportSectionTable
        section={section('liability', [], '0.00')}
        totalLabel="Total liabilities"
      />,
    )

    /* A section with no lines still has a total, and a statement whose foot vanished
     * would silently drop a nil line off the face of the sheet. */
    expect(within(totalRow()).getByText('Total liabilities')).toBeInTheDocument()
    expect(figureCellOf(totalRow())).toHaveTextContent('0.00')
  })

  it('keeps the one line and the total apart when a section has only one account', () => {
    /* The values disagree on purpose. In real data they would be equal, and equal
     * values make the two assertions below indistinguishable — either could be reading
     * the other's cell and the test would pass. */
    renderScreen(
      <ReportSectionTable
        section={section('income', [line('4100', 'Sales', '61000.00')], '77000.00')}
        totalLabel="Total income"
      />,
    )

    expect(figureCellOf(rowFor('4100'))).toHaveTextContent('61,000.00')
    expect(figureCellOf(totalRow())).toHaveTextContent('77,000.00')
    expect(within(document.querySelector('tbody') as HTMLElement).getAllByRole('row')).toHaveLength(
      1,
    )
  })

  it('shows a figure it cannot vouch for as it arrived', () => {
    /* A bad state handed over directly. `formatAmount` returns anything that is not a
     * decimal string unchanged, so a value main never produced looks wrong rather than
     * being quietly rendered as something plausible. */
    renderScreen(
      <ReportSectionTable section={section('asset', [line('1210', 'Bank', 'n/a')], '0.00')} />,
    )

    expect(figureCellOf(rowFor('1210')).textContent).toBe('n/a')
  })
})

describe('RangeToolbar', () => {
  it('shows the dates it was given, by their labels', () => {
    /* Dates the real clock cannot be on, and two different ones — a toolbar that wired
     * both fields to the same value would pass against a single date. */
    renderScreen(
      <RangeToolbar
        fromDate="2031-04-01"
        toDate="2032-03-31"
        onFromChange={() => {}}
        onToChange={() => {}}
        onApply={() => {}}
        onClear={() => {}}
      />,
    )

    expect(screen.getByLabelText('From')).toHaveValue('2031-04-01')
    expect(screen.getByLabelText('To')).toHaveValue('2032-03-31')
  })

  it('does not re-run the query while a date is being typed', async () => {
    const user = userEvent.setup()
    const onApply = vi.fn()
    const onFromChange = vi.fn()

    renderScreen(
      <RangeToolbar
        fromDate=""
        toDate=""
        onFromChange={onFromChange}
        onToChange={() => {}}
        onApply={onApply}
        onClear={() => {}}
      />,
    )

    await user.type(screen.getByLabelText('From'), '2031-04-01')

    /* Eight keystrokes for one date. A query per keystroke fires eight times and shows
     * four wrong reports on the way to the right one. */
    expect(onFromChange).toHaveBeenCalled()
    expect(onApply).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onApply).toHaveBeenCalledTimes(1)
  })

  it('reports each field to its own handler', async () => {
    const user = userEvent.setup()
    const onFromChange = vi.fn()
    const onToChange = vi.fn()

    renderScreen(
      <RangeToolbar
        fromDate=""
        toDate=""
        onFromChange={onFromChange}
        onToChange={onToChange}
        onApply={() => {}}
        onClear={() => {}}
      />,
    )

    await user.type(screen.getByLabelText('To'), '2032-03-31')

    expect(onToChange).toHaveBeenLastCalledWith('2032-03-31')
    /* Crossed handlers would put the end of a range in its beginning, and a report
     * drawn from 2032-03-31 to nothing reads plausibly and is empty. */
    expect(onFromChange).not.toHaveBeenCalled()
  })

  it('offers Clear as soon as either end of the range is set', async () => {
    const user = userEvent.setup()
    const onClear = vi.fn()

    const props = {
      onFromChange: () => {},
      onToChange: () => {},
      onApply: () => {},
      onClear,
    }

    /* Both halves of `fromDate !== '' || toDate !== ''`, each on its own. With only one
     * of the two ever set in a fixture, deleting either side of the `||` changes
     * nothing and no test can see it. */
    const fromOnly = renderScreen(<RangeToolbar fromDate="2031-04-01" toDate="" {...props} />)
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument()
    fromOnly.unmount()

    renderScreen(<RangeToolbar fromDate="" toDate="2032-03-31" {...props} />)
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('offers no Clear when there is no range to clear', () => {
    renderScreen(
      <RangeToolbar
        fromDate=""
        toDate=""
        onFromChange={() => {}}
        onToChange={() => {}}
        onApply={() => {}}
        onClear={() => {}}
      />,
    )

    /* Apply is still there — the button that vanished is the one with nothing to do. */
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
  })

  it('holds Apply while a query is already running', async () => {
    const user = userEvent.setup()
    const onApply = vi.fn()

    renderScreen(
      <RangeToolbar
        fromDate="2031-04-01"
        toDate="2032-03-31"
        onFromChange={() => {}}
        onToChange={() => {}}
        onApply={onApply}
        onClear={() => {}}
        isBusy
      />,
    )

    const apply = screen.getByRole('button', { name: 'Apply' })
    expect(apply).toBeDisabled()
    expect(apply).toHaveAttribute('aria-busy', 'true')

    await user.click(apply)
    expect(onApply).not.toHaveBeenCalled()
  })

  it('is ready to run unless it was told a query is in flight', () => {
    renderScreen(
      <RangeToolbar
        fromDate=""
        toDate=""
        onFromChange={() => {}}
        onToChange={() => {}}
        onApply={() => {}}
        onClear={() => {}}
      />,
    )

    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled()
  })
})
