/*
 * Items, rendered.
 *
 * `filterItems`, `unitOptions`, `accountOptions`, `itemErrorField` and the labels are
 * covered as pure functions next door. What is covered only here is the screen around
 * them, and above all WHAT CROSSED THE BRIDGE — because two of the three things this
 * screen has to get right are invisible in the DOM:
 *
 *   - a `<select>` whose chosen option is missing falls back to its first one, so an item
 *     measured in an archived unit can DRAW correctly while sending something else;
 *   - the regime rewrites a classification code on the way in, so a field that kept what
 *     was typed shows a value the books do not hold and looks perfectly fine.
 *
 * `units.list` and `ledger.listAccounts` are stubbed in every test here on purpose. The
 * editor's two pickers are fed from them, and the harness fails a test that reaches a
 * channel nothing answers — which is what makes "the picker is fed from units.list" a
 * claim these tests can check rather than assume.
 */

import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JSX } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Route } from '@renderer/lib/routing'
import type {
  Account,
  CreateItemInput,
  Item,
  ItemSummary,
  Result,
  UnitOfMeasure,
  UpdateItemInput,
} from '@shared/dto'
import { renderScreen, screenContext, type BridgeStub } from '../../test/harness'
import { Items } from './Items'

// ---- Fixtures ---------------------------------------------------------------

function summary(over: Partial<ItemSummary> & Pick<ItemSummary, 'name'>): ItemSummary {
  return {
    id: over.name,
    code: null,
    kind: 'goods',
    unitCode: null,
    classificationCode: null,
    taxRatePct: null,
    salePrice: null,
    purchasePrice: null,
    salesAccountId: null,
    purchaseAccountId: null,
    isSold: true,
    isPurchased: false,
    isCharge: false,
    isArchived: false,
    ...over,
  }
}

function full(over: Partial<Item> & Pick<Item, 'name'>): Item {
  return {
    ...summary(over),
    description: null,
    isStockTracked: false,
    reorderLevel: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  }
}

function unit(over: Partial<UnitOfMeasure> & Pick<UnitOfMeasure, 'code'>): UnitOfMeasure {
  return {
    name: over.code,
    decimalPlaces: 3,
    regimeCode: null,
    isArchived: false,
    ...over,
  }
}

