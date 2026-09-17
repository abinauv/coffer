/*
 * Units of measure, rendered.
 *
 * `filterUnits`, `unitErrorField`, `unitCodeHint` and the decimal-places table are
 * covered as pure functions next door. What is covered only here is the screen around
 * them, and above all WHAT CROSSED THE BRIDGE: that every method naming a unit sends a
 * CODE where every other master record sends an id, that a save carries the fields it
 * showed, and that what is drawn afterwards is what main answered rather than what was
 * typed.
 *
 * THESE BOOKS SEED NO UNITS. `setUpBooks` writes none at all, so the empty list is the
 * ordinary first state of this screen and not an edge case.
 */

import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { CreateUnitInput, Result, UnitOfMeasure, UpdateUnitInput } from '@shared/dto'
import { renderScreen, type BridgeStub } from '../../test/harness'
import { Units } from './Units'

function unit(over: Partial<UnitOfMeasure> & Pick<UnitOfMeasure, 'code'>): UnitOfMeasure {
  return {
    name: over.code,
    decimalPlaces: 3,
    regimeCode: null,
    isArchived: false,
    ...over,
  }
}

const LIST: UnitOfMeasure[] = [
  unit({ code: 'BUNDLE', name: 'Bundles of ten', decimalPlaces: 0 }),
  unit({ code: 'KGS', name: 'Kilograms', decimalPlaces: 3, regimeCode: 'KGS' }),
  unit({ code: 'SQFT', name: 'Square feet', decimalPlaces: 2, isArchived: true }),
]

/** The bridge every list test starts from. `over` replaces or adds unit methods. */
function listing(over: NonNullable<BridgeStub['units']> = {}): BridgeStub {
  return {
    units: { list: () => Promise.resolve({ ok: true, data: LIST }), ...over },
  }
}

async function rowFor(code: string): Promise<HTMLElement> {
  const cell = await screen.findByRole('button', { name: code })
  const row = cell.closest('tr')
  if (row === null) throw new Error(`${code} is not in a row`)
  return row
}

describe('the list', () => {
  it('asks for the units, without the archived ones', async () => {
    const { bridge } = renderScreen(<Units />, { bridge: listing() })

    await screen.findByRole('button', { name: 'KGS' })
    expect(bridge.lastCallTo('units:list')?.args[0]).toEqual({ includeArchived: false })
  })

  /* By cell, because three of the five columns hold short strings that would each be
   * found "somewhere in the row" if two columns were swapped. */
  it('shows a unit by column', async () => {
    renderScreen(<Units />, { bridge: listing() })

    const cells = within(await rowFor('KGS')).getAllByRole('cell')
    expect(cells[1]).toHaveTextContent('Kilograms')
    expect(cells[2]).toHaveTextContent(/^3$/)
    expect(cells[3]).toHaveTextContent('KGS')
  })

  /* Nothing is mapped to a return code until Phase 5, so a dash rather than a gap that
   * reads as a field somebody forgot to fill in. */
  it('says a unit reports as nothing rather than leaving the cell empty', async () => {
    renderScreen(<Units />, { bridge: listing() })

    expect(within(await rowFor('BUNDLE')).getAllByRole('cell')[3]).toHaveTextContent('—')
  })

  /* Zero is a real answer and the interesting one — half a box is not a quantity — so it
   * has to render as 0 rather than be dropped by a truthiness test. */
  it('shows a unit that permits no decimals at all', async () => {
    renderScreen(<Units />, { bridge: listing() })

    expect(within(await rowFor('BUNDLE')).getAllByRole('cell')[2]).toHaveTextContent(/^0$/)
  })

  it('marks an archived unit', async () => {
    renderScreen(<Units />, { bridge: listing() })

    expect(within(await rowFor('SQFT')).getAllByRole('cell')[0]).toHaveTextContent('Archived')
  })

  it('reloads with archived units when asked', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Units />, { bridge: listing() })

    await screen.findByRole('button', { name: 'KGS' })
    await user.click(screen.getByLabelText('Show archived'))

    await waitFor(() => {
      expect(bridge.lastCallTo('units:list')?.args[0]).toEqual({ includeArchived: true })
    })
  })

  it('filters as you type, without asking again', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Units />, { bridge: listing() })

    await screen.findByRole('button', { name: 'KGS' })
    const before = bridge.callsTo('units:list').length

    await user.type(screen.getByPlaceholderText(/Search by code/), 'bundle')

    expect(screen.queryByRole('button', { name: 'KGS' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'BUNDLE' })).toBeInTheDocument()
    expect(bridge.callsTo('units:list')).toHaveLength(before)
  })

  it('says so when a search matches nothing', async () => {
    const user = userEvent.setup()
    renderScreen(<Units />, { bridge: listing() })

    await screen.findByRole('button', { name: 'KGS' })
    await user.type(screen.getByPlaceholderText(/Search by code/), 'zzz')

    expect(await screen.findByText('Nothing matches that')).toBeInTheDocument()
  })

  /*
   * The ordinary first state of a new company, because `setUpBooks` seeds no units. It
   * has to read as "nobody has filled this in yet" and not as "something went wrong",
   * and it has to say that the emptiness was a decision.
   */
  it('explains an empty list rather than showing a bare table', async () => {
    renderScreen(<Units />, {
      bridge: listing({ list: () => Promise.resolve({ ok: true, data: [] }) }),
    })

    expect(await screen.findByText('No units yet')).toBeInTheDocument()
    expect(screen.getByText(/Nothing was seeded for you, on purpose/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add the first unit' })).toBeInTheDocument()
  })
})

