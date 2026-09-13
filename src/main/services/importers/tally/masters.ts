/*
 * TURNING TALLY'S MASTERS INTO COFFER'S. The half of the import where the two products
 * disagree about what a thing IS, rather than about what it is called.
 *
 * ---------------------------------------------------------------------------
 * 1. A CUSTOMER LEDGER IS A PARTY. IT IS NOT AN ACCOUNT.
 *
 * Tally gives every customer its own ledger account under `Sundry Debtors`, so a company
 * with four hundred customers has four hundred accounts in its chart. Coffer keeps ONE
 * control account per side and puts the party on the line (docs/data-model.md), because a
 * chart holding four hundred customers is not a chart anybody can read and because every
 * one of those accounts would then appear on the balance sheet.
 *
 * So the parent chain decides which collection a ledger lands in, and it is the SAME
 * decision, made once: a chain reaching a group with a `party` side produces a
 * `StagedParty`; any other classified chain produces a `StagedAccount`; a chain that
 * resolves to nothing produces NEITHER and is reported. This is where the switching cost
 * actually lives — an importer that got this wrong would produce books that look right and
 * an aged report that cannot be drawn.
 *
 * ---------------------------------------------------------------------------
 * 2. AN OPENING BALANCE'S SIGN IS TRANSLATED EXACTLY ONCE, AND ONLY WHEN THE TYPE IS KNOWN.
 *
 * Tally writes an opening balance in its own convention: negative for a debit balance,
 * positive for a credit. `StagedOpeningBalance.amount` is defined the other way round — it
 * is POSITIVE IN THE ACCOUNT'S NORMAL DIRECTION, so a bank with 50,000 in it and a loan of
 * 50,000 owed are both `'50000.00'` — precisely so that a user's old trial balance is not
 * translated twice.
 *
 * Turning one into the other needs the account's NORMAL BALANCE, which comes from its
 * type, which comes from the parent chain. So a ledger whose chain did not resolve has NO
 * SAFE READING of its opening balance: both signs are plausible, both produce a trial
 * balance that adds up, and the wrong one is discovered a year later by somebody who
 * cannot work out why a supplier shows as an asset. That balance is dropped and the
 * sentence saying so is part of the same issue that reports the chain, so the user reads
 * one message and knows both consequences.
 *
 * A ZERO opening balance is not staged, and neither is an absent one. Two conditions, and
 * the fixture carries a ledger for each: without both rows, deleting either condition
 * changes no result the suite can see (CONVENTIONS §6).
 *
 * ---------------------------------------------------------------------------
 * 3. A STOCK ITEM IS GOODS UNLESS THE FILE SAYS OTHERWISE, AND THAT IS A STATED DEFAULT.
 *
 * A Tally STOCKITEM is stock: a thing with a quantity and a unit. A service in Tally is a
 * LEDGER under an income group, not a stock item, so it never reaches this function.
 * Newer releases state the supply type explicitly and it is read; older ones do not, and
 * `goods` is the default rather than a guess dressed as a reading — an unrecognised value
 * is reported instead of being folded into the default, which is the difference between a
 * default and a shrug.
 */

import { D, toMoneyString, type Decimal, type DecimalString } from '@main/domain/money'
import { normalBalanceOf, type AccountType } from '@main/domain/ledger'

import { normaliseHeading } from '../csv'
import type {
  BatchIssue,
  StagedAccount,
  StagedItem,
  StagedOpeningBalance,
  StagedParty,
  StagedUnit,
} from '../model'
import { classifyTallyLedger, type TallyGroupRule, type TallyLedgerRole } from './classify'
import { elementKey } from './elements'
import type { TallyRawLedger, TallyRawStockItem, TallyRawUnit } from './read'

import type { ItemKind } from '@shared/dto'

/**
 * Every ledger in the export, classified.
 *
 * Built ONCE, after every file has been read, for the reason `read.ts` gives at length: a
 * real export introduces a ledger after the voucher that uses it, and often in a different
 * file altogether.
 */
export interface TallyChart {
  /** `elementKey(name)` -> what the parent chain says it is. */
  readonly roles: ReadonlyMap<string, TallyLedgerRole>
  /** `elementKey(name)` -> the ledger as read, for its source id and its details. */
  readonly ledgers: ReadonlyMap<string, TallyRawLedger>
}

/** What one ledger name resolved to, or null when the export never mentioned it. */
export function chartRoleOf(chart: TallyChart, ledger: string): TallyLedgerRole | null {
  return chart.roles.get(elementKey(ledger)) ?? null
}

/** The ledger master for one name, or null. */
export function chartLedgerOf(chart: TallyChart, ledger: string): TallyRawLedger | null {
  return chart.ledgers.get(elementKey(ledger)) ?? null
}

/**
 * Classify every ledger against the group tree, reporting each chain that does not resolve.
 *
 * The report says what the chain WAS as well as where it stopped, because "Coffer could
 * not place ABC Traders" is a sentence nobody can act on and "ABC Traders is under
 * Karnataka Customers, and this export has no group of that name" is one they can.
 */
