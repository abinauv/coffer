/*
 * Units of measure — what a quantity is counted in.
 *
 * THIS SCREEN IS THE ONLY WAY A UNIT EVER EXISTS. `setUpBooks` seeds none, deliberately:
 * a fresh company knows nothing about what its owner trades in, and a seeded `NOS` is a
 * guess that quietly becomes the default on every invoice. So a new company's units table
 * is empty, and the first thing this screen has to do well is make the first unit easy to
 * add.
 *
 * NOTHING HERE RESTRICTS A BUSINESS TO A KNOWN LIST. `BUNDLE`, `TIN` and `SQFT` are as
 * real as `KGS`. Silently rewriting every unit outside four to `Nos` is a design
 * CONVENTIONS §9 refuses — so there is no table
 * of permitted codes in this file, no coercion, and no warning about an unusual one.
 *
 * A CODE IS AN IDENTITY, NOT A LABEL. It is what every item stores and what has printed
 * on every document already issued, so it cannot be edited: `UpdateUnitInput` has no code
 * among the fields that may change, and the box is read-only once the unit exists. The
 * way to `KG` from `KGS` is a second unit and a decision about which items move.
 *
 * ARCHIVE, NOT DELETE, is the default. Deleting is offered only for a unit no item is
 * measured in — the repository refuses the rest with the name of the item in the way —
 * because a unit in use is printed on paperwork that has already gone out.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Badge, Button, Dialog, Input, Select } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { registerScreens } from '@renderer/lib/screens'
import { SHORTCUTS } from '@renderer/lib/shortcuts'
import { useRegisterCommands } from '@renderer/store/commands'
import { useToasts } from '@renderer/store/toasts'
import type { AppError, UnitOfMeasure } from '@shared/dto'
import { DeleteDialog } from '../components/DeleteDialog'
import { FailureNotice } from '../components/FailureNotice'
import { ListToolbar } from '../components/ListToolbar'
import { RegisterEmpty } from '../components/RegisterToolbar'
import { RegisterSkeleton, type SkeletonColumn } from '../components/RegisterSkeleton'
import { ScreenFrame } from '../components/ScreenFrame'
import { useSearchShortcut } from '../lib/use-search-shortcut'
import { archivedNote } from '../lib/register-view'
import { useHasTyped } from '../lib/typed'
import {
  DECIMAL_PLACES_CHOICES,
  DEFAULT_DECIMAL_PLACES,
  filterUnits,
  unitCodeHint,
  unitErrorField,
} from '../lib/unit-view'

/* Code, name, decimals, reports as, actions. */
const COLUMNS: readonly SkeletonColumn[] = [
  { width: '8rem' },
  { width: '1fr' },
  { width: '5rem', align: 'end' },
  { width: '7rem' },
  { width: '9rem', align: 'end' },
]