function account(over: Partial<Account> & Pick<Account, 'id'>): Account {
  return {
    code: over.id,
    name: over.id,
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

const LIST: ItemSummary[] = [
  summary({
    name: 'Ball bearing 6203',
    code: 'BB-6203',
    unitCode: 'NOS',
    classificationCode: '848210',
    taxRatePct: '18.000',
    salePrice: '100000',
    isPurchased: true,
  }),
  summary({ name: 'Freight', kind: 'service', isCharge: true, isSold: true }),
  summary({ name: 'Old gasket', isArchived: true, isSold: false, isPurchased: true }),
]

const UNITS: UnitOfMeasure[] = [
  unit({ code: 'NOS', name: 'Numbers' }),
  unit({ code: 'KGS', name: 'Kilograms' }),
]

const ACCOUNTS: Account[] = [
  account({ id: 'income', code: '4000', name: 'Income', isGroup: true }),
  account({ id: 'sales', code: '4100', name: 'Sales' }),
  account({
    id: 'purchases',
    code: '5100',
    name: 'Purchases',
    type: 'expense',
    normalBalance: 'debit',
  }),
]

/**
 * The bridge every test starts from.
 *
 * All three channels, always. The editor asks for units and accounts on mount, so a test
 * that leaves either out fails by name in `setup.ts` rather than quietly rendering an
 * error notice and failing on something unrelated.
 */
function bridgeFor(over: BridgeStub = {}): BridgeStub {
  return {
    items: { list: () => Promise.resolve({ ok: true, data: LIST }), ...over.items },
    units: { list: () => Promise.resolve({ ok: true, data: UNITS }), ...over.units },
    ledger: {
      listAccounts: () => Promise.resolve({ ok: true, data: ACCOUNTS }),
      ...over.ledger,
    },
  }
}

const noNavigation = (_to: Route): void => {}

function itemsScreen(navigate: (to: Route) => void = noNavigation): JSX.Element {
  return <Items {...screenContext({ navigate })} />
}

async function rowFor(name: string): Promise<HTMLElement> {
  const cell = await screen.findByRole('button', { name })
  const row = cell.closest('tr')
  if (row === null) throw new Error(`${name} is not in a row`)
  return row
}

// ---- The list ---------------------------------------------------------------

describe('the list', () => {
  it('asks for the items without the archived ones', async () => {
    const { bridge } = renderScreen(itemsScreen(), { bridge: bridgeFor() })

    await screen.findByRole('button', { name: 'Ball bearing 6203' })
    expect(bridge.lastCallTo('items:list')?.args[0]).toEqual({ includeArchived: false })
  })

  /*
   * BOTH PICKER LISTS ARE ASKED FOR WITH THE ARCHIVED ROWS IN, which is the opposite of
   * what a picker wants and is the point. An item may hold a unit or an account retired
   * after it was saved; the editor has to be able to show it, and the option builders —
   * not the query — decide what is offered.
   */
  it('asks for every unit and every account, archived ones included', async () => {
    const { bridge } = renderScreen(itemsScreen(), { bridge: bridgeFor() })

    await screen.findByRole('button', { name: 'Ball bearing 6203' })
    await waitFor(() => {
      expect(bridge.lastCallTo('units:list')?.args[0]).toEqual({ includeArchived: true })
    })
    expect(bridge.lastCallTo('ledger:listAccounts')?.args[0]).toEqual({ includeArchived: true })
  })

  /* By cell. Six of the nine columns hold a short string, and "found somewhere in the
   * row" is found just as happily when two columns have been swapped. */
  it('shows an item by column', async () => {
    renderScreen(itemsScreen(), { bridge: bridgeFor() })

    const cells = within(await rowFor('Ball bearing 6203')).getAllByRole('cell')
    expect(cells[1]).toHaveTextContent('BB-6203')
    expect(cells[2]).toHaveTextContent('Goods')
    expect(cells[3]).toHaveTextContent('Both')
    expect(cells[4]).toHaveTextContent('NOS')
    expect(cells[5]).toHaveTextContent('848210')
  })

  /*
   * The price is written the way the open company's regime writes numbers — the Indian
   * grouping here, from `DEFAULT_REGIME` — rather than by a rule the screen picked. The
   * renderer formats and never computes (CONVENTIONS §1.7).
   */
  it('writes the sale price in the regime’s own grouping', async () => {
    renderScreen(itemsScreen(), { bridge: bridgeFor() })

    const cells = within(await rowFor('Ball bearing 6203')).getAllByRole('cell')
    expect(cells[7]).toHaveTextContent(/^1,00,000\.00$/)
  })

  /* A rate is not money: 0.25% halves to 0.125%, so it carries three places and is shown
   * exactly as main spelled it rather than rounded to a money scale. */
  it('shows the rate as main spelled it, to three places', async () => {
    renderScreen(itemsScreen(), { bridge: bridgeFor() })

    const cells = within(await rowFor('Ball bearing 6203')).getAllByRole('cell')
    expect(cells[6]).toHaveTextContent(/^18\.000%$/)
  })

  /* An item with no SKU, no unit, no classification and no agreed price is ordinary —
   * a dash in each, not four gaps that read as fields somebody forgot. */
  it('says nothing is there rather than leaving a gap', async () => {
    renderScreen(itemsScreen(), { bridge: bridgeFor() })

    const cells = within(await rowFor('Freight')).getAllByRole('cell')
    expect(cells[1]).toHaveTextContent('—')
    expect(cells[4]).toHaveTextContent('—')
    expect(cells[5]).toHaveTextContent('—')
    expect(cells[6]).toHaveTextContent('—')
    expect(cells[7]).toHaveTextContent('—')
  })

  it('marks a charge, and marks an archived item', async () => {
    renderScreen(itemsScreen(), { bridge: bridgeFor() })

    expect(within(await rowFor('Freight')).getAllByRole('cell')[0]).toHaveTextContent('Charge')
    expect(within(await rowFor('Old gasket')).getAllByRole('cell')[0]).toHaveTextContent('Archived')
  })

  it('says which side an item that is bought and not sold is on', async () => {
    renderScreen(itemsScreen(), { bridge: bridgeFor() })

    expect(within(await rowFor('Old gasket')).getAllByRole('cell')[3]).toHaveTextContent(
      'Purchased',
    )
  })

  it('reloads with archived items when asked', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(itemsScreen(), { bridge: bridgeFor() })

    await screen.findByRole('button', { name: 'Ball bearing 6203' })
    await user.click(screen.getByLabelText('Show archived'))

    await waitFor(() => {
      expect(bridge.lastCallTo('items:list')?.args[0]).toEqual({ includeArchived: true })
    })
  })

  it('filters as you type, without asking again', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(itemsScreen(), { bridge: bridgeFor() })

    await screen.findByRole('button', { name: 'Ball bearing 6203' })
    const before = bridge.callsTo('items:list').length

    await user.type(screen.getByPlaceholderText(/Search by name/), '848210')

    expect(screen.queryByRole('button', { name: 'Freight' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ball bearing 6203' })).toBeInTheDocument()
    expect(bridge.callsTo('items:list')).toHaveLength(before)
  })

  it('says so when a search matches nothing', async () => {
    const user = userEvent.setup()
    renderScreen(itemsScreen(), { bridge: bridgeFor() })

    await screen.findByRole('button', { name: 'Freight' })
    await user.type(screen.getByPlaceholderText(/Search by name/), 'zzz')

    expect(await screen.findByText('Nothing matches that')).toBeInTheDocument()
  })

  it('offers a way in when there are no items at all', async () => {
    renderScreen(itemsScreen(), {
      bridge: bridgeFor({ items: { list: () => Promise.resolve({ ok: true, data: [] }) } }),
    })

    expect(await screen.findByText('No items yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add the first item' })).toBeInTheDocument()
  })
})

// ---- Adding -----------------------------------------------------------------

describe('adding', () => {
  const opened = async (over: BridgeStub = {}, navigate = noNavigation) => {
    /*
     * `delay: null` because this dialog is fourteen controls wide and every keystroke
     * re-renders all of them. The default inserts a macrotask between keys, which turns
     * a form-filling test into seconds of scheduling and puts it near the 5s ceiling on
     * a loaded machine. It changes no assertion — `user.type` still resolves only after
     * React has processed every key.
     */
    const user = userEvent.setup({ delay: null })
    const rendered = renderScreen(itemsScreen(navigate), {
      bridge: bridgeFor({
        ...over,
        items: { list: () => Promise.resolve({ ok: true, data: [] }), ...over.items },
      }),
    })
    await screen.findByText('No items yet')
    await user.click(screen.getByRole('button', { name: 'New item' }))
    /* The pickers are fed from two more channels; let both land before anything is
     * typed, or their Selects are still disabled and nothing can be chosen in them. */
    await waitFor(() => {
      expect(screen.getByLabelText('Unit')).toBeEnabled()
      expect(screen.getByLabelText('Sales account')).toBeEnabled()
    })
    return { user, ...rendered }
  }

  /*
   * ONE CONDITION AT A TIME. A form filled in completely and then asserted enabled passes
   * against a screen that checks only the name, and against one that checks only the
   * sides. Each step below moves exactly one of the two.
   */
  it('will not save an item with no name', async () => {
    const { user } = await opened()

    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

    await user.type(screen.getByLabelText('Name'), '   ')
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

    await user.type(screen.getByLabelText('Name'), 'Bearing')
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled()
  })

  /* An item that is neither sold nor bought is refused by the repository and reaches no
   * picker in the application. Saying so in the dialog beats letting somebody fill in
   * fourteen fields and then be told. */
  it('will not let an item be neither sold nor bought, and says why', async () => {
    const { user } = await opened()

    await user.type(screen.getByLabelText('Name'), 'Bearing')
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled()

    await user.click(screen.getByLabelText(/We sell it/))
    expect(await screen.findByText('Which way does this item go?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

    await user.click(screen.getByLabelText(/We buy it/))
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled()
  })

  /*
   * EVERY FIELD `CreateItemInput` CARRIES, ASSERTED AS A WHOLE OBJECT.
   *
   * `objectContaining` is deliberately NOT used: it passes for an editor that sends seven
   * of the fourteen, which is the exact failure this test exists after. The whole payload
   * or nothing.
   */
  it('sends every field the contract carries', async () => {
    const create = vi.fn((input: CreateItemInput) =>
      Promise.resolve({ ok: true as const, data: full({ name: input.name }) }),
    )
    const { user } = await opened({ items: { create } })

    /* Short strings on purpose: every keystroke re-renders a dialog of fourteen
     * controls, and what this test is about is the payload rather than the typing. The
     * spaces around two of them stay, because trimming is part of the payload. */
    await user.type(screen.getByLabelText('Name'), ' Bearing ')
    await user.type(screen.getByLabelText('Item code'), ' BB1 ')
    await user.selectOptions(screen.getByLabelText('Kind'), 'service')
    await user.type(screen.getByLabelText('Description'), 'Deep groove')
    await user.selectOptions(screen.getByLabelText('Unit'), 'KGS')
    await user.type(screen.getByLabelText('HSN / SAC'), '848210')
    await user.type(screen.getByLabelText('Tax rate'), '18')
    await user.type(screen.getByLabelText('Sale price'), '250')
    await user.type(screen.getByLabelText('Purchase price'), '180')
    await user.click(screen.getByLabelText(/We buy it/))
    await user.click(screen.getByLabelText(/It is a charge/))
    await user.selectOptions(screen.getByLabelText('Sales account'), 'sales')
    await user.selectOptions(screen.getByLabelText('Purchase account'), 'purchases')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({
        name: 'Bearing',
        kind: 'service',
        code: 'BB1',
        description: 'Deep groove',
        unitCode: 'KGS',
        classificationCode: '848210',
        taxRatePct: '18',
        salePrice: '250',
        purchasePrice: '180',
        isSold: true,
        isPurchased: true,
        isCharge: true,
        salesAccountId: 'sales',
        purchaseAccountId: 'purchases',
      })
    })
    /* Longer than the 5s default, because driving fourteen controls really does take
     * seconds and a machine under load should not turn that into a red suite. It is a
     * ceiling on this one test, not a change to anybody else's. */
  }, 20_000)

  /*
   * A BLANK BOX CROSSES AS `null`, NEVER AS `''`.
   *
   * Null is what the boundary reads as "there is none", and `expectDecimalString` refuses
   * an empty string outright — so a price box left alone would fail the save on a field
   * the user never touched if this sent what the input holds.
   */
  it('sends a null for every box that was left empty', async () => {
    const create = vi.fn((input: CreateItemInput) =>
      Promise.resolve({ ok: true as const, data: full({ name: input.name }) }),
    )
    const { user } = await opened({ items: { create } })

    await user.type(screen.getByLabelText('Name'), 'Advice')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({
        name: 'Advice',
        kind: 'goods',
        code: null,
        description: null,
        unitCode: null,
        classificationCode: null,
        taxRatePct: null,
        salePrice: null,
        purchasePrice: null,
        isSold: true,
        isPurchased: false,
        isCharge: false,
        salesAccountId: null,
        purchaseAccountId: null,
      })
    })
  })

  /*
   * THE NORMALISATION, END TO END. The regime accepts `8471.30` and stores `847130` — a
   * code kept with its separators would never match the schedule again. So the editor is
   * rebuilt on what main answered, and the field says what the books hold rather than
   * what was typed.
   */
  it('shows the classification code the regime stored, not the one that was typed', async () => {
    const { user } = await opened({
      items: {
        create: () =>
          Promise.resolve({
            ok: true,
            data: full({ name: 'Laptop', classificationCode: '847130' }),
          }),
      },
    })

    await user.type(screen.getByLabelText('Name'), 'Laptop')
    await user.type(screen.getByLabelText('HSN / SAC'), '8471.30')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(screen.getByLabelText('HSN / SAC')).toHaveValue('847130')
    })
  })

  /* The same discipline for money, which the repository normalises: `5000` is stored as
   * `5000.00`, and the renderer never works that out for itself (CONVENTIONS §1.7). */
  it('shows the price the repository stored, not the one that was typed', async () => {
    const { user } = await opened({
      items: {
        create: () =>
          Promise.resolve({ ok: true, data: full({ name: 'Laptop', salePrice: '5000.00' }) }),
      },
    })

    await user.type(screen.getByLabelText('Name'), 'Laptop')
    await user.type(screen.getByLabelText('Sale price'), '5000')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(screen.getByLabelText('Sale price')).toHaveValue('5000.00')
    })
  })

  /*
   * WHETHER A CODE IS REAL IS THE REGIME'S QUESTION, and its answer is a sentence written
   * for the user with the lengths in it. The screen shows that sentence, under the box it
   * is about, and keeps the form — retyping thirteen fields is exactly what somebody who
   * mistyped one digit must not be made to do.
   */
  it('shows the regime’s own refusal under the classification box, and keeps the form', async () => {
    const { user } = await opened({
      items: {
        create: () =>
          Promise.resolve({
            ok: false,
            error: {
              code: 'ITEM_CLASSIFICATION_INVALID',
              message: 'An HSN code has 4, 6 or 8 digits. 847 has 3.',
            },
          }),
      },
    })

    await user.type(screen.getByLabelText('Name'), 'Laptop')
    await user.type(screen.getByLabelText('HSN / SAC'), '847')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    const box = await screen.findByLabelText('HSN / SAC')
    await waitFor(() => {
      expect(box).toHaveAccessibleDescription('An HSN code has 4, 6 or 8 digits. 847 has 3.')
    })
    expect(box).toBeInvalid()
    expect(box).toHaveValue('847')
    expect(screen.getByLabelText('Name')).toHaveValue('Laptop')
  })

  /* A refusal that names no field still has to be read, so it goes to the notice at the
   * top of the dialog and the classification box keeps its hint. */
  it('shows a refusal that names no field at the top of the dialog', async () => {
    const { user } = await opened({
      items: {
        create: () =>
          Promise.resolve({
            ok: false,
            error: { code: 'NO_COMPANY_OPEN', message: 'No company is open.' },
          }),
      },
    })

    await user.type(screen.getByLabelText('Name'), 'Laptop')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(await screen.findByText('No company is open.')).toBeInTheDocument()
    expect(screen.getByLabelText('HSN / SAC')).toHaveAccessibleDescription(/4, 6 or 8 digits/)
  })

  it('does not offer the save twice while one is in flight', async () => {
    let release = (_: Result<Item>): void => {}
    const pending = new Promise<Result<Item>>((resolve) => {
      release = resolve
    })
    const { user } = await opened({ items: { create: () => pending } })

    await user.type(screen.getByLabelText('Name'), 'Laptop')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

    /* Awaiting the promise is not waiting for the screen: what follows it is a React
     * update, and only `act` flushes that. */
    await act(async () => {
      release({ ok: true, data: full({ name: 'Laptop' }) })
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    })
  })
})

