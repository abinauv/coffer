import { describe, expect, it } from 'vitest'
import type { Account, ItemSummary, UnitOfMeasure } from '@shared/dto'
import {
  accountOptions,
  classificationHint,
  filterItems,
  ITEM_KINDS,
  ITEM_KIND_LABELS,
  itemErrorField,
  itemKindLabel,
  itemSideLabel,
  parseItemKind,
  unitOptions,
} from './item-view'

function item(over: Partial<ItemSummary> & Pick<ItemSummary, 'name'>): ItemSummary {
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
  item({ name: 'Ball bearing 6203', code: 'BB-6203', classificationCode: '848210' }),
  item({ name: 'Freight', isCharge: true }),
  item({ name: 'Installation visit', kind: 'service', classificationCode: '998719' }),
]

const names = (rows: readonly ItemSummary[]): string[] => rows.map((row) => row.name)

describe('filterItems', () => {
  it('returns everything for an empty query', () => {
    expect(filterItems(LIST, '')).toHaveLength(3)
    expect(filterItems(LIST, '   ')).toHaveLength(3)
  })

  it('matches a name, ignoring case', () => {
    expect(names(filterItems(LIST, 'BALL'))).toEqual(['Ball bearing 6203'])
  })

  /* An SKU is what a storeman has on a bin label and quite possibly not the trading
   * name, which is the whole reason the column exists. */
  it('matches an item code', () => {
    expect(names(filterItems(LIST, 'bb-62'))).toEqual(['Ball bearing 6203'])
  })

  /* And an accountant reconciling a return has the HSN in front of them. The repository's
   * own `search` matches these same three fields, so the picker and this screen answer
   * the same question. */
  it('matches a classification code', () => {
    expect(names(filterItems(LIST, '998719'))).toEqual(['Installation visit'])
  })

  it('matches nothing rather than everything when nothing matches', () => {
    expect(filterItems(LIST, 'zzz')).toHaveLength(0)
  })

  it('does not trip over an item with no code and no classification', () => {
    expect(filterItems([item({ name: 'Freight' })], '848210')).toHaveLength(0)
  })
})

describe('itemKindLabel', () => {
  it('names each kind', () => {
    expect(itemKindLabel('goods')).toBe('Goods')
    expect(itemKindLabel('service')).toBe('Service')
  })

  /*
   * `satisfies readonly ItemKind[]` refuses a kind that does not exist and says nothing
   * at all about one that was left out — so a third kind added to the union would compile
   * with a picker that never offers it. The record is total and cannot miss one; this
   * pins the list to the record.
   */
  it('lists exactly the kinds the label table answers for', () => {
    expect([...ITEM_KINDS].sort()).toEqual(Object.keys(ITEM_KIND_LABELS).sort())
  })
})

describe('parseItemKind', () => {
  it('keeps a kind a picker really offered', () => {
    expect(parseItemKind('service')).toBe('service')
    expect(parseItemKind('goods')).toBe('goods')
  })

  /* Anything else lands somewhere stated rather than being asserted into the type and
   * refused by the boundary three layers down. */
  it('falls back to goods for anything else', () => {
    expect(parseItemKind('Service')).toBe('goods')
    expect(parseItemKind('')).toBe('goods')
  })
})

describe('itemSideLabel', () => {
  it('says which side an item is on, and says Both when it is on two', () => {
    expect(itemSideLabel({ isSold: true, isPurchased: false })).toBe('Sold')
    expect(itemSideLabel({ isSold: false, isPurchased: true })).toBe('Purchased')
    expect(itemSideLabel({ isSold: true, isPurchased: true })).toBe('Both')
  })
})