// ---- Adding ----------------------------------------------------------------

describe('adding', () => {
  const opened = async (over: NonNullable<BridgeStub['units']> = {}) => {
    const user = userEvent.setup()
    const rendered = renderScreen(<Units />, {
      bridge: listing({ list: () => Promise.resolve({ ok: true, data: [] }), ...over }),
    })
    await screen.findByText('No units yet')
    await user.click(screen.getByRole('button', { name: 'New unit' }))
    return { user, ...rendered }
  }

  /*
   * ONE FIELD AT A TIME, AND IN BOTH ORDERS. Filling both and then asserting the button
   * is enabled passes against a screen that checks only the code — and against one that
   * checks only the name. Each half below is the only thing standing between the form and
   * a save at the moment it is asserted.
   */
  it('will not save a unit with no code', async () => {
    const { user } = await opened()

    expect(screen.getByRole('button', { name: 'Add unit' })).toBeDisabled()

    await user.type(screen.getByLabelText('Name'), 'Kilograms')
    expect(screen.getByRole('button', { name: 'Add unit' })).toBeDisabled()

    await user.type(screen.getByLabelText('Code'), 'KGS')
    expect(screen.getByRole('button', { name: 'Add unit' })).toBeEnabled()
  })

  it('will not save a unit with no name', async () => {
    const { user } = await opened()

    await user.type(screen.getByLabelText('Code'), 'KGS')
    expect(screen.getByRole('button', { name: 'Add unit' })).toBeDisabled()

    await user.type(screen.getByLabelText('Name'), '   ')
    expect(screen.getByRole('button', { name: 'Add unit' })).toBeDisabled()

    await user.type(screen.getByLabelText('Name'), 'Kilograms')
    expect(screen.getByRole('button', { name: 'Add unit' })).toBeEnabled()
  })

  /*
   * CUSTOM UNITS ARE THE POINT. Rewriting anything outside four units to `Nos` is a
   * design CONVENTIONS §9 refuses. `BUNDLE` has to
   * reach the boundary spelled exactly as it was typed.
   */
  it('sends a unit nobody has heard of, unchanged', async () => {
    const create = vi.fn((input: CreateUnitInput) =>
      Promise.resolve({ ok: true as const, data: unit({ code: input.code, name: input.name }) }),
    )
    const { user } = await opened({ create })

    await user.type(screen.getByLabelText('Code'), '  BUNDLE  ')
    await user.type(screen.getByLabelText('Name'), 'Bundles of ten')
    await user.click(screen.getByRole('button', { name: 'Add unit' }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({
        code: 'BUNDLE',
        name: 'Bundles of ten',
        decimalPlaces: 3,
        regimeCode: null,
      })
    })
  })

  /* Blank is "not mapped yet" and crosses as null, not as an empty code. */
  it('sends the decimal places that were chosen, and a null return code', async () => {
    const create = vi.fn((input: CreateUnitInput) =>
      Promise.resolve({ ok: true as const, data: unit({ code: input.code }) }),
    )
    const { user } = await opened({ create })

    await user.type(screen.getByLabelText('Code'), 'BOX')
    await user.type(screen.getByLabelText('Name'), 'Boxes')
    await user.selectOptions(screen.getByLabelText('Decimal places'), '0')
    await user.click(screen.getByRole('button', { name: 'Add unit' }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ decimalPlaces: 0, regimeCode: null }),
      )
    })
  })

  it('sends a return code when one was given', async () => {
    const create = vi.fn((input: CreateUnitInput) =>
      Promise.resolve({ ok: true as const, data: unit({ code: input.code }) }),
    )
    const { user } = await opened({ create })

    await user.type(screen.getByLabelText('Code'), 'BAGS')
    await user.type(screen.getByLabelText('Name'), 'Bags')
    await user.type(screen.getByLabelText('Reports as'), ' BAG ')
    await user.click(screen.getByRole('button', { name: 'Add unit' }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ regimeCode: 'BAG' }))
    })
  })

  /*
   * THE CODE IS NORMALISED IN THE MAIN PROCESS, AND THE SCREEN RE-READS IT. `kgs` is
   * trimmed and upper-cased before it is stored, because SQLite's TEXT primary key and
   * the foreign key from an item are both case-sensitive. A form that kept what was typed
   * would say the books hold `kgs`, which they do not — and would send `kgs` again on the
   * next save.
   */
  it('shows the code the books actually stored, not the one that was typed', async () => {
    const { user } = await opened({
      create: () => Promise.resolve({ ok: true, data: unit({ code: 'KGS', name: 'Kilograms' }) }),
    })

    await user.type(screen.getByLabelText('Code'), 'kgs')
    await user.type(screen.getByLabelText('Name'), 'Kilograms')
    await user.click(screen.getByRole('button', { name: 'Add unit' }))

    await waitFor(() => {
      expect(screen.getByLabelText('Code')).toHaveValue('KGS')
    })
    /* And it is now an existing unit, so the box that was editable a moment ago is not. */
    expect(screen.getByLabelText('Code')).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: 'Save unit' })).toBeInTheDocument()
  })

  /*
   * THE COLLISION THIS SCREEN HAS TO MAKE LEGIBLE. Codes are compared without case, so
   * `kgs` against an existing `KGS` is one unit and not two. Main's sentence names the
   * code that already exists; showing it under the code box is what turns a refusal into
   * an answer, and the typed value stays so nobody has to retype the rest of the form.
   */
  it('shows a code collision under the code box, in main’s own words', async () => {
    const { user } = await opened({
      create: () =>
        Promise.resolve({
          ok: false,
          error: {
            code: 'UNIT_CODE_TAKEN',
            message: 'KGS is already a unit in these books.',
          },
        }),
    })

    await user.type(screen.getByLabelText('Code'), 'kgs')
    await user.type(screen.getByLabelText('Name'), 'Kilos')
    await user.click(screen.getByRole('button', { name: 'Add unit' }))

    const box = await screen.findByLabelText('Code')
    await waitFor(() => {
      expect(box).toHaveAccessibleDescription('KGS is already a unit in these books.')
    })
    expect(box).toBeInvalid()
    expect(box).toHaveValue('kgs')
    expect(screen.getByLabelText('Name')).toHaveValue('Kilos')
  })

  /* A refusal that names no field still has to be read, so it goes to the notice. */
  it('shows a refusal that names no field at the top of the dialog', async () => {
    const { user } = await opened({
      create: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'NO_COMPANY_OPEN', message: 'No company is open.' },
        }),
    })

    await user.type(screen.getByLabelText('Code'), 'KGS')
    await user.type(screen.getByLabelText('Name'), 'Kilograms')
    await user.click(screen.getByRole('button', { name: 'Add unit' }))

    expect(await screen.findByText('No company is open.')).toBeInTheDocument()
    expect(screen.getByLabelText('Code')).toHaveAccessibleDescription(/kg and KG would be one unit/)
  })

  /* A second click while the first save is in flight would create the unit twice, or
   * try to and be refused as a duplicate. */
  it('does not offer the save twice while one is in flight', async () => {
    let release = (_: Result<UnitOfMeasure>): void => {}
    const pending = new Promise<Result<UnitOfMeasure>>((resolve) => {
      release = resolve
    })
    const { user } = await opened({ create: () => pending })

    await user.type(screen.getByLabelText('Code'), 'KGS')
    await user.type(screen.getByLabelText('Name'), 'Kilograms')
    await user.click(screen.getByRole('button', { name: 'Add unit' }))

    expect(screen.getByRole('button', { name: 'Add unit' })).toBeDisabled()

    /* Awaiting the promise is not waiting for the screen: the state that follows it is
     * set in a React update, and only `act` flushes that. */
    await act(async () => {
      release({ ok: true, data: unit({ code: 'KGS', name: 'Kilograms' }) })
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save unit' })).toBeEnabled()
    })
  })
})