export function buildTallyChart(
  ledgers: readonly TallyRawLedger[],
  groupParents: ReadonlyMap<string, string>,
  rules: readonly TallyGroupRule[],
  issues: BatchIssue[],
): TallyChart {
  const roles = new Map<string, TallyLedgerRole>()
  const byKey = new Map<string, TallyRawLedger>()

  for (const ledger of ledgers) {
    const key = elementKey(ledger.name)
    const role = classifyTallyLedger(ledger.parent, groupParents, rules)
    roles.set(key, role)
    byKey.set(key, ledger)

    if (role.kind === 'ambiguous') {
      issues.push({
        code: 'UNKNOWN_ACCOUNT_TYPE',
        severity: 'warning',
        message:
          `${JSON.stringify(ledger.name)} is under ${JSON.stringify(role.group)}, and Coffer has ` +
          `more than one rule for a group of that name (${role.candidates.join(', ')}). It will ` +
          'not choose between them, so this ledger has not been classified.' +
          droppedBalance(ledger),
        file: ledger.provenance[0]?.file,
        line: ledger.provenance[0]?.line,
        rowNumber: ledger.provenance[0]?.rowNumber,
        field: 'parent',
        value: role.group,
        sourceId: ledger.sourceId,
      })
      continue
    }
    if (role.kind === 'unresolved') {
      issues.push({
        code: 'UNKNOWN_ACCOUNT_TYPE',
        severity: 'warning',
        message:
          `Coffer cannot tell what ${JSON.stringify(ledger.name)} is: ${role.because}` +
          droppedBalance(ledger),
        file: ledger.provenance[0]?.file,
        line: ledger.provenance[0]?.line,
        rowNumber: ledger.provenance[0]?.rowNumber,
        field: 'parent',
        value: ledger.parent,
        sourceId: ledger.sourceId,
      })
    }
  }

  return { roles, ledgers: byKey }
}

/** What staging the ledger masters produced. */
export interface StagedLedgers {
  readonly parties: readonly StagedParty[]
  readonly accounts: readonly StagedAccount[]
  readonly openingBalances: readonly StagedOpeningBalance[]
}

/**
 * Turn classified ledgers into parties, accounts and opening balances.
 *
 * In the order the export introduced them, which is the order a user's own eye is in —
 * the same reasoning `buildLedgerMapping` gives for preserving first-encounter order.
 */
export function stageTallyLedgers(
  ledgers: readonly TallyRawLedger[],
  chart: TallyChart,
): StagedLedgers {
  const parties: StagedParty[] = []
  const accounts: StagedAccount[] = []
  const openingBalances: StagedOpeningBalance[] = []

  for (const ledger of ledgers) {
    const role = chart.roles.get(elementKey(ledger.name))
    if (role === undefined || role.kind === 'unresolved' || role.kind === 'ambiguous') {
      continue
    }

    if (role.kind === 'party') {
      parties.push({
        sourceId: ledger.sourceId,
        name: ledger.name,
        isCustomer: role.side === 'sales',
        isVendor: role.side === 'purchase',
        ...(ledger.registrationNumber === null
          ? {}
          : { registrationNumber: ledger.registrationNumber }),
        ...(ledger.jurisdictionName === null ? {} : { jurisdictionName: ledger.jurisdictionName }),
        ...(ledger.countryName === null ? {} : { countryName: ledger.countryName }),
        ...(ledger.email === null ? {} : { email: ledger.email }),
        ...(ledger.paymentTermsDays === null ? {} : { paymentTermsDays: ledger.paymentTermsDays }),
        provenance: ledger.provenance,
      })
    } else {
      accounts.push({
        sourceId: ledger.sourceId,
        name: ledger.name,
        type: role.type,
        /* The source's own word for what this is: the group the chain landed on, which is
         * what a user recognises and what makes a wrong classification visible without
         * re-reading the file. */
        sourceType: role.group,
        ...(ledger.parent === '' ? {} : { parentName: ledger.parent }),
        provenance: ledger.provenance,
      })
    }

    const opening = openingBalanceOf(ledger, role)
    if (opening !== null) {
      openingBalances.push(opening)
    }
  }

  return { parties, accounts, openingBalances }
}

/**
 * One ledger's opening balance, in the account's normal direction, or null.
 *
 * Null for an absent balance AND for a zero one, which are two conditions and not one: a
 * ledger that states `0.00` and a ledger that states nothing both produce no opening
 * figure, and a fixture needs both rows or deleting either test changes nothing anybody
 * can see.
 */
export function openingBalanceOf(
  ledger: TallyRawLedger,
  role: TallyLedgerRole,
): StagedOpeningBalance | null {
  if (ledger.openingBalance === null) {
    return null
  }
  const stated = D(ledger.openingBalance)
  if (stated.isZero()) {
    return null
  }
  if (role.kind !== 'party' && role.kind !== 'account') {
    return null
  }

  const amount = toMoneyString(inNormalDirection(stated, role.type))
  if (role.kind === 'party') {
    return {
      sourceId: `opening:${ledger.sourceId}`,
      ledger: { kind: 'role', role: role.role },
      partySourceId: ledger.sourceId,
      partyName: ledger.name,
      amount,
      provenance: ledger.provenance,
    }
  }
  return {
    sourceId: `opening:${ledger.sourceId}`,
    ledger: { kind: 'name', ledger: ledger.name },
    amount,
    provenance: ledger.provenance,
  }
}