describe('unitOptions', () => {
  /* Listed in the order `listUnits` returns them — by code — and deliberately NOT in
   * alphabetical order here, so a sort added to this function would change the answer. */
  const UNITS: UnitOfMeasure[] = [
    unit({ code: 'NOS', name: 'Numbers' }),
    unit({ code: 'BUNDLE', name: 'Bundles of ten' }),
    unit({ code: 'KGS', name: 'Kilograms' }),
  ]

  it('offers every active unit, in the order main sent them', () => {
    expect(unitOptions(UNITS, '').map((option) => option.code)).toEqual(['NOS', 'BUNDLE', 'KGS'])
  })

  it('labels a unit with its code and its name', () => {
    expect(unitOptions(UNITS, '')[2]?.label).toBe('KGS — Kilograms')
  })

  /* An archived unit reaches no picker: offering one lets somebody measure a new item in
   * something the business has retired. */
  it('leaves out an archived unit nothing is measured in', () => {
    const withRetired = [...UNITS, unit({ code: 'DOZ', name: 'Dozens', isArchived: true })]
    expect(unitOptions(withRetired, '').map((option) => option.code)).not.toContain('DOZ')
  })

  /*
   * THE CASE A RENDERED ASSERTION CANNOT SEE. A `<select>` whose value names no option
   * falls back to its first one on its own, so an item measured in a unit archived after
   * it was saved would draw a picker reading `NOS` and send `NOS` on the next save. The
   * archived unit stays in the list exactly when it is the one selected.
   */
  it('keeps the archived unit this item already holds, and marks it', () => {
    const withRetired = [...UNITS, unit({ code: 'DOZ', name: 'Dozens', isArchived: true })]
    const options = unitOptions(withRetired, 'DOZ')

    expect(options.map((option) => option.code)).toEqual(['NOS', 'BUNDLE', 'KGS', 'DOZ'])
    expect(options.at(-1)?.label).toBe('DOZ — Dozens (archived)')
    expect(options.at(-1)?.isArchived).toBe(true)
  })

  /* Selecting a code that is not in the list invents nothing — a unit deleted elsewhere
   * is gone, and a fabricated option would be an option that cannot be saved. */
  it('invents nothing for a code no unit carries', () => {
    expect(unitOptions(UNITS, 'TIN').map((option) => option.code)).toEqual(['NOS', 'BUNDLE', 'KGS'])
  })

  it('has nothing to offer on books with no units at all', () => {
    expect(unitOptions([], '')).toHaveLength(0)
  })
})

describe('accountOptions', () => {
  /* Out of code order on purpose: the chart arrives depth-first from main and re-sorting
   * it here would put the picker in one order and the chart screen in another. */
  const ACCOUNTS: Account[] = [
    account({ id: 'income', code: '4000', name: 'Income', isGroup: true }),
    account({ id: 'sales', code: '4100', name: 'Sales' }),
    account({ id: 'scrap', code: '4050', name: 'Scrap sales' }),
  ]

  it('offers every postable account, in the order main sent them', () => {
    expect(accountOptions(ACCOUNTS, '').map((option) => option.id)).toEqual(['sales', 'scrap'])
  })

  it('labels an account with its code and its name', () => {
    expect(accountOptions(ACCOUNTS, '')[0]?.label).toBe('4100 — Sales')
  })

  /*
   * A group totals its children and holds no figures of its own — `postingAccountOf`
   * refuses one with `ITEM_ACCOUNT_IS_GROUP`. This fixture is neither archived nor
   * selected, so nothing but the group test can exclude it.
   */
  it('never offers a group, however ordinary it otherwise looks', () => {
    expect(accountOptions(ACCOUNTS, '').map((option) => option.id)).not.toContain('income')
  })

  /* Non-group and not selected, so nothing but the archived test can exclude it. */
  it('leaves out an archived account nothing points at', () => {
    const withRetired = [...ACCOUNTS, account({ id: 'old', code: '4200', isArchived: true })]
    expect(accountOptions(withRetired, '').map((option) => option.id)).not.toContain('old')
  })

  /*
   * An item may keep an account archived after it was saved — the repository re-checks an
   * account only when one is sent — so the editor has to be able to show it. Without this
   * clause the select would silently fall back to `4100 Sales` and the next save would
   * move the item's revenue.
   */
  it('keeps the archived account this item already names, and marks it', () => {
    const withRetired = [
      ...ACCOUNTS,
      account({ id: 'old', code: '4200', name: 'Discontinued line', isArchived: true }),
    ]
    const options = accountOptions(withRetired, 'old')

    expect(options.map((option) => option.id)).toEqual(['sales', 'scrap', 'old'])
    expect(options.at(-1)?.label).toBe('4200 — Discontinued line (archived)')
  })

  /* Selection does not override the group rule — a group is refused whether or not
   * anything points at it, and the repository would refuse it too. */
  it('still refuses a group that is somehow the selected one', () => {
    expect(accountOptions(ACCOUNTS, 'income').map((option) => option.id)).toEqual([
      'sales',
      'scrap',
    ])
  })
})

