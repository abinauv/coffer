/*
 * Items — what goes on a document line. Products, services, and the charges beside them.
 *
 * EVERY FIELD HERE IS A DEFAULT FOR A LINE, NEVER A LOOKUP A LINE PERFORMS LATER. A
 * document line stores its own description, price, unit and rate, so repricing an item on
 * this screen, renaming it or archiving it cannot rewrite an invoice already issued. That
 * is what makes archiving safe on books full of history, and it is why nothing on this
 * screen warns about changing a price.
 *
 * THE EDITOR OFFERS EVERY FIELD `CreateItemInput` CARRIES. All fourteen. An editor that
 * writes some of what it was given is worse than one that writes none: the fields it
 * forgot look filled in on screen and are silently absent in the books, and nothing
 * anywhere disagrees.
 *
 * THE CLASSIFICATION CODE IS NOT CHECKED HERE, AND IT IS NOT KEPT EITHER. Whether
 * `847130` is a real HSN is the regime's question, asked in the main process, and its
 * refusal arrives as `ITEM_CLASSIFICATION_INVALID` carrying a sentence written for the
 * user — which is shown under the box rather than paraphrased. The regime also
 * NORMALISES: `8471.30` is accepted and stored as `847130`, so a screen that kept what
 * was typed would show a value the books do not hold. This one re-reads what came back.
 *
 * NO STOCK, NO VALUATION, NO PRICE HISTORY. What an item is worth is a sum over the stock
 * ledger and belongs with the reports, for the same reason a party carries no balance on
 * the parties screen.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Badge, Button, Dialog, Input, Select } from '@renderer/components/atoms'
import { callApi } from '@renderer/lib/api'
import type { Command } from '@renderer/lib/command-registry'
import { makeRoute } from '@renderer/lib/routing'
import type { ScreenContext } from '@renderer/lib/screens'
import { registerScreens } from '@renderer/lib/screens'
import { SHORTCUTS } from '@renderer/lib/shortcuts'
import { useRegisterCommands } from '@renderer/store/commands'
import { useNumberFormat, useRegime } from '@renderer/store/regime'
import { useToasts } from '@renderer/store/toasts'
import type {
  Account,
  AppError,
  Item,
  ItemKind,
  ItemSummary,
  RegimeDescription,
  UnitOfMeasure,
} from '@shared/dto'
import { CheckboxField } from '../components/CheckboxField'
import { DeleteDialog } from '../components/DeleteDialog'
import { FailureNotice } from '../components/FailureNotice'
import { ListToolbar } from '../components/ListToolbar'
import { Notice } from '../components/Notice'
import { RegisterEmpty } from '../components/RegisterToolbar'
import { RegisterSkeleton, type SkeletonColumn } from '../components/RegisterSkeleton'
import { ScreenFrame } from '../components/ScreenFrame'
import { useSearchShortcut } from '../lib/use-search-shortcut'
import { formatAmount } from '../lib/ledger-format'
import { archivedNote } from '../lib/register-view'
import { useHasTyped } from '../lib/typed'
import {
  accountOptions,
  classificationHint,
  filterItems,
  ITEM_KINDS,
  itemErrorField,
  itemKindLabel,
  itemSideLabel,
  parseItemKind,
  unitOptions,
} from '../lib/item-view'

/* Item, code, kind, side, unit, classification, rate, sale price, actions. */
const COLUMNS: readonly SkeletonColumn[] = [
  { width: 'minmax(9rem, 2fr)' },
  { width: '6rem' },
  { width: '5rem' },
  { width: '5rem' },
  { width: '4rem' },
  { width: '6rem' },
  { width: '4rem', align: 'end' },
  { width: '7rem', align: 'end' },
  { width: '9rem', align: 'end' },
]

