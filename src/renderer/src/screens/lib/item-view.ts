/*
 * Reading a list of items, and the choices an item editor may offer.
 *
 * Everything here is a pure question about data main has already sent. Nothing computes
 * money (CONVENTIONS §1.7), nothing decides whether an HSN code is real — that is the
 * regime's answer, arriving as `ITEM_CLASSIFICATION_INVALID` with a sentence written for
 * the user — and nothing decides what a price should be normalised to. The screen shows
 * what came back.
 *
 * WHY SEARCH IS DONE HERE AND NOT BY `items.list`. The same reason party-view gives:
 * `ListItemsInput.search` exists for the item picker a document line will need, where the
 * list is long and the control is a dropdown. A masters screen holds tens to a few
 * hundred rows, filtering them locally is instant, and it cannot get out of step with
 * what has been typed. The three fields searched are deliberately the three the
 * repository's own `search` matches — name, SKU and classification code — so the picker
 * and this screen answer the same question.
 *
 * THE TWO OPTION BUILDERS EXIST FOR ONE FAILURE, and it is the one a rendered assertion
 * cannot see. A `<select>` whose chosen `<option>` is not present falls back to its first
 * one, silently, in the browser — so an item measured in a unit that has since been
 * archived would draw a picker reading `BOX`, send `BOX` on the next save, and quietly
 * remeasure the item. Both builders therefore keep the CURRENT value in the list however
 * archived it is, and mark it, rather than dropping it and letting the control choose.
 */

import type {
  Account,
  AppError,
  ClassificationSchemeInfo,
  ItemKind,
  ItemSummary,
  UnitOfMeasure,
} from '@shared/dto'

/**
 * The rows a search should show. An empty query returns everything.
 *
 * As `filterParties`, the early return is a shortcut rather than a rule — every item has
 * a name and `name.includes('')` is true — and a mutation deleting it survives on
 * purpose. It stays because handing back the original array when nothing was asked for
 * is worth one line.
 */
export function filterItems(items: readonly ItemSummary[], query: string): readonly ItemSummary[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return items

  return items.filter((item) =>
    [item.name, item.code, item.classificationCode].some(
      (field) => field !== null && field.toLowerCase().includes(needle),
    ),
  )
}

/*
 * What each kind is called, as a TOTAL RECORD over the union (CONVENTIONS §1.9).
 *
 * A ternary would be indistinguishable from this for exactly as long as there are two
 * kinds, and would silently give a third whatever the else-branch said. This does not
 * compile until a new kind is answered for.
 */
export const ITEM_KIND_LABELS: Record<ItemKind, string> = {
  goods: 'Goods',
  service: 'Service',
}

/*
 * The same kinds as a LIST, because a picker needs an order and a record has none.
 *
 * Spelled out rather than derived from the record's keys, exactly as `ITEM_KINDS` is in
 * src/main/ipc/handlers/items.ts and for the same reason: a type has no runtime values.
 * `satisfies` stops a kind that does not exist from appearing here, and the test next
 * door stops one that does exist from being left out — which `satisfies` cannot see.
 */
export const ITEM_KINDS = ['goods', 'service'] as const satisfies readonly ItemKind[]

export function itemKindLabel(kind: ItemKind): string {
  return ITEM_KIND_LABELS[kind]
}

/**
 * The kind a `<select>` reported, narrowed.
 *
 * A control hands back a string, and the contract wants a member of a closed union.
 * Matching against the list rather than casting is what makes an unknown value land
 * somewhere stated — on `goods`, which is what a new item starts as — instead of being
 * asserted into the type and refused three layers down by the boundary.
 */
export function parseItemKind(value: string): ItemKind {
  const [match] = ITEM_KINDS.filter((kind) => kind === value)
  return match ?? 'goods'
}

/**
 * Which side of the books an item is on, in words.
 *
 * `Both` rather than `Sold and purchased`, for the reason `partyKindLabel` gives: it sits
 * in a narrow column, and the long form invites reading it as two records. An item that
 * is NEITHER is refused by the repository and has no label here — the editor stops that
 * before it is sent.
 */
export function itemSideLabel(item: Pick<ItemSummary, 'isSold' | 'isPurchased'>): string {
  if (item.isSold && item.isPurchased) return 'Both'
  if (item.isPurchased) return 'Purchased'
  return 'Sold'
}

/** One entry in the unit picker. */
export interface UnitOption {
  code: string
  label: string
  isArchived: boolean
}

