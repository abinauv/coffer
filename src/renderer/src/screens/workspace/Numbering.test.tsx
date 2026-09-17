/*
 * The numbering screen, rendered.
 *
 * `groupSeriesByKind`, `kindsWithoutSeries`, `previewYearFor` and the rest are covered as
 * pure functions next door. What is covered only here is WHAT CROSSED THE BRIDGE, and
 * three things in particular:
 *
 *   1. THE PREVIEW'S `fiscalYearLabel`. It is nullable and required — null means this
 *      number is in no fiscal year, an absent field means a screen forgot — so the
 *      assertions are `toEqual` against the whole input, which fails on an omitted field
 *      because `undefined` is not `null`.
 *   2. THE LIST IS ASKED FOR WITH ARCHIVED ROWS INCLUDED. `seedDefaults` skips a kind
 *      that has an archived series, so "which kinds are missing" must be asked of every
 *      row; a screen that loaded only the live ones would offer a repair that creates
 *      nothing.
 *   3. THE REPAIR ON A SHORT LIST, both halves — the call, and what the screen says
 *      afterwards, including the case where nothing was missing.
 *
 * THE FIXTURE DISAGREES WITH THE EXPECTED OUTPUT WHEREVER ORDER MATTERS. Receipts are
 * listed before sales invoices, so table order cannot be read off the list, and the
 * default sales-invoice series is the SECOND of its kind — a screen that badged row one
 * would otherwise pass.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { AccountingPeriod, NumberPreview, NumberingSeriesRecord, Result } from '@shared/dto'
import { renderScreen, type BridgeStub } from '../../test/harness'
import { NUMBERED_KINDS } from '../lib/numbering-view'
import { Numbering } from './Numbering'

function series(
  over: Partial<NumberingSeriesRecord> & Pick<NumberingSeriesRecord, 'id' | 'kind' | 'label'>,
): NumberingSeriesRecord {
  return {
    prefix: over.id.toUpperCase(),
    suffix: '',
    separator: '/',
    includeFiscalYear: true,
    width: 4,
    resetOn: 'fiscal-year',
    isDefault: false,
    isArchived: false,
    hasIssued: false,
    ...over,
  }
}

/* The three kinds this file makes assertions about. Everything else is filled in below so
 * that the repair prompt stays out of the way except in the tests that are about it. */
const NAMED_KINDS = ['receipt', 'sales-invoice', 'quotation']

function filler(): NumberingSeriesRecord[] {
  return NUMBERED_KINDS.filter((kind) => !NAMED_KINDS.includes(kind.kind)).map((kind) =>
    series({ id: kind.kind, kind: kind.kind, label: `${kind.label} series`, isDefault: true }),
  )
}

/*
 * Receipts first, and the DEFAULT sales-invoice series second of its kind.
 *
 * 'Old book' is archived and still carries the default flag, which is a real row: 0007's
 * partial unique index leaves archived rows out of the one-default-per-kind rule, so the
 * flag survives as a record of what the series once was.
 */
const SERIES: NumberingSeriesRecord[] = [
  series({ id: 'rct', kind: 'receipt', label: 'Receipts', prefix: 'RCT', isDefault: true }),
  series({ id: 'exp', kind: 'sales-invoice', label: 'Export', prefix: 'EXP', width: 3 }),
  series({ id: 'inv', kind: 'sales-invoice', label: 'Main', prefix: 'INV', isDefault: true }),
  series({
    id: 'old',
    kind: 'sales-invoice',
    label: 'Old book',
    prefix: 'OLD',
    isDefault: true,
    isArchived: true,
  }),
  /* Neither prints the year nor restarts on it: the series whose preview is asked for in
   * NO fiscal year. A quotation offers a price and is not a supply. */
  series({
    id: 'qtn',
    kind: 'quotation',
    label: 'Quotes',
    prefix: 'QTN',
    includeFiscalYear: false,
    resetOn: 'never',
    isDefault: true,
  }),
  ...filler(),
]

/** A pre-0015 company file: every kind but the two a refund needs. */
const PRE_0015: NumberingSeriesRecord[] = SERIES.filter(
  (record) => record.kind !== 'refund' && record.kind !== 'refund-received',
)