export function Items({ navigate }: ScreenContext): JSX.Element {
  const { show } = useToasts()
  const format = useNumberFormat()

  const [items, setItems] = useState<ItemSummary[] | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [query, setQuery] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [editing, setEditing] = useState<Item | 'new' | null>(null)
  const [deleting, setDeleting] = useState<ItemSummary | null>(null)
  /* Bumped by every save; it is the editor's key. See `ItemDialog` for why the editor is
   * rebuilt from what main returned rather than assigned field by field. */
  const [revision, setRevision] = useState(0)

  /*
   * The two lists the editor's pickers are made of.
   *
   * BOTH ARE FETCHED WITH ARCHIVED ROWS INCLUDED, and that is not laziness about the
   * filter: an item may hold a unit or an account that was archived after it was saved,
   * and a `<select>` whose value is not among its options falls back to the first one
   * without saying so. The option builders decide what is offered; see item-view.ts.
   */
  const [units, setUnits] = useState<UnitOfMeasure[] | null>(null)
  const [accounts, setAccounts] = useState<Account[] | null>(null)

  const load = useCallback(async () => {
    const result = await callApi((api) => api.items.list({ includeArchived }))
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    setItems(result.data)
  }, [includeArchived])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void (async () => {
      const result = await callApi((api) => api.units.list({ includeArchived: true }))
      if (result.ok) setUnits(result.data)
    })()
  }, [])

  useEffect(() => {
    void (async () => {
      const result = await callApi((api) => api.ledger.listAccounts({ includeArchived: true }))
      if (result.ok) setAccounts(result.data)
    })()
  }, [])

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: 'items.new',
          title: 'New item',
          section: 'Items',
          keywords: ['item', 'product', 'service', 'sku', 'charge', 'create'],
          shortcut: SHORTCUTS.create,
          run: () => setEditing('new'),
        },
      ],
      [],
    ),
  )

  /* Opening the editor needs the whole record, and the list carries only a summary — it
   * has no description, no purchase price and neither account override on it at all. */
  const openEditor = useCallback(
    async (id: string) => {
      const result = await callApi((api) => api.items.get(id))
      if (!result.ok) {
        setError(result.error)
        return
      }
      if (result.data === null) {
        /* Deleted in another window since the list was drawn. Reloading is the honest
         * answer — an editor over a record that is gone can only fail on save. */
        void load()
        return
      }
      setEditing(result.data)
    },
    [load],
  )

  const setArchived = useCallback(
    async (item: ItemSummary, archived: boolean) => {
      const result = await callApi((api) => api.items.archive({ id: item.id, archived }))
      if (!result.ok) {
        show({ tone: 'danger', title: 'That did not work', body: result.error.message })
        return
      }
      show({
        tone: 'success',
        title: archived ? 'Archived' : 'Back in use',
        body: archived
          ? `${item.name} reaches no picker and no new line. Every document it is already on is untouched.`
          : `${item.name} can be put on a line again.`,
      })
      void load()
    },
    [load, show],
  )

  const searchBox = useSearchShortcut('items.search', 'Items', 'Search these items')

  const rows = useMemo(() => filterItems(items ?? [], query), [items, query])

  return (
    <ScreenFrame
      isInset
      width="list"
      title="Items"
      lede="What you sell, what you buy, and the charges beside them. Everything here is a default for a document line — changing it never reaches a document already issued."
      actions={
        <Button icon="plus" variant="primary" onClick={() => setEditing('new')}>
          New item
        </Button>
      }
    >
      <div className="stack">
        {error && <FailureNotice error={error} context="ledger" />}

        <ListToolbar
          placeholder="Search by name, code or classification"
          query={query}
          onQueryChange={setQuery}
          includeArchived={includeArchived}
          onIncludeArchivedChange={setIncludeArchived}
          inputRef={searchBox}
        />

        {items === null ? (
          error === null && <RegisterSkeleton label="items" columns={COLUMNS} />
        ) : rows.length === 0 ? (
          <RegisterEmpty
            plural="items"
            isFiltered={query.trim() !== ''}
            sentence="Add the first one and it can be put on an invoice or a bill."
            newLabel="Add the first item"
            onNew={() => setEditing('new')}
            filteredSentence={`No item has ${query.trim()} in its name, its code or its classification code.${archivedNote(includeArchived)}`}
            clearLabel="Clear the search"
            onClear={() => setQuery('')}
          />
        ) : (
          <div className="register">
            <table className="ledger-table register__table">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Code</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Side</th>
                  <th scope="col">Unit</th>
                  <th scope="col">Classification</th>
                  <th scope="col" className="ledger-table__figure">
                    Rate
                  </th>
                  <th scope="col" className="ledger-table__figure">
                    Sale price
                  </th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <tr
                    key={item.id}
                    className={`ledger-table__row${item.isArchived ? ' ledger-table__row--archived' : ''}`}
                  >
                    <td className="register__name">
                      <Button variant="ghost" size="sm" onClick={() => void openEditor(item.id)}>
                        {item.name}
                      </Button>
                      {item.isCharge && (
                        <>
                          {' '}
                          <Badge tone="accent">Charge</Badge>
                        </>
                      )}
                      {item.isArchived && (
                        <>
                          {' '}
                          <Badge tone="neutral">Archived</Badge>
                        </>
                      )}
                    </td>
                    {/* A dash rather than a gap: an item with no SKU, no unit or no
                        classification is ordinary, not a field somebody forgot. */}
                    <td className="ledger-table__code">{item.code ?? '—'}</td>
                    <td className="ledger-table__muted">{itemKindLabel(item.kind)}</td>
                    <td className="ledger-table__muted">{itemSideLabel(item)}</td>
                    <td className="ledger-table__code">{item.unitCode ?? '—'}</td>
                    <td className="ledger-table__code">{item.classificationCode ?? '—'}</td>
                    {/* The rate arrives as main spells it — three places, because 0.25%
                        halves to 0.125%. Nothing here rounds it. */}
                    <td className="ledger-table__figure">
                      {item.taxRatePct === null ? '—' : `${item.taxRatePct}%`}
                    </td>
                    <td className="ledger-table__figure">
                      {item.salePrice === null ? '—' : formatAmount(item.salePrice, format)}
                    </td>
                    <td className="register__actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void setArchived(item, !item.isArchived)}
                      >
                        {item.isArchived ? 'Restore' : 'Archive'}
                      </Button>{' '}
                      <Button variant="ghost" size="sm" onClick={() => setDeleting(item)}>
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

      <ItemDialog
        key={
          editing === null
            ? 'editor:closed'
            : `editor:${editing === 'new' ? 'new' : editing.id}#${revision}`
        }
        isOpen={editing !== null}
        item={editing === 'new' ? null : editing}
        units={units}
        accounts={accounts}
        onClose={() => setEditing(null)}
        onGoToUnits={() => {
          setEditing(null)
          navigate(makeRoute('workspace', 'units'))
        }}
        onSaved={(saved, wasNew) => {
          setEditing(saved)
          setRevision((current) => current + 1)
          show({
            tone: 'success',
            title: wasNew ? 'Added' : 'Saved',
            body: `${saved.name} is up to date. What is shown is what these books now hold.`,
          })
          void load()
        }}
      />

      <DeleteDialog
        key={deleting === null ? 'delete:closed' : `delete:${deleting.id}`}
        name={deleting?.name ?? null}
        sentence="This removes the item from these books entirely. It is refused once the item appears on any document — archive it instead, and everything already issued is untouched."
        onConfirm={() =>
          deleting === null
            ? Promise.resolve({ ok: true, data: undefined })
            : callApi((api) => api.items.delete(deleting.id))
        }
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          const name = deleting?.name ?? ''
          setDeleting(null)
          show({
            tone: 'success',
            title: 'Deleted',
            body: `${name} is gone. It was on no document.`,
          })
          void load()
        }}
      />
    </ScreenFrame>
  )
}