// ---- Editing ---------------------------------------------------------------

describe('editing', () => {
  const editorFor = async (code: string, over: NonNullable<BridgeStub['units']> = {}) => {
    const user = userEvent.setup()
    const rendered = renderScreen(<Units />, {
      bridge: listing({
        get: (wanted: string) =>
          Promise.resolve({
            ok: true,
            data: unit({ code: wanted, name: 'Kilograms', decimalPlaces: 3, regimeCode: 'KGS' }),
          }),
        ...over,
      }),
    })
    await user.click(await screen.findByRole('button', { name: code }))
    return { user, ...rendered }
  }

  /* A unit is keyed by its CODE and by nothing else — there is no id anywhere in this
   * aggregate, which is why `units` is a group of its own. */
  it('reads the unit back by its code before opening', async () => {
    const { bridge } = await editorFor('KGS')

    expect(await screen.findByLabelText('Name')).toHaveValue('Kilograms')
    expect(bridge.lastCallTo('units:get')?.args).toEqual(['KGS'])
  })

  /*
   * A CODE IS AN IDENTITY AND `units.update` TAKES NO NEW ONE. Every item stores it and
   * every document already issued has printed it, so the box is read-only — and the hint
   * says why, because a dead field with no explanation is a field somebody reports.
   */
  it('will not let the code be edited, and says why', async () => {
    const { user } = await editorFor('KGS')

    const box = await screen.findByLabelText('Code')
    expect(box).toHaveAttribute('readonly')
    expect(box).toHaveAccessibleDescription(/every document already issued has printed it/)

    await user.type(box, 'X')
    expect(box).toHaveValue('KGS')
  })

  it('sends the code as the identity and the fields that changed', async () => {
    const update = vi.fn((input: UpdateUnitInput) =>
      Promise.resolve({
        ok: true as const,
        data: unit({ code: input.code, name: input.name ?? 'Kilograms' }),
      }),
    )
    const { user } = await editorFor('KGS', { update })

    await user.clear(await screen.findByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'Kilogrammes')
    await user.selectOptions(screen.getByLabelText('Decimal places'), '2')
    await user.click(screen.getByRole('button', { name: 'Save unit' }))

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({
        code: 'KGS',
        name: 'Kilogrammes',
        decimalPlaces: 2,
        regimeCode: 'KGS',
      })
    })
  })

  /* Clearing the box is a user saying this unit maps to nothing after all, which is a
   * null rather than a code of no characters. */
  it('clears a return code with a null rather than an empty string', async () => {
    const update = vi.fn((input: UpdateUnitInput) =>
      Promise.resolve({ ok: true as const, data: unit({ code: input.code }) }),
    )
    const { user } = await editorFor('KGS', { update })

    await user.clear(await screen.findByLabelText('Reports as'))
    await user.click(screen.getByRole('button', { name: 'Save unit' }))

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ regimeCode: null }))
    })
  })

  /*
   * THE EDITOR SHOWS WHAT MAIN ANSWERED WITH, NOT WHAT IT SENT — on the path where
   * nothing else would rebuild it.
   *
   * Creating a unit moves the editor from "a new one" to a record, so the form is rebuilt
   * for that reason whatever the code does; editing one does not move it anywhere. Main's
   * answer is the whole record as the books now hold it, which is not always the fields
   * that were posted: a code is upper-cased, a return code is trimmed, and another window
   * may have changed something in between. Every box has to follow it.
   */
  it('shows what main answered with after a save, not what was sent', async () => {
    const { user } = await editorFor('KGS', {
      update: () =>
        Promise.resolve({
          ok: true,
          data: unit({ code: 'KGS', name: 'Kilogrammes', decimalPlaces: 2, regimeCode: 'KGM' }),
        }),
    })

    await user.clear(await screen.findByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'Kilos')
    await user.click(screen.getByRole('button', { name: 'Save unit' }))

    await waitFor(() => {
      expect(screen.getByLabelText('Name')).toHaveValue('Kilogrammes')
    })
    expect(screen.getByLabelText('Decimal places')).toHaveValue('2')
    expect(screen.getByLabelText('Reports as')).toHaveValue('KGM')
  })

  /* Deleted in another window since the list was drawn. An editor over a record that is
   * gone can only fail on save, so the list is re-read instead. */
  it('re-reads the list rather than opening an editor over a unit that has gone', async () => {
    const { bridge } = await editorFor('KGS', {
      get: () => Promise.resolve({ ok: true, data: null }),
    })

    await waitFor(() => {
      expect(bridge.callsTo('units:list').length).toBeGreaterThan(1)
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

// ---- Archiving and deleting -------------------------------------------------

describe('archiving', () => {
  /* Archive, not delete. The confirmation says what survives, because "archived" on its
   * own sounds like something was taken away from the books. */
  it('archives by code and says what is left alone', async () => {
    const user = userEvent.setup()
    const archive = vi.fn(() =>
      Promise.resolve({ ok: true as const, data: unit({ code: 'KGS', isArchived: true }) }),
    )
    renderScreen(<Units />, { bridge: listing({ archive }) })

    const row = await rowFor('KGS')
    await user.click(within(row).getByRole('button', { name: 'Archive' }))

    await waitFor(() => {
      expect(archive).toHaveBeenCalledWith({ code: 'KGS', archived: true })
    })
    expect(
      await screen.findByText(/every document already issued still prints it/),
    ).toBeInTheDocument()
  })

  it('offers to restore one that is already archived', async () => {
    const user = userEvent.setup()
    const archive = vi.fn(() =>
      Promise.resolve({ ok: true as const, data: unit({ code: 'SQFT' }) }),
    )
    renderScreen(<Units />, { bridge: listing({ archive }) })

    const row = await rowFor('SQFT')
    await user.click(within(row).getByRole('button', { name: 'Restore' }))

    await waitFor(() => {
      expect(archive).toHaveBeenCalledWith({ code: 'SQFT', archived: false })
    })
  })
})

describe('deleting', () => {
  const confirming = async (over: NonNullable<BridgeStub['units']> = {}) => {
    const user = userEvent.setup()
    const rendered = renderScreen(<Units />, { bridge: listing(over) })
    const row = await rowFor('KGS')
    await user.click(within(row).getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog')
    return { user, dialog, ...rendered }
  }

  it('deletes by code, not by anything else', async () => {
    const remove = vi.fn(() => Promise.resolve({ ok: true as const, data: undefined }))
    const { user, dialog } = await confirming({ delete: remove })

    expect(within(dialog).getByText('Delete KGS?')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith('KGS')
    })
    expect(await screen.findByText(/No item was measured in it/)).toBeInTheDocument()
  })

  /*
   * The refusal names the item standing in the way and says what to do instead, so it
   * stays on screen where the question was asked. A toast slides past.
   */
  it('keeps the refusal on screen, naming the item in the way', async () => {
    const { user, dialog } = await confirming({
      delete: () =>
        Promise.resolve({
          ok: false,
          error: {
            code: 'UNIT_IN_USE',
            message: 'Ball bearing 6203 is measured in KGS. Archive the unit instead.',
          },
        }),
    })

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    expect(
      await within(dialog).findByText(
        'Ball bearing 6203 is measured in KGS. Archive the unit instead.',
      ),
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Keep it' })).toBeInTheDocument()
  })
})