export function Units(): JSX.Element {
  const { show } = useToasts()

  const [units, setUnits] = useState<UnitOfMeasure[] | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [query, setQuery] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [editing, setEditing] = useState<UnitOfMeasure | 'new' | null>(null)
  const [deleting, setDeleting] = useState<UnitOfMeasure | null>(null)
  /*
   * Bumped by every save, and it is the dialog's key.
   *
   * A SAVE REMOUNTS THE EDITOR ON WHAT MAIN RETURNED, which is not always what was typed:
   * a code is trimmed and upper-cased before it is stored, so somebody who types `kgs`
   * has made `KGS` and the field must say so. Rebuilding the form from the returned
   * record rather than assigning field by field is the point — a per-field copy is how an
   * editor ends up writing seven of its fifteen fields.
   */
  const [revision, setRevision] = useState(0)

  const load = useCallback(async () => {
    const result = await callApi((api) => api.units.list({ includeArchived }))
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    setUnits(result.data)
  }, [includeArchived])

  useEffect(() => {
    void load()
  }, [load])

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: 'units.new',
          title: 'New unit of measure',
          section: 'Items',
          keywords: ['unit', 'uom', 'measure', 'kilogram', 'quantity', 'create'],
          shortcut: SHORTCUTS.create,
          run: () => setEditing('new'),
        },
      ],
      [],
    ),
  )

  /*
   * Opening the editor re-reads the unit rather than editing the row in hand.
   *
   * Not for the reason the parties screen has — `units.list` returns the whole record,
   * there is no summary here and nothing is missing. It is because the list was drawn at
   * some point in the past, and a unit deleted since then would give an editor that can
   * only fail on save. `get` takes the CODE, which is this aggregate's whole identity.
   */
  const openEditor = useCallback(
    async (code: string) => {
      const result = await callApi((api) => api.units.get(code))
      if (!result.ok) {
        setError(result.error)
        return
      }
      if (result.data === null) {
        void load()
        return
      }
      setEditing(result.data)
    },
    [load],
  )

  const setArchived = useCallback(
    async (unit: UnitOfMeasure, archived: boolean) => {
      const result = await callApi((api) => api.units.archive({ code: unit.code, archived }))
      if (!result.ok) {
        show({ tone: 'danger', title: 'That did not work', body: result.error.message })
        return
      }
      show({
        tone: 'success',
        title: archived ? 'Archived' : 'Back in use',
        body: archived
          ? `${unit.code} reaches no picker. Items already measured in it keep it, and every document already issued still prints it.`
          : `${unit.code} can be chosen again.`,
      })
      void load()
    },
    [load, show],
  )

  const searchBox = useSearchShortcut('units.search', 'Items', 'Search these units')

  const rows = useMemo(() => filterUnits(units ?? [], query), [units, query])

  return (
    <ScreenFrame
      isInset
      width="list"
      title="Units of measure"
      lede="What quantities are counted in. These books start with none and assume nothing — add the units you actually trade in, whatever they are."
      actions={
        <Button icon="plus" variant="primary" onClick={() => setEditing('new')}>
          New unit
        </Button>
      }
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="ledger" />}

        <ListToolbar
          placeholder="Search by code or name"
          query={query}
          onQueryChange={setQuery}
          includeArchived={includeArchived}
          onIncludeArchivedChange={setIncludeArchived}
          inputRef={searchBox}
        />

        {units === null ? (
          error === null && <RegisterSkeleton label="units of measure" columns={COLUMNS} />
        ) : rows.length === 0 ? (
          <RegisterEmpty
            plural="units"
            isFiltered={query.trim() !== ''}
            sentence={`Nothing was seeded for you, on purpose — a guessed default is a default that ends up on invoices. Add the ones your paperwork already uses: KGS, NOS, BUNDLE, whatever they are.`}
            newLabel="Add the first unit"
            onNew={() => setEditing('new')}
            filteredSentence={`No unit has ${query.trim()} in its code or its name.${archivedNote(includeArchived)}`}
            clearLabel="Clear the search"
            onClear={() => setQuery('')}
          />
        ) : (
          <div className="register">
            <table className="ledger-table register__table">
              <thead>
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Name</th>
                  <th scope="col" className="ledger-table__figure">
                    Decimals
                  </th>
                  <th scope="col">Reports as</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((unit) => (
                  <tr
                    key={unit.code}
                    className={`ledger-table__row${unit.isArchived ? ' ledger-table__row--archived' : ''}`}
                  >
                    <td className="register__name">
                      <Button
                        variant="ghost"
                        size="sm"
                        isIdentifier
                        onClick={() => void openEditor(unit.code)}
                      >
                        {unit.code}
                      </Button>
                      {unit.isArchived && (
                        <>
                          {' '}
                          <Badge tone="neutral">Archived</Badge>
                        </>
                      )}
                    </td>
                    <td>{unit.name}</td>
                    <td className="ledger-table__figure">{unit.decimalPlaces}</td>
                    {/* Nothing is mapped until Phase 5 fills it in, so a dash rather than a
                        gap that reads as a field somebody forgot. */}
                    <td className="ledger-table__code">{unit.regimeCode ?? '—'}</td>
                    <td className="register__actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void setArchived(unit, !unit.isArchived)}
                      >
                        {unit.isArchived ? 'Restore' : 'Archive'}
                      </Button>{' '}
                      <Button variant="ghost" size="sm" onClick={() => setDeleting(unit)}>
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <UnitDialog
        key={
          editing === null
            ? 'editor:closed'
            : `editor:${editing === 'new' ? 'new' : editing.code}#${revision}`
        }
        isOpen={editing !== null}
        unit={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={(saved, wasNew) => {
          setEditing(saved)
          setRevision((current) => current + 1)
          show({
            tone: 'success',
            title: wasNew ? 'Added' : 'Saved',
            body: wasNew
              ? `${saved.code} — ${saved.name} can now be chosen on an item.`
              : `${saved.code} is up to date.`,
          })
          void load()
        }}
      />

      <DeleteDialog
        key={deleting === null ? 'delete:closed' : `delete:${deleting.code}`}
        name={deleting?.code ?? null}
        sentence="This removes the unit from these books entirely. It is refused if any item is measured in it — archive it instead, and everything already issued keeps printing it."
        onConfirm={() =>
          deleting === null
            ? Promise.resolve({ ok: true, data: undefined })
            : callApi((api) => api.units.delete(deleting.code))
        }
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          const code = deleting?.code ?? ''
          setDeleting(null)
          show({
            tone: 'success',
            title: 'Deleted',
            body: `${code} is gone. No item was measured in it.`,
          })
          void load()
        }}
      />
    </ScreenFrame>
  )
}

// ---- Adding and editing ----------------------------------------------------

interface UnitDialogProps {
  isOpen: boolean
  /** Null when adding. */
  unit: UnitOfMeasure | null
  onClose: () => void
  onSaved: (unit: UnitOfMeasure, wasNew: boolean) => void
}

/**
 * One dialog for adding and for editing, as the party editor is.
 *
 * WHAT DIFFERS IS THE CODE BOX, and it is the contract rather than a nicety. A unit's code
 * is its identity — `units.update` takes no new one — so it is read-only once the unit
 * exists, and the hint says why rather than leaving a dead field to be puzzled over.
 *
 * NOTHING HERE UPPER-CASES ANYTHING. The repository normalises a code on the way in, and
 * a second copy of that rule in the renderer is a second thing to keep in step. What
 * happens instead is that the screen re-reads what came back: type `kgs`, and the field
 * says `KGS` afterwards because that is what the books hold. The refusal for a code that
 * is already taken arrives the same way, naming the code that exists.
 */
function UnitDialog({ isOpen, unit, onClose, onSaved }: UnitDialogProps): JSX.Element {
  const isNew = unit === null

  const [code, setCode] = useState(unit?.code ?? '')
  const [name, setName] = useState(unit?.name ?? '')
  const [decimalPlaces, setDecimalPlaces] = useState(unit?.decimalPlaces ?? DEFAULT_DECIMAL_PLACES)
  const [regimeCode, setRegimeCode] = useState(unit?.regimeCode ?? '')

  const [isBusy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  const hasTyped = useHasTyped({ code, name, decimalPlaces, regimeCode })
  const canSubmit = code.trim() !== '' && name.trim() !== '' && !isBusy
  const field = error === null ? null : unitErrorField(error)

  const submit = useCallback(async () => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)

    /* Blank is "not mapped yet" rather than a code of nothing — Phase 5 fills it in. */
    const trimmedRegimeCode = regimeCode.trim()
    const fields = {
      name: name.trim(),
      decimalPlaces,
      regimeCode: trimmedRegimeCode === '' ? null : trimmedRegimeCode,
    }

    const result = await callApi((api) =>
      isNew
        ? api.units.create({ ...fields, code: code.trim() })
        : api.units.update({ ...fields, code: unit.code }),
    )
    setBusy(false)

    if (!result.ok) {
      setError(result.error)
      return
    }
    onSaved(result.data, isNew)
  }, [canSubmit, code, decimalPlaces, isNew, name, onSaved, regimeCode, unit])

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      hasUnsavedInput={hasTyped}
      title={isNew ? 'New unit' : `Edit ${unit.code}`}
      description="A unit is a code, a name, and how many decimal places a quantity in it may carry. Nothing restricts you to a known list."
      footer={
        <>
          <Button onClick={onClose}>{isNew ? 'Cancel' : 'Close'}</Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={!canSubmit}
            isBusy={isBusy}
          >
            {isNew ? 'Add' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="stack">
        {/* A refusal that names a field is shown under that field. Anything else has
            nowhere better to be than here. */}
        {error && field === null && <FailureNotice error={error} context="ledger" />}

        <Input
          label="Code"
          isIdentifier
          value={code}
          readOnly={!isNew}
          error={field === 'code' ? error?.message : undefined}
          hint={unitCodeHint(isNew)}
          maxLength={16}
          onChange={(event) => setCode(event.target.value)}
        />

        <Input
          label="Name"
          value={name}
          error={field === 'name' ? error?.message : undefined}
          hint="What it is in words — Kilograms, Numbers, Bundles of ten."
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
        />

        <Select
          label="Decimal places"
          value={String(decimalPlaces)}
          hint="How precise a quantity in this unit may be. Half a box is not a quantity — choose 0 and an invoice line cannot ask for one."
          onChange={(event) => setDecimalPlaces(Number.parseInt(event.target.value, 10))}
        >
          {DECIMAL_PLACES_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </Select>

        <Input
          label="Reports as"
          isIdentifier
          value={regimeCode}
          hint="What this unit is called in a return, where the regime fixes a list. Leave it empty until you know — nothing depends on it yet."
          maxLength={16}
          onChange={(event) => setRegimeCode(event.target.value)}
        />
      </div>
    </Dialog>
  )
}

registerScreens([
  {
    id: 'units',
    title: 'Units of measure',
    area: 'workspace',
    nav: { label: 'Units of measure', icon: 'ruler', group: 'inventory', order: 1 },
    render: () => <Units />,
  },
])