/** What main answers for each series. Distinct per series, so a row cannot borrow one. */
const PREVIEWS: Record<string, { preview: string; nextSequence: number }> = {
  inv: { preview: 'INV/2026-27/0042', nextSequence: 42 },
  exp: { preview: 'EXP/2026-27/007', nextSequence: 7 },
  qtn: { preview: 'QTN0113', nextSequence: 113 },
  rct: { preview: 'RCT/2026-27/0009', nextSequence: 9 },
}

/*
 * One financial year, so the year the screen starts on is the same whatever the clock
 * says: `currentFiscalYear` either finds today inside it or falls back to the latest, and
 * with one year those are the same answer.
 */
function periods(label = '2026-27', from = '2026-04-01', to = '2027-03-31'): AccountingPeriod[] {
  return [
    {
      id: `${label}-1`,
      fiscalYearLabel: label,
      index: 1,
      label: 'Apr',
      startDate: from,
      endDate: to,
      status: 'open',
      closedAt: null,
    },
  ]
}

function ok<T>(data: T): Promise<Result<T>> {
  return Promise.resolve({ ok: true, data })
}

function previewOf(input: { seriesId: string; fiscalYearLabel: string | null }): NumberPreview {
  const answer = PREVIEWS[input.seriesId] ?? { preview: `${input.seriesId}/0001`, nextSequence: 1 }
  return { seriesId: input.seriesId, fiscalYearLabel: input.fiscalYearLabel, ...answer }
}

interface BridgeOptions {
  list?: readonly NumberingSeriesRecord[]
  periods?: AccountingPeriod[]
  numbering?: NonNullable<BridgeStub['numbering']>
}

/** The bridge every test starts from. `numbering` replaces or adds methods. */
function bridgeWith({
  list = SERIES,
  periods: given = periods(),
  numbering = {},
}: BridgeOptions = {}): BridgeStub {
  return {
    ledger: { listPeriods: () => ok(given) },
    numbering: {
      list: () => ok([...list]),
      /* Stubbed deliberately: the harness fails a test on a channel nothing answers, and
       * every render of this screen previews every series it was given. */
      preview: (input) => ok(previewOf(input)),
      ...numbering,
    },
  }
}

async function rowFor(label: string): Promise<HTMLElement> {
  const button = await screen.findByRole('button', { name: label })
  const row = button.closest('tr')
  if (row === null) throw new Error(`${label} is not in a row`)
  return row
}

/** The cells of a series row, by position. Never "somewhere in the row". */
const SERIES_CELL = {
  label: 0,
  prefix: 1,
  width: 2,
  nextNumber: 3,
  nextSequence: 4,
  isDefault: 5,
} as const

interface Recorded {
  callsTo: (channel: string) => readonly { args: readonly unknown[] }[]
}

function previewInputs(bridge: Recorded): unknown[] {
  return bridge.callsTo('numbering:preview').map((call) => call.args[0])
}

/*
 * The previews are a second round trip after the list, so a row exists before its number
 * does. Waiting for the row is not waiting for the screen to have finished changing.
 */
async function previewsSettled(bridge: Recorded, count: number): Promise<void> {
  await waitFor(() => expect(bridge.callsTo('numbering:preview')).toHaveLength(count))
}