/**
 * Tally's sign turned into Coffer's.
 *
 * Tally writes a DEBIT balance as a negative. An account whose normal balance is a debit
 * therefore reads back positive after a negation, and one whose normal balance is a credit
 * reads back positive as written. A total record over the two normal balances, not a
 * condition on the type: adding an account type does not change this answer, but reading
 * it off `normalBalanceOf` means the two can never disagree.
 */
function inNormalDirection(stated: Decimal, type: AccountType): Decimal {
  return normalBalanceOf(type) === 'debit' ? stated.negated() : stated
}

/** Tally's supply types, and what each is in Coffer's terms. Anything else is reported. */
const TALLY_SUPPLY_TYPES: Readonly<Record<string, ItemKind>> = {
  goods: 'goods',
  services: 'service',
  service: 'service',
}

/** How a stock item was used across the export's vouchers. */
export interface ItemUsage {
  readonly sold: ReadonlySet<string>
  readonly purchased: ReadonlySet<string>
}

/**
 * Stage the stock items.
 *
 * `isSold` and `isPurchased` come from the VOUCHERS, exactly as the Zoho importer works a
 * party's roles out from its transactions — an item on a sales voucher is sold and an item
 * on a purchase voucher is bought, and an item on both is both. An item NO voucher
 * mentions gets both, because Tally has no flag restricting a stock item to one side of
 * the trade and a masters-only export would otherwise produce a catalogue of items nobody
 * may sell or buy.
 */
export function stageTallyItems(
  items: readonly TallyRawStockItem[],
  usage: ItemUsage,
  issues: BatchIssue[],
): readonly StagedItem[] {
  return items.map((item) => {
    const key = elementKey(item.name)
    const sold = usage.sold.has(key)
    const purchased = usage.purchased.has(key)
    const unused = !sold && !purchased

    let kind: ItemKind = 'goods'
    if (item.supplyType !== null) {
      const known = TALLY_SUPPLY_TYPES[normaliseHeading(item.supplyType)]
      if (known === undefined) {
        issues.push({
          code: 'UNKNOWN_ITEM_KIND',
          severity: 'warning',
          message:
            `${JSON.stringify(item.name)} is a ${JSON.stringify(item.supplyType)} in this export, ` +
            'which Coffer does not recognise, so it has been brought in as goods. Change it if ' +
            'that is wrong.',
          file: item.provenance[0]?.file,
          line: item.provenance[0]?.line,
          rowNumber: item.provenance[0]?.rowNumber,
          field: 'supplyType',
          value: item.supplyType,
          sourceId: item.sourceId,
        })
      } else {
        kind = known
      }
    }

    return {
      sourceId: item.sourceId,
      name: item.name,
      kind,
      ...(item.description === null ? {} : { description: item.description }),
      ...(item.unitLabel === null ? {} : { unitLabel: item.unitLabel }),
      isSold: unused || sold,
      isPurchased: unused || purchased,
      provenance: item.provenance,
    }
  })
}

/**
 * The units of the import: the UNIT masters, plus any unit a stock item names that has no
 * master of its own.
 *
 * `UnitOfMeasure.code` is the identity and is upper case, so `Nos`, `nos` and `NOS` are
 * one unit; `label` keeps what the file said, which is what a user recognises. The same
 * rule the Zoho importer keeps, written the same way, so the two imports cannot produce
 * two different unit lists from one company's data.
 */
export function stageTallyUnits(
  units: readonly TallyRawUnit[],
  items: readonly TallyRawStockItem[],
): readonly StagedUnit[] {
  const staged = new Map<string, StagedUnit>()
  const add = (
    label: string | null,
    decimalPlaces: number | null,
    provenance: TallyRawUnit['provenance'],
  ): void => {
    if (label === null) {
      return
    }
    const code = label.trim().toUpperCase()
    if (code === '' || staged.has(code)) {
      return
    }
    staged.set(code, {
      code,
      label: label.trim(),
      ...(decimalPlaces === null ? {} : { decimalPlaces }),
      provenance,
    })
  }

  for (const unit of units) {
    add(unit.name, unit.decimalPlaces, unit.provenance)
  }
  for (const item of items) {
    add(item.unitLabel, null, item.provenance)
  }
  return [...staged.values()]
}

// ---- Internals ------------------------------------------------------------

function droppedBalance(ledger: TallyRawLedger): string {
  if (ledger.openingBalance === null || D(ledger.openingBalance).isZero()) {
    return ''
  }
  return (
    ` Its opening balance of ${ledger.openingBalance} has not been brought in either: which ` +
    'way round it goes depends on what kind of account this is, and both readings balance.'
  )
}

/** The staged amount for one balance, exposed so a test can state the translation directly. */
export function openingAmountFor(stated: DecimalString, type: AccountType): DecimalString {
  return toMoneyString(inNormalDirection(D(stated), type))
}