// ---- Adding and editing ----------------------------------------------------

interface ItemDialogProps {
  isOpen: boolean
  /** Null when adding. */
  item: Item | null
  /** Null while the list is still being read. */
  units: readonly UnitOfMeasure[] | null
  accounts: readonly Account[] | null
  onClose: () => void
  onGoToUnits: () => void
  onSaved: (item: Item, wasNew: boolean) => void
}

/**
 * One dialog for adding and for editing.
 *
 * IT IS REBUILT FROM WHAT MAIN RETURNED AFTER EVERY SAVE, by being remounted on a key the
 * screen bumps. That is deliberate and it is the cheapest correct answer: what comes back
 * is not what was typed — the regime rewrites `8471.30` as `847130`, the repository
 * rewrites `5000` as `5000.00` — and a form that kept the typed spelling would show a
 * value the books do not hold, then send it again on the next save. Reassigning field by
 * field would do the same job and would be a place to forget one, which is exactly the
 * failure this editor exists after.
 *
 * NOTHING HERE VALIDATES A CLASSIFICATION CODE, A PRICE OR A RATE. The regime owns the
 * first and `domain/money` owns the other two, both in the main process, and a second
 * check in the renderer would either disagree with them or repeat them. This layer must
 * not compute anything about money at all (CONVENTIONS §1.7).
 */