describe('the list', () => {
  /*
   * ARCHIVED ROWS ARE LOADED AND HIDDEN, NOT LEFT UNLOADED. `seedDefaultSeries` skips a
   * kind that already has a series without asking whether it is archived, so the question
   * "what would the repair create" can only be answered over every row.
   */
  it('asks for every series, archived ones included', async () => {
    const { bridge } = renderScreen(<Numbering />, { bridge: bridgeWith() })

    await rowFor('Main')
    expect(bridge.lastCallTo('numbering:list')?.args[0]).toEqual({ includeArchived: true })
  })

  /*
   * The nine headings, by value and in order. The fixture lists receipts first, so this
   * cannot pass by echoing the list, and the words are the kind tables' own — 'Refunds
   * paid', not 'Refunds'.
   */
  it('groups the series under every numbered kind, in the kind tables order', async () => {
    renderScreen(<Numbering />, { bridge: bridgeWith() })

    await rowFor('Main')
    const headings = [
      ...screen.getByRole('table').querySelectorAll('tbody th[scope="rowgroup"]'),
    ].map((heading) => heading.textContent)

    expect(headings).toEqual([
      'Sales invoices',
      'Quotations',
      'Credit notes',
      'Purchase bills',
      'Debit notes',
      'Receipts',
      'Payments',
      'Refunds paid',
      'Refunds received',
    ])
  })

  it('shows the shape of a series and the number it would hand out next', async () => {
    const { bridge } = renderScreen(<Numbering />, { bridge: bridgeWith() })

    await rowFor('Main')
    await previewsSettled(bridge, SERIES.length)

    const cells = within(await rowFor('Main')).getAllByRole('cell')
    expect(cells[SERIES_CELL.prefix]).toHaveTextContent('INV')
    expect(cells[SERIES_CELL.width]).toHaveTextContent('4')
    expect(cells[SERIES_CELL.nextNumber]).toHaveTextContent('INV/2026-27/0042')
    expect(cells[SERIES_CELL.nextSequence]).toHaveTextContent('42')
  })

  /* Its own preview, not its neighbour's — the two sales-invoice series sit next to each
   * other and a screen keying the map wrongly would show one number twice. */
  it('gives each series its own next number', async () => {
    const { bridge } = renderScreen(<Numbering />, { bridge: bridgeWith() })

    await rowFor('Export')
    await previewsSettled(bridge, SERIES.length)

    const cells = within(await rowFor('Export')).getAllByRole('cell')
    expect(cells[SERIES_CELL.nextNumber]).toHaveTextContent('EXP/2026-27/007')
    expect(cells[SERIES_CELL.nextSequence]).toHaveTextContent('7')
  })

  /*
   * THE DEFAULT IS THE SECOND SALES-INVOICE SERIES IN THE FIXTURE. A screen that badged
   * the first row of each group would pass every other assertion in this file.
   */
  it('marks which series a new document of that kind takes', async () => {
    renderScreen(<Numbering />, { bridge: bridgeWith() })

    const isDefault = (row: HTMLElement): HTMLElement =>
      within(row).getAllByRole('cell')[SERIES_CELL.isDefault] as HTMLElement

    expect(isDefault(await rowFor('Main'))).toHaveTextContent('Default')
    expect(isDefault(await rowFor('Export'))).toHaveTextContent('')
  })

  it('shows a series with no prefix as a dash rather than an empty cell', async () => {
    renderScreen(<Numbering />, {
      bridge: bridgeWith({
        list: [series({ id: 'bare', kind: 'sales-invoice', label: 'Bare', prefix: '' })],
      }),
    })

    const cells = within(await rowFor('Bare')).getAllByRole('cell')
    expect(cells[SERIES_CELL.prefix]).toHaveTextContent('—')
  })

  it('says the counter only ever moves forward, which is why nothing here resets one', async () => {
    renderScreen(<Numbering />, { bridge: bridgeWith() })

    expect(await screen.findByText(/never given back/)).toBeInTheDocument()
  })

  /*
   * A dash, not a number nobody composed. The row beside it is asserted too: without it
   * this would pass against a screen whose previews had simply not arrived yet, which is
   * the same cell content for a different reason.
   */
  it('shows a dash where main refused to say, rather than showing a guess', async () => {
    const { bridge } = renderScreen(<Numbering />, {
      bridge: bridgeWith({
        numbering: {
          preview: (input) =>
            input.seriesId === 'qtn'
              ? Promise.resolve<Result<NumberPreview>>({
                  ok: false,
                  error: {
                    code: 'FISCAL_YEAR_REQUIRED',
                    message: 'Quotes is numbered by financial year.',
                  },
                })
              : ok(previewOf(input)),
        },
      }),
    })

    await rowFor('Quotes')
    await previewsSettled(bridge, SERIES.length)

    const answered = within(await rowFor('Main')).getAllByRole('cell')
    expect(answered[SERIES_CELL.nextNumber]).toHaveTextContent('INV/2026-27/0042')

    const refused = within(await rowFor('Quotes')).getAllByRole('cell')
    expect(refused[SERIES_CELL.nextNumber]).toHaveTextContent('—')
  })

  it('says so when the series cannot be read at all', async () => {
    renderScreen(<Numbering />, {
      bridge: {
        ledger: { listPeriods: () => ok(periods()) },
        numbering: {
          list: () =>
            Promise.resolve<Result<NumberingSeriesRecord[]>>({
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

describe('archived series', () => {
  it('hides them until they are asked for, without asking main again', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Numbering />, { bridge: bridgeWith() })

    await rowFor('Main')
    expect(screen.queryByRole('button', { name: 'Old book' })).toBeNull()

    await user.click(screen.getByLabelText('Show archived'))

    expect(await screen.findByRole('button', { name: 'Old book' })).toBeInTheDocument()
    /* Every row was loaded at the start, so showing them is a filter and not a fetch. */
    expect(bridge.callsTo('numbering:list')).toHaveLength(1)
  })

  /*
   * AN ARCHIVED SERIES THAT STILL CARRIES THE DEFAULT FLAG IS NOT THE DEFAULT.
   * `defaultSeriesFor` will not have it and 0007's index leaves it out, so badging it
   * would tell somebody a new invoice takes a number from a series that numbers nothing.
   */
  it('does not call an archived series the default, however it is flagged', async () => {
    const user = userEvent.setup()
    renderScreen(<Numbering />, { bridge: bridgeWith() })

    await rowFor('Main')
    await user.click(screen.getByLabelText('Show archived'))

    const cells = within(await rowFor('Old book')).getAllByRole('cell')
    expect(cells[SERIES_CELL.label]).toHaveTextContent('Archived')
    expect(cells[SERIES_CELL.isDefault]).toHaveTextContent('')
  })

  it('archives a series through the channel that does it', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Numbering />, {
      bridge: bridgeWith({
        numbering: {
          archive: () =>
            ok(series({ id: 'exp', kind: 'sales-invoice', label: 'Export', isArchived: true })),
        },
      }),
    })

    const row = await rowFor('Export')
    await user.click(within(row).getByRole('button', { name: 'Archive' }))

    await waitFor(() => expect(bridge.callsTo('numbering:archive')).toHaveLength(1))
    expect(bridge.lastCallTo('numbering:archive')?.args[0]).toEqual({ id: 'exp', archived: true })
  })

  it('moves the default without opening the editor for one tick box', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Numbering />, {
      bridge: bridgeWith({
        numbering: {
          update: () =>
            ok(series({ id: 'exp', kind: 'sales-invoice', label: 'Export', isDefault: true })),
        },
      }),
    })

    const row = await rowFor('Export')
    await user.click(within(row).getByRole('button', { name: 'Make default' }))

    await waitFor(() => expect(bridge.callsTo('numbering:update')).toHaveLength(1))
    expect(bridge.lastCallTo('numbering:update')?.args[0]).toEqual({ id: 'exp', isDefault: true })
  })
})

describe('the preview', () => {
  /*
   * THE ASSERTION THIS FILE EXISTS FOR. `fiscalYearLabel` is nullable AND required: a
   * series that prints the year or restarts on it gets the year, and one that does
   * neither gets an explicit null. `toEqual` against the whole input is what makes the
   * second half meaningful — an omitted field is `undefined`, which is not `null`, so a
   * screen that simply forgot to send it fails here.
   */
  it('sends the financial year for a series numbered by it', async () => {
    const { bridge } = renderScreen(<Numbering />, { bridge: bridgeWith() })

    await previewsSettled(bridge, SERIES.length)
    expect(previewInputs(bridge)).toContainEqual({ seriesId: 'inv', fiscalYearLabel: '2026-27' })
  })

  it('sends an explicit null for a series that is in no financial year', async () => {
    const { bridge } = renderScreen(<Numbering />, { bridge: bridgeWith() })

    await previewsSettled(bridge, SERIES.length)
    expect(previewInputs(bridge)).toContainEqual({ seriesId: 'qtn', fiscalYearLabel: null })
  })

  it('draws the numbers in the year that was chosen', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Numbering />, {
      bridge: bridgeWith({
        periods: [
          ...periods('2026-27', '2026-04-01', '2027-03-31'),
          ...periods('2025-26', '2025-04-01', '2026-03-31'),
        ],
      }),
    })

    await rowFor('Main')
    await previewsSettled(bridge, SERIES.length)

    await user.selectOptions(screen.getByLabelText('Preview in'), '2025-26')
    await previewsSettled(bridge, SERIES.length * 2)

    expect(previewInputs(bridge)).toContainEqual({ seriesId: 'inv', fiscalYearLabel: '2025-26' })
    /*
     * THE YEAR CHANGED AND THE SERIES IN NO YEAR IS STILL IN NO YEAR. Both rounds are
     * asserted: a screen that sent the picked year to every series would send it here on
     * the second round, and only the second.
     */
    expect(
      previewInputs(bridge).filter((input) => (input as { seriesId: string }).seriesId === 'qtn'),
    ).toEqual([
      { seriesId: 'qtn', fiscalYearLabel: null },
      { seriesId: 'qtn', fiscalYearLabel: null },
    ])
  })

  it('offers no year to preview in when the books keep none', async () => {
    const { bridge } = renderScreen(<Numbering />, { bridge: bridgeWith({ periods: [] }) })

    await rowFor('Main')
    await previewsSettled(bridge, SERIES.length)
    expect(screen.queryByLabelText('Preview in')).toBeNull()
    /* Still asked, and still with the field present. Main answers FISCAL_YEAR_REQUIRED,
     * which is a sentence naming the series rather than a blank. */
    expect(previewInputs(bridge)).toContainEqual({ seriesId: 'inv', fiscalYearLabel: null })
  })
})

describe('adding a series', () => {
  /*
   * ONE FIELD AT A TIME. Filling both and asserting once would pass against a screen that
   * only ever checked the label — and the kind is the one that cannot be corrected
   * afterwards, because a series cannot be moved.
   */
  it('will not add one that has a label but no kind', async () => {
    const user = userEvent.setup()
    renderScreen(<Numbering />, { bridge: bridgeWith() })

    await rowFor('Main')
    await user.click(screen.getByRole('button', { name: 'New series' }))

    const add = screen.getByRole('button', { name: 'Add series' })
    expect(add).toBeDisabled()

    await user.type(screen.getByLabelText('Label'), 'Export')
    expect(add).toBeDisabled()

    await user.selectOptions(screen.getByLabelText('Numbers'), 'credit-note')
    expect(add).toBeEnabled()
  })

  /*
   * THE SAME TWO FIELDS, FILLED IN THE OTHER ORDER, and it is not a duplicate — it is the
   * only test in which the LABEL is the thing standing in the way. Filled label-first, the
   * kind is empty at every step until the last, so the label check is never the sole
   * refusal and deleting it changes no result. Measured: the mutation that dropped
   * `label.trim() !== ''` survived the whole suite until this was written (CONVENTIONS §6,
   * "ask of each condition what it ALONE excludes").
   */
  it('will not add one that has a kind but no label', async () => {
    const user = userEvent.setup()
    renderScreen(<Numbering />, { bridge: bridgeWith() })

    await rowFor('Main')
    await user.click(screen.getByRole('button', { name: 'New series' }))

    const add = screen.getByRole('button', { name: 'Add series' })
    await user.selectOptions(screen.getByLabelText('Numbers'), 'credit-note')
    expect(add).toBeDisabled()

    await user.type(screen.getByLabelText('Label'), 'Export')
    expect(add).toBeEnabled()
  })

  /* A label of spaces is no label. Main refuses it with `SERIES_LABEL_REQUIRED`; there is
   * nothing to send, so it does not get that far. */
  it('will not add one whose label is only spaces', async () => {
    const user = userEvent.setup()
    renderScreen(<Numbering />, { bridge: bridgeWith() })

    await rowFor('Main')
    await user.click(screen.getByRole('button', { name: 'New series' }))

    await user.selectOptions(screen.getByLabelText('Numbers'), 'credit-note')
    await user.type(screen.getByLabelText('Label'), '   ')
    expect(screen.getByRole('button', { name: 'Add series' })).toBeDisabled()
  })

  it('offers every numbered kind, in the kind tables words', async () => {
    const user = userEvent.setup()
    renderScreen(<Numbering />, { bridge: bridgeWith() })

    await rowFor('Main')
    await user.click(screen.getByRole('button', { name: 'New series' }))

    const picker = screen.getByLabelText('Numbers') as HTMLSelectElement
    expect([...picker.options].map((option) => option.text)).toEqual([
      'Choose one',
      'Sales invoice',
      'Quotation',
      'Credit note',
      'Purchase bill',
      'Debit note',
      'Receipt',
      'Payment',
      'Refund paid',
      'Refund received',
    ])
  })

  /*
   * WHAT CROSSED THE BRIDGE, WHOLE. `resetOn` is absent because the picker was left on
   * "whatever suits this kind" — main reads the kind's own `resetsYearly`, and a screen
   * that guessed here would give a quotation series a rule it should not have. `width` is
   * absent for the same reason: blank says nothing about it.
   */
  it('sends the whole shape, and says nothing about what it was not asked', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Numbering />, {
      bridge: bridgeWith({
        numbering: {
          create: () => ok(series({ id: 'new', kind: 'credit-note', label: 'Export' })),
        },
      }),
    })

    await rowFor('Main')
    await user.click(screen.getByRole('button', { name: 'New series' }))

    await user.type(screen.getByLabelText('Label'), '  Export  ')
    await user.selectOptions(screen.getByLabelText('Numbers'), 'credit-note')
    await user.type(screen.getByLabelText('Prefix'), 'CRN')
    await user.type(screen.getByLabelText('Separator'), '-')
    await user.click(screen.getByLabelText('Show the financial year in the number'))
    await user.click(screen.getByLabelText('Take new numbers of this kind from this series'))
    await user.click(screen.getByRole('button', { name: 'Add series' }))

    await waitFor(() => expect(bridge.callsTo('numbering:create')).toHaveLength(1))
    expect(bridge.lastCallTo('numbering:create')?.args[0]).toEqual({
      kind: 'credit-note',
      label: 'Export',
      prefix: 'CRN',
      separator: '-',
      suffix: '',
      includeFiscalYear: true,
      isDefault: true,
      width: undefined,
      resetOn: undefined,
    })
  })

  it('sends a width when one was typed', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Numbering />, {
      bridge: bridgeWith({
        numbering: { create: () => ok(series({ id: 'new', kind: 'payment', label: 'Cash' })) },
      }),
    })

    await rowFor('Main')
    await user.click(screen.getByRole('button', { name: 'New series' }))
    await user.type(screen.getByLabelText('Label'), 'Cash')
    await user.selectOptions(screen.getByLabelText('Numbers'), 'payment')
    await user.type(screen.getByLabelText('Width'), '6')
    await user.click(screen.getByRole('button', { name: 'Add series' }))

    await waitFor(() => expect(bridge.callsTo('numbering:create')).toHaveLength(1))
    const sent = bridge.lastCallTo('numbering:create')?.args[0] as { width?: number }
    expect(sent.width).toBe(6)
  })

  /* A parse, not a rule: there is nothing to send. The RANGE is main's, and a width of
   * -1 goes across the bridge to be refused in main's own words. */
  it('will not send a width that is not a number', async () => {
    const user = userEvent.setup()
    renderScreen(<Numbering />, { bridge: bridgeWith() })

    await rowFor('Main')
    await user.click(screen.getByRole('button', { name: 'New series' }))
    await user.type(screen.getByLabelText('Label'), 'Cash')
    await user.selectOptions(screen.getByLabelText('Numbers'), 'payment')
    await user.type(screen.getByLabelText('Width'), 'four')

    expect(screen.getByRole('button', { name: 'Add series' })).toBeDisabled()
    expect(screen.getByText('A width is a whole number of digits, or nothing.')).toBeInTheDocument()
  })
})