describe('itemErrorField', () => {
  /* The regime's refusal belongs under the box it is about, so that somebody who mistyped
   * one digit can see which digit. */
  it('puts a classification refusal under the classification box', () => {
    expect(
      itemErrorField({
        code: 'ITEM_CLASSIFICATION_INVALID',
        message: 'An HSN code is 4, 6 or 8 digits.',
      }),
    ).toBe('classificationCode')
  })

  it('puts the two uniqueness refusals under the boxes that clashed', () => {
    expect(itemErrorField({ code: 'ITEM_NAME_TAKEN', message: '' })).toBe('name')
    expect(itemErrorField({ code: 'ITEM_CODE_TAKEN', message: '' })).toBe('code')
  })

  it('puts a refusal about the unit under the unit picker', () => {
    expect(itemErrorField({ code: 'UNIT_NOT_FOUND', message: '' })).toBe('unitCode')
    expect(itemErrorField({ code: 'UNIT_ARCHIVED', message: '' })).toBe('unitCode')
  })

  /* Everything else has nowhere better to be than the notice at the top of the dialog,
   * which is what the screen draws when this answers null. */
  it('has no field for a refusal that names none', () => {
    expect(itemErrorField({ code: 'ITEM_HAS_NO_SIDE', message: '' })).toBeNull()
    expect(itemErrorField({ code: 'NO_COMPANY_OPEN', message: '' })).toBeNull()
  })
})

describe('classificationHint', () => {
  /*
   * The lengths come from `RegimeDescription`, which is data main sent — the same licence
   * the place-of-supply picker has to list jurisdictions. Nothing here decides whether a
   * particular code is one the schedule holds.
   */
  it('names the digit counts the regime allows', () => {
    expect(
      classificationHint({ code: 'HSN', label: 'HSN / SAC', validLengths: [4, 6, 8] }),
    ).toContain('4, 6 or 8 digits.')
  })

  it('reads correctly when the regime allows one length, or two', () => {
    expect(classificationHint({ code: 'HSN', label: 'HSN', validLengths: [8] })).toContain(
      '8 digits.',
    )
    expect(classificationHint({ code: 'HSN', label: 'HSN', validLengths: [4, 6] })).toContain(
      '4 or 6 digits.',
    )
  })

  /* A regime that constrains nothing says nothing about lengths rather than an empty
   * sentence with a stray full stop in it. */
  it('says nothing about lengths where the regime constrains none', () => {
    const hint = classificationHint({ code: 'NCM', label: 'NCM', validLengths: [] })
    expect(hint).not.toMatch(/digits/)
    expect(hint).toMatch(/^Optional — leave it empty where none applies\. Dots/)
  })

  /*
   * The sentence users need most and cannot guess: `8471.30` is accepted and `847130` is
   * what is stored. Without it, somebody types the code off a schedule with its dot in
   * and has no reason to expect the field to change under them.
   */
  it('always says separators do not survive the save', () => {
    for (const lengths of [[], [4, 6, 8]]) {
      expect(classificationHint({ code: 'HSN', label: 'HSN', validLengths: lengths })).toContain(
        'what is stored is the code without them',
      )
    }
  })
})