function ItemDialog({
  isOpen,
  item,
  units,
  accounts,
  onClose,
  onGoToUnits,
  onSaved,
}: ItemDialogProps): JSX.Element {
  const isNew = item === null
  const regime = useRegime()

  const [name, setName] = useState(item?.name ?? '')
  const [code, setCode] = useState(item?.code ?? '')
  const [kind, setKind] = useState<ItemKind>(item?.kind ?? 'goods')
  const [description, setDescription] = useState(item?.description ?? '')
  const [unitCode, setUnitCode] = useState(item?.unitCode ?? '')
  const [classificationCode, setClassificationCode] = useState(item?.classificationCode ?? '')
  const [taxRatePct, setTaxRatePct] = useState(item?.taxRatePct ?? '')
  const [salePrice, setSalePrice] = useState(item?.salePrice ?? '')
  const [purchasePrice, setPurchasePrice] = useState(item?.purchasePrice ?? '')
  /* A new item is sold unless somebody says otherwise, which is what most of them are.
   * An item that is NEITHER is refused by the repository, so the button says so by
   * staying off rather than letting a full form fail on save. */
  const [isSold, setSold] = useState(item?.isSold ?? true)
  const [isPurchased, setPurchased] = useState(item?.isPurchased ?? false)
  const [isCharge, setCharge] = useState(item?.isCharge ?? false)
  const [salesAccountId, setSalesAccountId] = useState(item?.salesAccountId ?? '')
  const [purchaseAccountId, setPurchaseAccountId] = useState(item?.purchaseAccountId ?? '')

  const [isBusy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  const hasTyped = useHasTyped({
    name,
    code,
    kind,
    description,
    unitCode,
    classificationCode,
    taxRatePct,
    salePrice,
    purchasePrice,
    isSold,
    isPurchased,
    isCharge,
    salesAccountId,
    purchaseAccountId,
  })
  const hasASide = isSold || isPurchased
  const canSubmit = name.trim() !== '' && hasASide && !isBusy
  const field = error === null ? null : itemErrorField(error)

  const submit = useCallback(async () => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)

    /*
     * Every optional field, every time, and a blank one goes as `null` rather than as
     * `''`. Null is what the boundary reads as "clear it", and a decimal field refuses an
     * empty string outright — so a price box somebody emptied has to say null or the save
     * fails on a field the user thought they had left alone.
     */
    const fields = {
      name: name.trim(),
      kind,
      code: blankToNull(code),
      description: blankToNull(description),
      unitCode: blankToNull(unitCode),
      classificationCode: blankToNull(classificationCode),
      taxRatePct: blankToNull(taxRatePct),
      salePrice: blankToNull(salePrice),
      purchasePrice: blankToNull(purchasePrice),
      isSold,
      isPurchased,
      isCharge,
      salesAccountId: blankToNull(salesAccountId),
      purchaseAccountId: blankToNull(purchaseAccountId),
    }

    const result = await callApi((api) =>
      isNew ? api.items.create(fields) : api.items.update({ ...fields, id: item.id }),
    )
    setBusy(false)

    if (!result.ok) {
      setError(result.error)
      return
    }
    onSaved(result.data, isNew)
  }, [
    canSubmit,
    classificationCode,
    code,
    description,
    isCharge,
    isNew,
    isPurchased,
    isSold,
    item,
    kind,
    name,
    onSaved,
    purchaseAccountId,
    purchasePrice,
    salePrice,
    salesAccountId,
    taxRatePct,
    unitCode,
  ])

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      hasUnsavedInput={hasTyped}
      title={isNew ? 'New item' : `Edit ${item.name}`}
      description="Everything here is a default for a document line. A line keeps its own copy, so changing an item never rewrites paperwork already issued."
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
        {/* A refusal that names a field is shown under that field, where somebody who
            mistyped one digit can see which digit. Anything else belongs here. */}
        {error && field === null && <FailureNotice error={error} context="ledger" />}

        <Input
          label="Name"
          value={name}
          error={field === 'name' ? error?.message : undefined}
          hint="Two items may not share a name, ignoring case — add the size or the grade so a line cannot be raised against the wrong one."
          onChange={(event) => setName(event.target.value)}
        />

        <Input
          label="Item code"
          isIdentifier
          value={code}
          error={field === 'code' ? error?.message : undefined}
          hint="Your own SKU, if you use one. Two items may not carry the same code."
          onChange={(event) => setCode(event.target.value)}
        />

        <Select
          label="Kind"
          value={kind}
          hint="Goods or a service. It decides which classification scheme applies, and it prints."
          onChange={(event) => setKind(parseItemKind(event.target.value))}
        >
          {ITEM_KINDS.map((value) => (
            <option key={value} value={value}>
              {itemKindLabel(value)}
            </option>
          ))}
        </Select>

        <Input
          label="Description"
          value={description}
          hint="What a line says when this item is put on one. The line keeps its own copy and may be edited there."
          onChange={(event) => setDescription(event.target.value)}
        />

        <UnitField
          units={units}
          value={unitCode}
          error={field === 'unitCode' ? error?.message : undefined}
          onChange={setUnitCode}
          onGoToUnits={onGoToUnits}
        />

        {/* A regime that classifies nothing has no field here at all, rather than an
            empty box labelled with a scheme that does not exist. */}
        {regime !== null && regime.classification.code !== null && (
          <Input
            label={regime.classification.label}
            isIdentifier
            value={classificationCode}
            error={field === 'classificationCode' ? error?.message : undefined}
            hint={classificationHint(regime.classification)}
            onChange={(event) => setClassificationCode(event.target.value)}
          />
        )}

        {/* A LIST AND A BOX, NOT A CLOSED PICKER, for the reason the document editor
            gives: slabs change by notification and this build's copy of them is bundled,
            so a stale list must not stand between a user and the rate they were told. */}
        <Input
          label="Tax rate"
          list="item-tax-rates"
          value={taxRatePct}
          hint="The rate this item is usually charged at. A line takes it as a starting point and may be changed."
          onChange={(event) => setTaxRatePct(event.target.value)}
        />
        <RateOptions regime={regime} />

        <Input
          label="Sale price"
          value={salePrice}
          hint="What you normally charge, before tax. Leave it empty when nothing standard has been agreed — that is different from a price of nothing."
          onChange={(event) => setSalePrice(event.target.value)}
        />

        <Input
          label="Purchase price"
          value={purchasePrice}
          hint="What you normally pay. Same rule: empty is no standard price, zero is a price of zero."
          onChange={(event) => setPurchasePrice(event.target.value)}
        />

        <CheckboxField isChecked={isSold} onChange={setSold}>
          We sell it — makes it available on an invoice
        </CheckboxField>
        <CheckboxField isChecked={isPurchased} onChange={setPurchased}>
          We buy it — makes it available on a bill
        </CheckboxField>
        <CheckboxField
          isChecked={isCharge}
          onChange={setCharge}
          hint="Freight, packing, insurance. Taxable like anything else, but not sales revenue."
        >
          It is a charge rather than a product
        </CheckboxField>

        {!hasASide && (
          <Notice tone="warning" title="Which way does this item go?">
            <p>
              An item is sold, bought, or both. Tick at least one box — one that is neither reaches
              no picker in the application and can be put on no line.
            </p>
          </Notice>
        )}

        <AccountField
          label="Sales account"
          hint="Leave it empty and the revenue posts wherever the document kind says, which is the usual answer. Name an account only where this item's income has to land somewhere of its own."
          accounts={accounts}
          value={salesAccountId}
          onChange={setSalesAccountId}
        />

        <AccountField
          label="Purchase account"
          hint="Same rule as the sales account: empty means whatever the bill would have posted to anyway."
          accounts={accounts}
          value={purchaseAccountId}
          onChange={setPurchaseAccountId}
        />
      </div>
    </Dialog>
  )
}