describe('editing a series', () => {
  /*
   * THE WHOLE RECORD IS POSTED BACK, WITH THE ID AND WITHOUT THE KIND. `shapeChangesIn`
   * compares by value, so re-sending what a series already has is not a change to it —
   * which is what keeps the default flag editable on a series that has already numbered
   * something. `kind` is absent because a series cannot be moved, and `toEqual` fails on
   * an extra key.
   */
  it('sends every shape field with the id, and never the kind', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Numbering />, {
      bridge: bridgeWith({
        numbering: {
          update: () =>
            ok(series({ id: 'inv', kind: 'sales-invoice', label: 'Main', isDefault: true })),
        },
      }),
    })

    await user.click(await screen.findByRole('button', { name: 'Main' }))
    await user.clear(screen.getByLabelText('Prefix'))
    await user.type(screen.getByLabelText('Prefix'), 'TAX')
    await user.click(screen.getByRole('button', { name: 'Save series' }))

    await waitFor(() => expect(bridge.callsTo('numbering:update')).toHaveLength(1))
    expect(bridge.lastCallTo('numbering:update')?.args[0]).toEqual({
      id: 'inv',
      label: 'Main',
      prefix: 'TAX',
      separator: '/',
      suffix: '',
      includeFiscalYear: true,
      width: 4,
      resetOn: 'fiscal-year',
      isDefault: true,
    })
  })

  /* The kind is a fact once the series exists, not a picker — `UpdateNumberingSeriesInput`
   * has no field for it, and the word comes off the kind table. */
  it('states the kind instead of offering to change it', async () => {
    const user = userEvent.setup()
    renderScreen(<Numbering />, { bridge: bridgeWith() })

    await user.click(await screen.findByRole('button', { name: 'Main' }))

    expect(screen.getByText(/Numbers sales invoice\./)).toBeInTheDocument()
    expect(screen.queryByLabelText('Numbers')).toBeNull()
  })

  /* The abstract shape made concrete, which is the point of the whole screen. */
  it('shows what the series produces next while it is being edited', async () => {
    const user = userEvent.setup()
    renderScreen(<Numbering />, { bridge: bridgeWith() })

    await user.click(await screen.findByRole('button', { name: 'Main' }))

    expect(screen.getByText(/INV\/2026-27\/0042 — in 2026-27/)).toBeInTheDocument()
  })

  /*
   * MAIN'S SENTENCE, INTACT. `SERIES_IN_USE` names the series and says what to do instead;
   * a screen that paraphrased it would drop the only advice in it.
   */
  it("shows main's refusal to change a series that has already numbered something", async () => {
    const user = userEvent.setup()
    renderScreen(<Numbering />, {
      bridge: bridgeWith({
        list: [
          series({
            id: 'inv',
            kind: 'sales-invoice',
            label: 'Main',
            hasIssued: true,
            isDefault: true,
          }),
        ],
        numbering: {
          update: () =>
            Promise.resolve<Result<NumberingSeriesRecord>>({
              ok: false,
              error: {
                code: 'SERIES_IN_USE',
                message:
                  'Main has already numbered a document, so its shape is fixed. Create a new series instead.',
              },
            }),
        },
      }),
    })

    await user.click(await screen.findByRole('button', { name: 'Main' }))
    await user.clear(screen.getByLabelText('Prefix'))
    await user.type(screen.getByLabelText('Prefix'), 'TAX')
    await user.click(screen.getByRole('button', { name: 'Save series' }))

    expect(await screen.findByText(/Create a new series instead/)).toBeInTheDocument()
  })

  it('leaves the form as the user left it when the save was refused', async () => {
    const user = userEvent.setup()
    renderScreen(<Numbering />, {
      bridge: bridgeWith({
        numbering: {
          update: () =>
            Promise.resolve<Result<NumberingSeriesRecord>>({
              ok: false,
              error: { code: 'SERIES_LABEL_TAKEN', message: 'Sales invoice already has Export.' },
            }),
        },
      }),
    })

    await user.click(await screen.findByRole('button', { name: 'Main' }))
    await user.clear(screen.getByLabelText('Label'))
    await user.type(screen.getByLabelText('Label'), 'Export')
    await user.click(screen.getByRole('button', { name: 'Save series' }))

    await screen.findByText(/already has Export/)
    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Export')
  })

  /* "Saved" says nothing. The number is what the user came to see, and it is asked of
   * main after the save rather than assembled here. */
  it('reports the number the series will now hand out', async () => {
    const user = userEvent.setup()
    renderScreen(<Numbering />, {
      bridge: bridgeWith({
        numbering: {
          update: () =>
            ok(series({ id: 'inv', kind: 'sales-invoice', label: 'Main', isDefault: true })),
        },
      }),
    })

    await user.click(await screen.findByRole('button', { name: 'Main' }))
    await user.click(screen.getByRole('button', { name: 'Save series' }))

    expect(
      await screen.findByText('The next sales invoice on Main will be INV/2026-27/0042.'),
    ).toBeInTheDocument()
  })
})