// ---- The pickers ------------------------------------------------------------

describe('the unit picker', () => {
  const opened = async (over: BridgeStub = {}, navigate = noNavigation) => {
    const user = userEvent.setup()
    const rendered = renderScreen(itemsScreen(navigate), {
      bridge: bridgeFor({
        ...over,
        items: { list: () => Promise.resolve({ ok: true, data: [] }), ...over.items },
      }),
    })
    await screen.findByText('No items yet')
    await user.click(screen.getByRole('button', { name: 'New item' }))
    return { user, ...rendered }
  }

  it('is filled from units.list, code and name together', async () => {
    await opened()

    const picker = await screen.findByLabelText('Unit')
    await waitFor(() => {
      expect(picker).toBeEnabled()
    })
    expect(within(picker).getByRole('option', { name: 'KGS — Kilograms' })).toBeInTheDocument()
    expect(within(picker).getByRole('option', { name: 'No unit' })).toBeInTheDocument()
  })

  /*
   * THE FIRST STATE OF EVERY NEW COMPANY. `setUpBooks` seeds no units, so the very first
   * item anybody adds is added against an empty table — and an empty dropdown reads as a
   * broken screen rather than as a table nobody has filled in. It says the true thing
   * instead: a unit is optional, so this can be saved without one.
   */
  it('sends the user to the units screen rather than offering an empty dropdown', async () => {
    const navigate = vi.fn()
    const { user } = await opened(
      { units: { list: () => Promise.resolve({ ok: true, data: [] }) } },
      navigate,
    )

    expect(await screen.findByText('No units of measure yet')).toBeInTheDocument()
    expect(screen.queryByLabelText('Unit')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Set up units' }))
    expect(navigate).toHaveBeenCalledWith({
      area: 'workspace',
      screenId: 'units',
      params: {},
    })
  })

  /* And the way out is honest about what it costs: an item does not need a unit, so
   * nothing is lost by saving without one. */
  it('says a unit is optional, so nothing has to be abandoned', async () => {
    await opened({ units: { list: () => Promise.resolve({ ok: true, data: [] }) } })

    expect(await screen.findByText(/save this without a unit and set it later/)).toBeInTheDocument()
  })
})

// ---- Editing ----------------------------------------------------------------

describe('editing', () => {
  const editorFor = async (item: Item, over: BridgeStub = {}) => {
    const user = userEvent.setup()
    const rendered = renderScreen(itemsScreen(), {
      bridge: bridgeFor({
        ...over,
        items: {
          list: () => Promise.resolve({ ok: true, data: [summary(item)] }),
          get: () => Promise.resolve({ ok: true, data: item }),
          ...over.items,
        },
      }),
    })
    /* The editor opens only once `get` has answered, so waiting for the dialog to be
     * open is waiting for the record — waiting for a field is not, because a closed
     * dialog renders its fields too. */
    await user.click(await screen.findByRole('button', { name: item.name }))
    await screen.findByRole('dialog')
    return { user, ...rendered }
  }

  /* The editor is filled from `get`, not from the summary the list holds — the summary
   * carries no description, no purchase price and neither account override. */
  it('reads the whole record before opening', async () => {
    const { bridge } = await editorFor(
      full({
        name: 'Ball bearing 6203',
        description: 'Deep groove, 17mm bore',
        purchasePrice: '180.00',
        salesAccountId: 'sales',
      }),
    )

    expect(screen.getByLabelText('Description')).toHaveValue('Deep groove, 17mm bore')
    expect(screen.getByLabelText('Purchase price')).toHaveValue('180.00')
    expect(screen.getByLabelText('Sales account')).toHaveValue('sales')
    expect(bridge.lastCallTo('items:get')?.args).toEqual(['Ball bearing 6203'])
  })

  it('sends the id and what changed', async () => {
    const update = vi.fn((input: UpdateItemInput) =>
      Promise.resolve({ ok: true as const, data: full({ name: input.name ?? 'x' }) }),
    )
    const { user } = await editorFor(full({ name: 'Ball bearing 6203' }), { items: { update } })

    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'Ball bearing 6204')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'Ball bearing 6203', name: 'Ball bearing 6204' }),
      )
    })
  })

  /*
   * THE FAILURE A RENDERED ASSERTION CANNOT SEE.
   *
   * `DOZ` was archived after this item was saved, and the repository re-checks a unit only
   * when one is SENT — so the item keeps it and the editor must be able to show it. Drop
   * it from the options and the `<select>` falls back to its first one, `No unit`, all on
   * its own: the field would read plausibly and the next save would silently un-measure
   * an item nobody touched. The assertion is therefore on what crossed the bridge.
   */
  it('sends back an archived unit the item already holds, rather than losing it', async () => {
    const update = vi.fn((input: UpdateItemInput) =>
      Promise.resolve({ ok: true as const, data: full({ name: input.name ?? 'x' }) }),
    )
    const { user } = await editorFor(full({ name: 'Egg tray', unitCode: 'DOZ' }), {
      items: { update },
      units: {
        list: () =>
          Promise.resolve({
            ok: true,
            data: [unit({ code: 'NOS', name: 'Numbers' }), unit({ code: 'DOZ', isArchived: true })],
          }),
      },
    })

    await waitFor(() => {
      expect(screen.getByLabelText('Unit')).toHaveValue('DOZ')
    })
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ unitCode: 'DOZ' }))
    })
  })

  /* The same trap one control over: an account archived after the item was saved. */
  it('sends back an archived account the item already names', async () => {
    const update = vi.fn((input: UpdateItemInput) =>
      Promise.resolve({ ok: true as const, data: full({ name: input.name ?? 'x' }) }),
    )
    const { user } = await editorFor(full({ name: 'Ball bearing 6203', salesAccountId: 'old' }), {
      items: { update },
      ledger: {
        listAccounts: () =>
          Promise.resolve({
            ok: true,
            data: [
              ...ACCOUNTS,
              account({ id: 'old', code: '4200', name: 'Discontinued', isArchived: true }),
            ],
          }),
      },
    })

    await waitFor(() => {
      expect(screen.getByLabelText('Sales account')).toHaveValue('old')
    })
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ salesAccountId: 'old' }))
    })
  })

  /*
   * THE NORMALISATION AGAIN, ON THE PATH WHERE NOTHING ELSE WOULD REBUILD THE FORM.
   *
   * Creating an item moves the editor from "a new one" to a record, so it is rebuilt for
   * that reason whatever the code does. Editing one does not move it anywhere — same
   * item, same id — which makes this the case where a form that quietly kept what was
   * typed goes unnoticed. `8471.30` is accepted and stored as `847130`, and the box has
   * to say what the books hold rather than what the user spelled.
   */
  it('shows the stored classification code after an existing item is saved', async () => {
    const { user } = await editorFor(full({ name: 'Laptop', classificationCode: '84713010' }), {
      items: {
        update: () =>
          Promise.resolve({
            ok: true,
            data: full({ name: 'Laptop', classificationCode: '847130' }),
          }),
      },
    })

    await user.clear(screen.getByLabelText('HSN / SAC'))
    await user.type(screen.getByLabelText('HSN / SAC'), '8471.30')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(screen.getByLabelText('HSN / SAC')).toHaveValue('847130')
    })
  })

  /* A group totals its children and holds no figures of its own; the repository refuses
   * one with `ITEM_ACCOUNT_IS_GROUP`. A picker that offers it offers an answer that
   * cannot be saved. */
  it('never offers a group in an account picker', async () => {
    await editorFor(full({ name: 'Ball bearing 6203' }))

    const picker = await screen.findByLabelText('Sales account')
    await waitFor(() => {
      expect(picker).toBeEnabled()
    })
    expect(within(picker).getByRole('option', { name: '4100 — Sales' })).toBeInTheDocument()
    expect(within(picker).queryByRole('option', { name: '4000 — Income' })).toBeNull()
  })

  /* Deleted in another window since the list was drawn. An editor over a record that is
   * gone can only fail on save, so the list is re-read instead. */
  it('re-reads the list rather than opening an editor over an item that has gone', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(itemsScreen(), {
      bridge: bridgeFor({ items: { get: () => Promise.resolve({ ok: true, data: null }) } }),
    })

    await user.click(await screen.findByRole('button', { name: 'Freight' }))

    await waitFor(() => {
      expect(bridge.callsTo('items:list').length).toBeGreaterThan(1)
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

// ---- Archiving and deleting -------------------------------------------------

describe('archiving', () => {
  it('archives and says what is left alone', async () => {
    const user = userEvent.setup()
    const archive = vi.fn(() =>
      Promise.resolve({ ok: true as const, data: full({ name: 'Freight', isArchived: true }) }),
    )
    renderScreen(itemsScreen(), { bridge: bridgeFor({ items: { archive } }) })

    const row = await rowFor('Freight')
    await user.click(within(row).getByRole('button', { name: 'Archive' }))

    await waitFor(() => {
      expect(archive).toHaveBeenCalledWith({ id: 'Freight', archived: true })
    })
    expect(
      await screen.findByText(/Every document it is already on is untouched/),
    ).toBeInTheDocument()
  })

  it('offers to restore one that is already archived', async () => {
    const user = userEvent.setup()
    const archive = vi.fn(() =>
      Promise.resolve({ ok: true as const, data: full({ name: 'Old gasket' }) }),
    )
    renderScreen(itemsScreen(), { bridge: bridgeFor({ items: { archive } }) })

    const row = await rowFor('Old gasket')
    await user.click(within(row).getByRole('button', { name: 'Restore' }))

    await waitFor(() => {
      expect(archive).toHaveBeenCalledWith({ id: 'Old gasket', archived: false })
    })
  })
})

describe('deleting', () => {
  const confirming = async (over: BridgeStub = {}) => {
    const user = userEvent.setup()
    const rendered = renderScreen(itemsScreen(), { bridge: bridgeFor(over) })
    const row = await rowFor('Freight')
    await user.click(within(row).getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog')
    return { user, dialog, ...rendered }
  }

  it('deletes by id and says nothing was lost', async () => {
    const remove = vi.fn(() => Promise.resolve({ ok: true as const, data: undefined }))
    const { user, dialog } = await confirming({ items: { delete: remove } })

    expect(within(dialog).getByText('Delete Freight?')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith('Freight')
    })
    expect(await screen.findByText(/It was on no document/)).toBeInTheDocument()
  })

  /* The refusal is the answer to the question this dialog asked, and it says what to do
   * instead. It stays on screen where the question was, rather than sliding past. */
  it('keeps the refusal on screen, with the way out still offered', async () => {
    const { user, dialog } = await confirming({
      items: {
        delete: () =>
          Promise.resolve({
            ok: false,
            error: {
              code: 'ITEM_IN_USE',
              message: 'Freight appears on a document. Archive it instead.',
            },
          }),
      },
    })

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    expect(
      await within(dialog).findByText('Freight appears on a document. Archive it instead.'),
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Keep it' })).toBeInTheDocument()
  })
})