/** Blank means "there is none", which crosses the boundary as null and never as ''. */
function blankToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** The rate slabs the regime knows about. Advisory: the box beside them accepts anything. */
function RateOptions({ regime }: { regime: RegimeDescription | null }): JSX.Element {
  return (
    <datalist id="item-tax-rates">
      {(regime?.taxRates ?? []).map((rate) => (
        <option key={rate.ratePct} value={rate.ratePct}>
          {rate.label} — {rate.note}
        </option>
      ))}
    </datalist>
  )
}

// ---- The unit picker --------------------------------------------------------

/**
 * What this item is counted in.
 *
 * THE EMPTY CASE IS THE ORDINARY ONE ON A NEW COMPANY. `setUpBooks` seeds no units at
 * all, so the very first item anybody adds is added against an empty table — and an empty
 * dropdown reads as a broken screen rather than as a table nobody has filled in. So it is
 * a notice, with the way out on it, and it says the true thing: a unit is optional, so
 * this item can be saved now and measured later.
 */
function UnitField({
  units,
  value,
  error,
  onChange,
  onGoToUnits,
}: {
  units: readonly UnitOfMeasure[] | null
  value: string
  error?: string
  onChange: (next: string) => void
  onGoToUnits: () => void
}): JSX.Element {
  const options = useMemo(() => unitOptions(units ?? [], value), [units, value])

  if (units !== null && options.length === 0) {
    return (
      <Notice
        tone="info"
        title="No units of measure yet"
        actions={
          <Button size="sm" onClick={onGoToUnits}>
            Set up units
          </Button>
        }
      >
        <p>
          These books were not given any — nothing is assumed about what you trade in. An item does
          not need one, so you can save this without a unit and set it later, or add your units
          first and come back.
        </p>
      </Notice>
    )
  }

  return (
    <Select
      label="Unit"
      value={value}
      disabled={units === null}
      error={error}
      hint="What a quantity of this item is counted in. Optional — a line without one is a plain number."
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">No unit</option>
      {options.map((option) => (
        <option key={option.code} value={option.code}>
          {option.label}
        </option>
      ))}
    </Select>
  )
}

// ---- The account overrides --------------------------------------------------

/**
 * Where this item's value posts, when it must not be where the document kind says.
 *
 * Empty is not "unknown": it means "whatever the kind implies", which is the usual case
 * and the reason the override exists as a choice rather than a default. Groups are never
 * offered — one holds no figures of its own and the repository refuses it.
 */
function AccountField({
  label,
  hint,
  accounts,
  value,
  onChange,
}: {
  label: string
  hint: string
  accounts: readonly Account[] | null
  value: string
  onChange: (next: string) => void
}): JSX.Element {
  const options = useMemo(() => accountOptions(accounts ?? [], value), [accounts, value])

  return (
    <Select
      label={label}
      value={value}
      disabled={accounts === null}
      hint={hint}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Whatever the document kind says</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </Select>
  )
}

registerScreens([
  {
    id: 'items',
    title: 'Items',
    area: 'workspace',
    nav: { label: 'Items', icon: 'box', group: 'inventory', order: 0 },
    render: (context) => <Items {...context} />,
  },
])