describe('a kind that cannot be numbered', () => {
  /* A series sits there, configured, and every issue fails with "no series configured".
   * It is the state nobody thinks to look at, so it gets a sentence. */
  it('says when a kind has series but none of them is the default', async () => {
    renderScreen(<Numbering />, {
      bridge: bridgeWith({
        list: [
          ...SERIES.filter((record) => record.kind !== 'payment'),
          series({ id: 'pay', kind: 'payment', label: 'Payments', isDefault: false }),
        ],
      }),
    })

    await rowFor('Payments')
    expect(
      screen.getByText(/No default — nothing of this kind can be numbered/),
    ).toBeInTheDocument()
  })

  it('says when a kind has nothing live to number with', async () => {
    renderScreen(<Numbering />, {
      bridge: bridgeWith({
        list: [
          ...SERIES.filter((record) => record.kind !== 'payment'),
          series({ id: 'pay', kind: 'payment', label: 'Payments', isArchived: true }),
        ],
      }),
    })

    await rowFor('Main')
    expect(
      screen.getByText('No series in use — nothing of this kind can be numbered.'),
    ).toBeInTheDocument()
  })
})

describe('the repair', () => {
  /*
   * THE PRE-0015 COMPANY FILE. Two kinds have no series, so nothing of either can be
   * recorded, and until now there was no way to fix it from inside the app.
   */
  it('says which kinds have none, in the kind tables words', async () => {
    renderScreen(<Numbering />, { bridge: bridgeWith({ list: PRE_0015 }) })

    expect(await screen.findByText('Some kinds have no series')).toBeInTheDocument()
    expect(screen.getByText(/Refunds paid and Refunds received have none/)).toBeInTheDocument()
  })

  it('calls seedDefaults with nothing, and reads the list again afterwards', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Numbering />, {
      bridge: bridgeWith({ list: PRE_0015, numbering: { seedDefaults: () => ok(2) } }),
    })

    await screen.findByText('Some kinds have no series')
    await user.click(screen.getByRole('button', { name: 'Create the missing series' }))

    await waitFor(() => expect(bridge.callsTo('numbering:seedDefaults')).toHaveLength(1))
    expect(bridge.lastCallTo('numbering:seedDefaults')?.args).toEqual([])
    await waitFor(() => expect(bridge.callsTo('numbering:list')).toHaveLength(2))
  })

  it('says how many it created', async () => {
    const user = userEvent.setup()
    renderScreen(<Numbering />, {
      bridge: bridgeWith({ list: PRE_0015, numbering: { seedDefaults: () => ok(2) } }),
    })

    await screen.findByText('Some kinds have no series')
    await user.click(screen.getByRole('button', { name: 'Create the missing series' }))

    expect(await screen.findByText('Added 2 series. Every kind now has one.')).toBeInTheDocument()
  })

  /*
   * NOUGHT IS THE ORDINARY ANSWER AND IT IS A SUCCESS. The repair is still offered on
   * complete books — a file can be short a kind for a reason nothing on this screen can
   * see — and running it says plainly that nothing was missing.
   */
  it('is offered on complete books, and says nothing was missing', async () => {
    const user = userEvent.setup()
    renderScreen(<Numbering />, {
      bridge: bridgeWith({ numbering: { seedDefaults: () => ok(0) } }),
    })

    await rowFor('Main')
    expect(screen.queryByText('Some kinds have no series')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Create the missing series' }))

    expect(
      await screen.findByText(
        'Nothing was missing. Every kind already had a series, so nothing was added and nothing changed.',
      ),
    ).toBeInTheDocument()
  })

  /*
   * A KIND WHOSE ONLY SERIES IS ARCHIVED IS NOT MISSING. `seedDefaultSeries` skips it, so
   * the repair would create nothing — promising a fix here would be a lie, and the
   * report afterwards would be nought against a prompt that said two kinds were broken.
   * The kind still cannot be numbered, and the group says so in its own words.
   */
  it('does not promise a repair for a kind whose only series was archived', async () => {
    renderScreen(<Numbering />, {
      bridge: bridgeWith({
        list: [
          ...SERIES.filter((record) => record.kind !== 'refund'),
          series({ id: 'ref', kind: 'refund', label: 'Refunds', isArchived: true }),
        ],
      }),
    })

    await rowFor('Main')
    expect(screen.queryByText('Some kinds have no series')).toBeNull()
    expect(
      screen.getByText('No series in use — nothing of this kind can be numbered.'),
    ).toBeInTheDocument()
  })

  it('shows the reason main gave when the repair itself failed', async () => {
    const user = userEvent.setup()
    renderScreen(<Numbering />, {
      bridge: bridgeWith({
        list: PRE_0015,
        numbering: {
          seedDefaults: () =>
            Promise.resolve<Result<number>>({
              ok: false,
              error: { code: 'NO_COMPANY_OPEN', message: 'Open a company first.' },
            }),
        },
      }),
    })

    await screen.findByText('Some kinds have no series')
    await user.click(screen.getByRole('button', { name: 'Create the missing series' }))

    expect(await screen.findByText(/Open a company first/)).toBeInTheDocument()
  })
})