/**
 * The units an item may be measured in, plus the one it already is.
 *
 * TWO CONDITIONS, AND EACH EXCLUDES SOMETHING THE OTHER ADMITS. An archived unit reaches
 * no picker, because offering one lets somebody measure a new item in something the
 * business has retired. The exception is the unit THIS item already holds: dropping it
 * would make the control fall back to its first option, and the next save would send a
 * unit nobody chose.
 *
 * Order is main's, untouched. `listUnits` orders by code — what the user typed and what
 * prints — and re-sorting here would put the picker in one order and the list in another.
 */
export function unitOptions(
  units: readonly UnitOfMeasure[],
  selected: string,
): readonly UnitOption[] {
  return units
    .filter((unit) => !unit.isArchived || unit.code === selected)
    .map((unit) => ({
      code: unit.code,
      label: `${unit.code} — ${unit.name}${unit.isArchived ? ' (archived)' : ''}`,
      isArchived: unit.isArchived,
    }))
}

/** One entry in an account override picker. */
export interface AccountOption {
  id: string
  label: string
  isArchived: boolean
}

/**
 * The accounts an item's value may be posted to, plus the one it already names.
 *
 * A GROUP IS NEVER OFFERED. It totals its children and holds no figures of its own, and
 * `postingAccountOf` refuses one with `ITEM_ACCOUNT_IS_GROUP` — a picker that offers it
 * is a picker whose every entry is not a valid answer.
 *
 * Archived accounts are kept out for the reason units are, with the same exception and
 * the same consequence if it were dropped. An item pointing at an account archived after
 * the item was saved stays editable — the repository re-checks an account only when one
 * is sent — so the editor has to be able to show it.
 */
export function accountOptions(
  accounts: readonly Account[],
  selected: string,
): readonly AccountOption[] {
  return accounts
    .filter((account) => !account.isGroup && (!account.isArchived || account.id === selected))
    .map((account) => ({
      id: account.id,
      label: `${account.code} — ${account.name}${account.isArchived ? ' (archived)' : ''}`,
      isArchived: account.isArchived,
    }))
}

/** The fields an editor can put a refusal underneath. */
export type ItemField = 'name' | 'code' | 'unitCode' | 'classificationCode'

/*
 * Which field a refusal belongs under.
 *
 * A LOOKUP AND NOT A CHAIN, and the codes are main's own. An error that names one field
 * reads best beside it — somebody who mistyped one digit of an HSN should see the
 * regime's sentence under the HSN box, not in a banner above eleven other fields. Every
 * other code has no field to sit under and goes to the notice at the top of the dialog,
 * which is what the `?? null` says.
 *
 * The codes come from src/main/db/repos/items.ts and units.ts, and from
 * `checkClassification` in src/main/items/service.ts.
 */
const ITEM_ERROR_FIELDS: Record<string, ItemField> = {
  ITEM_CLASSIFICATION_INVALID: 'classificationCode',
  ITEM_NAME_TAKEN: 'name',
  ITEM_CODE_TAKEN: 'code',
  UNIT_NOT_FOUND: 'unitCode',
  UNIT_ARCHIVED: 'unitCode',
}

export function itemErrorField(error: AppError): ItemField | null {
  return ITEM_ERROR_FIELDS[error.code] ?? null
}

/**
 * The guidance under the classification box.
 *
 * IT DESCRIBES THE REGIME'S RULE; IT DOES NOT APPLY IT. `validLengths` arrives in
 * `RegimeDescription` already, so saying "4, 6 or 8 digits" is reading data main sent —
 * the same licence the place-of-supply picker has to list jurisdictions. Whether a
 * particular code is one the schedule holds is still asked and answered in the main
 * process, and a second, weaker copy of that check here is exactly what this codebase
 * keeps deleting.
 *
 * The sentence about separators is the one users need most and cannot guess: `8471.30`
 * is accepted, and what is stored is `847130`.
 */
export function classificationHint(scheme: ClassificationSchemeInfo): string {
  const lengths = joinWithOr(scheme.validLengths)
  const shape = lengths === '' ? '' : ` ${lengths} digits.`
  return `Optional — leave it empty where none applies.${shape} Dots and spaces are fine; what is stored is the code without them.`
}

/** '4', '4 or 6', '4, 6 or 8'. Empty for an empty list. */
function joinWithOr(values: readonly number[]): string {
  const written = values.map((value) => String(value))
  const last = written.at(-1)
  if (last === undefined) return ''
  if (written.length === 1) return last
  return `${written.slice(0, -1).join(', ')} or ${last}`
}
