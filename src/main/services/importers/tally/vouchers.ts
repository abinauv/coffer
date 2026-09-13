/*
 * TURNING ONE TALLY VOUCHER INTO WHAT COFFER STAGES. Six decisions, in the order they are
 * made, and each one is a way an importer can be wrong while looking right.
 *
 * ---------------------------------------------------------------------------
 * 1. THE VOUCHER MUST SUM TO ZERO, AND IT IS NEVER FORCED TO.
 *
 * Tally writes debits negative and credits positive, so a voucher's entries add to zero.
 * When they do not, something upstream has already gone wrong — a truncated export, a
 * connector that dropped an entry, a hand-written import file — and there are exactly two
 * things this module can do about it. It can plug the difference somewhere, which produces
 * a voucher that posts and is wrong by a figure nobody will ever find; or it can refuse the
 * voucher and say by how much. It refuses. The message carries both totals and the
 * difference, because that is what somebody needs in order to go and look.
 *
 * A REFUSAL HERE IS ONE VOUCHER, NEVER THE FILE. Eight hundred vouchers with one bad one
 * import seven hundred and ninety-nine.
 *
 * ---------------------------------------------------------------------------
 * 2. THE PARTY IS AN ENTRY, FOUND TWO WAYS, AND WHICH WAY IS RECORDED.
 *
 * Coffer needs to know WHICH of a voucher's entries is the customer or supplier, because
 * that entry is the party and every other entry is a line. Tally states it twice and
 * neither statement is always there:
 *
 *   THE PARENT CHAIN   is the sharp answer — the entry whose ledger hangs under Sundry
 *                      Debtors or Sundry Creditors. It needs the masters, which a
 *                      vouchers-only export does not carry.
 *   `PARTYLEDGERNAME`  is on the voucher itself, so it survives a vouchers-only export,
 *                      and it is absent from receipts and payments in plenty of files.
 *
 * So the chain is asked first and the name is the fallback, and when the two DISAGREE the
 * chain wins and the disagreement is reported — the chain is a fact about the chart and
 * the name is a field somebody can leave stale by renaming a ledger.
 *
 * TWO PARTY ENTRIES IS A REFUSAL, not a choice of the first. A sales voucher against two
 * debtors has no single customer, and `.find` here would make the answer the order Tally
 * happened to write the entries in (CONVENTIONS §1.9).
 *
 * ---------------------------------------------------------------------------
 * 3. A DOCUMENT'S LINES ARE ITS LEDGER ENTRIES, AND THAT IS A TRADE-OFF WORTH STATING.
 *
 * A Tally sales voucher carries two parallel descriptions of itself: the ACCOUNTING
 * entries (the customer, the sales ledger, the levies) and, when the company runs
 * inventory, the STOCK entries (item, quantity, rate). They describe the same money.
 *
 * The lines staged here are the LEDGER entries, and the stock entries are not staged at
 * all. The reason is that the two cannot be combined without a sample export: whether a
 * given voucher's stock entries duplicate its sales ledger entry, or sit beside it, or are
 * allocated across several ledgers, is a per-voucher fact carried in a nested structure
 * this reader does not walk. Staging both would double every invoice; choosing between
 * them per voucher would be a guess about somebody's books.
 *
 * WHAT IS LOST is the item, the quantity and the rate on each line. WHAT IS KEPT is every
 * rupee: the value, the ledgers it lands on, the party and the total. For an import whose
 * job is that the books come across correctly, that is the right half to keep, and the
 * other half is a later batch's work with a real file in front of it.
 *
 * ---------------------------------------------------------------------------
 * 4. A LEVY IS NOT A LINE, OR THE INVOICE IS CHARGED TWICE.
 *
 * The entries under a group marked `recomputed` — `Duties & Taxes` — are left off the
 * lines. Coffer's documents service computes the levy from the lines at write time, so an
 * entry that is both a line and a levy is charged twice and the invoice comes out higher
 * than the one the customer was given. See `TallyGroupRule.recomputed`; nothing here names
 * a tax, and the test is the parent group, which is the file's own word.
 *
 * When the export brings no masters the group is unknown, the entry becomes a line, and
 * the ledger goes to the mapping screen unplaced — which BLOCKS the write until somebody
 * decides. That is the right failure: it is visible, and it is a question rather than a
 * wrong number.
 *
 * ---------------------------------------------------------------------------
 * 5. THE SIGN OF A LINE IS THE PARTY'S SIGN, INVERTED. NOT THE DOCUMENT KIND'S.
 *
 * A line's `unitPrice` has to come out positive for an ordinary invoice and negative for
 * something that reduces it (a discount allowed, written on a sales voucher as a debit).
 * The rule is one multiplication: a line faces the opposite way from the party. On a sales
 * invoice the customer is debited, so credits are positive lines; on a purchase bill the
 * supplier is credited, so debits are positive lines. Reading it off the PARTY ENTRY
 * rather than off the document kind is CONVENTIONS §1.10 — a sign belongs to the thing,
 * never to the branch it arrived through — and it means a credit note needs no second
 * rule.
 *
 * ---------------------------------------------------------------------------
 * 6. A RECEIPT'S KIND IS THE DIRECTION TIMES THE SIDE. SEE `classify.ts`.
 *
 * A payment voucher whose party is a CUSTOMER is a refund, not a payment, and filing it as
 * a payment would put a customer's money into accounts payable where no statement of
 * theirs would ever show it. That mistake has already been made once in this codebase
 * (CONVENTIONS §1.9, 0015) and the lookup by two facts is what stops it being made again.
 *
 * ---------------------------------------------------------------------------
 * 7. A RECEIPT WITH A THIRD LEG IS NOT A RECEIPT COFFER CAN HOLD.
 *
 * A settlement discount, bank charges, tax withheld — all ordinary, and all of them make a
 * voucher whose money side and party side are different figures. `StagedReceipt` has one
 * amount and one account, so either the bank or the party comes out wrong, and both of the
 * two wrong answers look entirely reasonable on the screen that shows them. It is reported
 * and not staged; `moneyEntryOf` carries the argument in full.
 */

import { D, toMoneyString, toQuantityString, type Decimal } from '@main/domain/money'

import {
  documentFingerprint,
  receiptFingerprint,
  type BatchIssue,
  type SourceRow,
  type StagedAllocation,
  type StagedDocument,
  type StagedDocumentLine,
  type StagedReceipt,
} from '../model'
import {
  tallyBillTreatment,
  tallyReceiptKind,
  tallyVoucherTarget,
  type TallyBillTypeRule,
  type TallyVoucherTarget,
  type TallyVoucherTypeRule,
} from './classify'
import { elementKey } from './elements'
import { chartLedgerOf, chartRoleOf, type TallyChart } from './masters'
import type { TallyRawEntry, TallyRawVoucher } from './read'
import type { TallyEntrySide } from './values'

import { definitionOf, type DocumentKind, type TradeSide } from '@shared/documents'
import type { ReceiptKindDefinition } from '@shared/receipts'

export interface TallyVoucherOptions {
  readonly voucherTypes?: readonly TallyVoucherTypeRule[]
  readonly billTypes?: readonly TallyBillTypeRule[]
  readonly receiptKinds?: readonly ReceiptKindDefinition[]
}

/** One voucher, staged. Exactly one of `document` and `receipt` is filled in. */
export interface TallyStagedVoucher {
  readonly document: StagedDocument | null
  readonly receipt: StagedReceipt | null
  /** Which half of the trade the party is on, for the passes that need it afterwards. */
  readonly side: TradeSide
  readonly partyName: string
  readonly partySourceId: string | null
  readonly stockItems: readonly string[]
}

/**
 * Which way a line faces relative to the party entry.
 *
 * A total record over the three sides an entry can have, not a condition: `nil` is the
 * side of a zero-amount party entry, which multiplies nothing either way, and having to
 * answer for it here is exactly what a record buys over a ternary (CONVENTIONS §1.9).
 */
const LINE_SIGN: Readonly<Record<TallyEntrySide, 1 | -1>> = {
  debit: 1,
  credit: -1,
  nil: 1,
}

/**
 * Stage one voucher, or report why it could not be staged.
 *
 * Returns null for every refusal, and every refusal has pushed exactly one issue naming
 * the voucher. Nothing here throws: a voucher that cannot be read must not stop the other
 * seven hundred and ninety-nine.
 */
export function stageTallyVoucher(
  raw: TallyRawVoucher,
  chart: TallyChart,
  options: TallyVoucherOptions,
  issues: BatchIssue[],
): TallyStagedVoucher | null {
  const where = whereOf(raw)
  const report = (
    code: BatchIssue['code'],
    severity: BatchIssue['severity'],
    message: string,
    field: string,
    value?: string,
  ): void => {
    issues.push({
      code,
      severity,
      message,
      ...locate(raw),
      field,
      sourceId: raw.sourceId,
      ...(value === undefined ? {} : { value }),
    })
  }

  const lookup = tallyVoucherTarget(raw.voucherType, options.voucherTypes)
  if (lookup.kind === 'ambiguous') {
    report(
      'UNKNOWN_ACCOUNT_TYPE',
      'error',
      `Coffer has more than one rule for a voucher type called ` +
        `${JSON.stringify(raw.voucherType)} (${lookup.candidates.join(', ')}), so voucher ` +
        `${where} has not been imported. Fix the voucher-type table before importing.`,
      'voucherType',
      raw.voucherType,
    )
    return null
  }
  if (lookup.kind === 'unknown' && raw.voucherType === '') {
    /* Its own branch rather than a quoted empty string in the sentence above. A voucher
     * with NO type is a different problem from one with a type nobody has mapped — usually
     * VCHTYPE and VOUCHERTYPENAME disagreeing, which is reported just above this — and the
     * two send the user to different places. */
    report(
      'MISSING_VALUE',
      'error',
      `Voucher ${where} does not say what kind of voucher it is, so Coffer cannot tell whether ` +
        'it is a sale, a purchase, a receipt or a payment. It has not been imported.',
      'voucherType',
    )
    return null
  }
  if (lookup.kind === 'unknown') {
    report(
      'UNKNOWN_ACCOUNT_TYPE',
      'error',
      `${JSON.stringify(raw.voucherType)} is not a voucher type Coffer knows, so voucher ` +
        `${where} has not been imported. Tally lets you invent voucher types, so this is ` +
        'normal — tell Coffer whether it is a sale, a purchase, a receipt or a payment.',
      'voucherType',
      raw.voucherType,
    )
    return null
  }

  const target: TallyVoucherTarget = lookup.target
  if (target.kind === 'ignore') {
    report(
      'UNKNOWN_ACCOUNT_TYPE',
      'warning',
      `Voucher ${where} is a ${raw.voucherType} and has not been imported: ${target.because}`,
      'voucherType',
      raw.voucherType,
    )
    return null
  }

  const balance = balanceOf(raw.entries)
  if (!balance.difference.isZero()) {
    report(
      'INVALID_AMOUNT',
      'error',
      `Voucher ${where} does not balance: its debits come to ` +
        `${toMoneyString(balance.debits)} and its credits to ${toMoneyString(balance.credits)}, ` +
        `a difference of ${toMoneyString(balance.difference.abs())}. Coffer will not adjust a ` +
        'voucher to make it balance, so this one has not been imported.',
      'amount',
      toMoneyString(balance.difference),
    )
    return null
  }

  const party = findPartyEntry(raw, chart, report, where)
  if (party === null) {
    return null
  }

  return target.kind === 'document'
    ? stageDocument(raw, target.documentKind, party, chart, report)
    : stageReceipt(raw, target, party, options, report, where)
}

// ---- Internals ------------------------------------------------------------

type Report = (
  code: BatchIssue['code'],
  severity: BatchIssue['severity'],
  message: string,
  field: string,
  value?: string,
) => void

interface PartyEntry {
  readonly entry: TallyRawEntry
  readonly name: string
  readonly sourceId: string | null
  /** From the parent chain, or null when only `PARTYLEDGERNAME` identified the party. */
  readonly side: TradeSide | null
}

interface Balance {
  readonly debits: Decimal
  readonly credits: Decimal
  readonly difference: Decimal
}

/**
 * The two totals and the gap between them.
 *
 * The debits are the negative entries taken positively, which is Tally's convention read
 * back as bookkeeping. The difference is the plain sum, so a voucher that balances gives
 * zero regardless of how the two halves are spelled.
 */
export function balanceOf(entries: readonly TallyRawEntry[]): Balance {
  let debits = D(0)
  let credits = D(0)
  let difference = D(0)
  for (const entry of entries) {
    const amount = D(entry.amount)
    difference = difference.plus(amount)
    if (amount.isNegative()) {
      debits = debits.plus(amount.negated())
    } else {
      credits = credits.plus(amount)
    }
  }
  return { debits, credits, difference }
}

function findPartyEntry(
  raw: TallyRawVoucher,
  chart: TallyChart,
  report: Report,
  where: string,
): PartyEntry | null {
  /* `filter` and a count at both steps. "The entry that is the party" is a rule, and
   * `.find` would implement "whichever Tally wrote first" while looking like one. */
  const byChain = raw.entries.filter((entry) => chartRoleOf(chart, entry.ledger)?.kind === 'party')
  const [chained, ...moreChained] = byChain
  if (moreChained.length > 0) {
    report(
      'CONFLICTING_HEADER',
      'error',
      `Voucher ${where} has ${String(byChain.length)} entries on customer or supplier ledgers ` +
        `(${byChain.map((entry) => entry.ledger).join(', ')}), so Coffer cannot tell whose ` +
        'transaction it is. It has not been imported.',
      'partyLedger',
      byChain.map((entry) => entry.ledger).join(', '),
    )
    return null
  }

  if (chained !== undefined) {
    const role = chartRoleOf(chart, chained.ledger)
    if (raw.partyLedger !== null && elementKey(raw.partyLedger) !== elementKey(chained.ledger)) {
      report(
        'CONFLICTING_HEADER',
        'warning',
        `Voucher ${where} names ${JSON.stringify(raw.partyLedger)} as its party, and the entry ` +
          `that sits under a customer or supplier group is ${JSON.stringify(chained.ledger)}. ` +
          'Coffer has gone with the entry, because that is the one that posts.',
        'partyLedger',
        raw.partyLedger,
      )
    }
    return {
      entry: chained,
      name: chained.ledger,
      sourceId: chartLedgerOf(chart, chained.ledger)?.sourceId ?? null,
      side: role !== null && role.kind === 'party' ? role.side : null,
    }
  }

  if (raw.partyLedger === null) {
    report(
      'MISSING_VALUE',
      'error',
      `Voucher ${where} names no party and none of its ledgers is under a customer or supplier ` +
        'group, so Coffer cannot tell whose transaction it is. It has not been imported.',
      'partyLedger',
    )
    return null
  }

  const namedParty = elementKey(raw.partyLedger)
  const named = raw.entries.filter((entry) => elementKey(entry.ledger) === namedParty)
  const [only, ...rest] = named
  if (rest.length > 0) {
    report(
      'CONFLICTING_HEADER',
      'error',
      `Voucher ${where} has ${String(named.length)} entries on ` +
        `${JSON.stringify(raw.partyLedger)}, so Coffer cannot tell which one is the party's ` +
        'side of it. It has not been imported.',
      'partyLedger',
      raw.partyLedger,
    )
    return null
  }
  if (only === undefined) {
    report(
      'MISSING_VALUE',
      'error',
      `Voucher ${where} names ${JSON.stringify(raw.partyLedger)} as its party and has no entry ` +
        'on that ledger, so Coffer cannot tell which of its entries is the party. It has not ' +
        'been imported.',
      'partyLedger',
      raw.partyLedger,
    )
    return null
  }
  return {
    entry: only,
    name: only.ledger,
    sourceId: chartLedgerOf(chart, only.ledger)?.sourceId ?? null,
    side: null,
  }
}

function stageDocument(
  raw: TallyRawVoucher,
  kind: DocumentKind,
  party: PartyEntry,
  chart: TallyChart,
  report: Report,
): TallyStagedVoucher | null {
  if (raw.number === null) {
    report(
      'MISSING_VALUE',
      'error',
      `A ${raw.voucherType} voucher dated ${raw.date} carries no voucher number. A document's ` +
        'number is its identity — it is what the customer quotes and what a re-import matches ' +
        'on — so this one has not been imported.',
      'number',
    )
    return null
  }

  const sign = LINE_SIGN[party.entry.side]
  const lines: StagedDocumentLine[] = []
  for (const entry of raw.entries) {
    if (entry === party.entry) {
      continue
    }
    const role = chartRoleOf(chart, entry.ledger)
    if (role !== null && role.kind === 'account' && role.recomputed) {
      continue
    }
    lines.push({
      lineNumber: lines.length + 1,
      /* The ledger name is the only description a Tally ledger entry carries. It is the
       * one the user will recognise, and it is also what `ledger` holds — so the mapping
       * screen and the line read the same word. */
      description: entry.ledger,
      quantity: toQuantityString(D(1)),
      unitPrice: toMoneyString(D(entry.amount).times(sign)),
      discount: toMoneyString(D(0)),
      ledger: entry.ledger,
      provenance: [{ ...sourceRowOf(raw), line: entry.line }],
    })
  }

  const document: StagedDocument = {
    sourceId: raw.sourceId,
    kind,
    number: raw.number,
    date: raw.date,
    ...(party.sourceId === null ? {} : { partySourceId: party.sourceId }),
    partyName: party.name,
    ...(raw.reference === null ? {} : { partyReference: raw.reference }),
    ...(raw.placeOfSupply === null ? {} : { placeOfSupplyName: raw.placeOfSupply }),
    ...(raw.narration === null ? {} : { narration: raw.narration }),
    statedTotal: toMoneyString(D(party.entry.amount).abs()),
    lines,
    provenance: raw.provenance,
    fingerprint: '',
  }

  return {
    document: { ...document, fingerprint: documentFingerprint(document) },
    receipt: null,
    side: definitionOf(kind).side,
    partyName: party.name,
    partySourceId: party.sourceId,
    stockItems: raw.stockItems,
  }
}

function stageReceipt(
  raw: TallyRawVoucher,
  target: Extract<TallyVoucherTarget, { kind: 'receipt' }>,
  party: PartyEntry,
  options: TallyVoucherOptions,
  report: Report,
  where: string,
): TallyStagedVoucher | null {
  const side = party.side ?? target.defaultSide
  if (party.side === null) {
    report(
      'UNKNOWN_PARTY_ROLE',
      'warning',
      `This export does not say whether ${JSON.stringify(party.name)} is a customer or a ` +
        `supplier, so Coffer has read voucher ${where} as money ${target.direction === 'in' ? 'received from' : 'paid to'} ` +
        `a ${side === 'sales' ? 'customer' : 'supplier'}. If that is the wrong way round this ` +
        'is a refund, and it belongs on the other control account — export the ledger masters ' +
        'as well and import again.',
      'partyLedger',
      party.name,
    )
  }

  const receiptKind = tallyReceiptKind(target.direction, side, options.receiptKinds)
  if (receiptKind.kind !== 'one') {
    report(
      'UNKNOWN_ACCOUNT_TYPE',
      'error',
      `Coffer has ${receiptKind.kind === 'none' ? 'no' : 'more than one'} kind of voucher for ` +
        `money ${target.direction === 'in' ? 'coming in' : 'going out'} on the ` +
        `${side} side, so voucher ${where} has not been imported.`,
      'voucherType',
      raw.voucherType,
    )
    return null
  }

  const money = moneyEntryOf(raw, party, report, where)
  if (money === null) {
    return null
  }

  let number = raw.number
  if (number === null) {
    report(
      'MISSING_VALUE',
      'warning',
      `A ${raw.voucherType} voucher dated ${raw.date} carries no voucher number, so Coffer has ` +
        'used its identifier from the export. Nothing is lost: a voucher number is allotted by ' +
        'whichever program recorded the money, so it is not what a re-import matches on.',
      'number',
    )
    number = raw.sourceId
  }

  const receipt: StagedReceipt = {
    sourceId: raw.sourceId,
    kind: receiptKind.receiptKind,
    number,
    date: raw.date,
    ...(party.sourceId === null ? {} : { partySourceId: party.sourceId }),
    partyName: party.name,
    amount: toMoneyString(D(party.entry.amount).abs()),
    ledger: money.ledger,
    ...(raw.reference === null ? {} : { reference: raw.reference }),
    ...(raw.narration === null ? {} : { narration: raw.narration }),
    allocations: allocationsOf(raw, party, options, report, where),
    provenance: raw.provenance,
    fingerprint: '',
  }

  return {
    document: null,
    receipt: { ...receipt, fingerprint: receiptFingerprint(receipt) },
    side,
    partyName: party.name,
    partySourceId: party.sourceId,
    stockItems: raw.stockItems,
  }
}

/**
 * The one entry the money moved through.
 *
 * A `StagedReceipt` is two-sided by construction: an amount that moved through one account,
 * against one party, settling documents. So a voucher with a THIRD leg — a settlement
 * discount, bank charges, tax withheld at source, all of them ordinary in Indian books — is
 * not a receipt Coffer can hold, and there is no reading of it that is merely approximate:
 *
 *   take the PARTY's figure  and the bank is overstated by the discount, which nobody finds
 *                            until the account is reconciled months later;
 *   take the BANK's figure   and the party is left owing the discount for ever, on an aged
 *                            report that will be sent to them.
 *
 * Both are wrong and both look right. So the voucher is REPORTED, with the extra ledgers
 * and their amounts named, and is not staged — the same choice as an unbalanced voucher and
 * for the same reason. Everything else in the file still imports.
 */
function moneyEntryOf(
  raw: TallyRawVoucher,
  party: PartyEntry,
  report: Report,
  where: string,
): TallyRawEntry | null {
  const others = raw.entries.filter((entry) => entry !== party.entry)
  const [only, ...rest] = others
  if (only !== undefined && rest.length === 0) {
    return only
  }
  report(
    'INVALID_AMOUNT',
    'error',
    `Voucher ${where} moves money between ${JSON.stringify(party.name)} and ` +
      `${String(others.length)} other ${others.length === 1 ? 'ledger' : 'ledgers'}` +
      `${others.length === 0 ? '' : ` (${others.map((entry) => `${entry.ledger} ${entry.amount}`).join(', ')})`}. ` +
      'Coffer records a receipt as money through one account against one party, so this one ' +
      'has not been imported — enter it by hand.',
    'ledger',
  )
  return null
}

function allocationsOf(
  raw: TallyRawVoucher,
  party: PartyEntry,
  options: TallyVoucherOptions,
  report: Report,
  where: string,
): readonly StagedAllocation[] {
  const allocations: StagedAllocation[] = []
  for (const allocation of party.entry.allocations) {
    /* A bill reference with no BILLTYPE is read as settling the bill it names. That is a
     * stated default and not a silent one: it is what a reference on a receipt means in
     * every export that omits the field, and if the document turns out not to be in this
     * import the allocation is reported as unmatched anyway. An UNRECOGNISED type is a
     * different thing and is never folded into the default. */
    if (allocation.billType !== null) {
      const treatment = tallyBillTreatment(allocation.billType, options.billTypes)
      if (treatment.kind !== 'one') {
        report(
          'UNKNOWN_ACCOUNT_TYPE',
          'warning',
          `Voucher ${where} matches ${JSON.stringify(allocation.reference)} as ` +
            `${JSON.stringify(allocation.billType)}, which Coffer does not recognise, so the ` +
            'money has been left on account.',
          'billType',
          allocation.billType,
        )
        continue
      }
      if (treatment.treatment !== 'settles') {
        continue
      }
    }
    allocations.push({
      documentNumber: allocation.reference,
      amount: toMoneyString(D(allocation.amount).abs()),
      provenance: [{ ...sourceRowOf(raw), line: allocation.line }],
    })
  }
  return allocations
}

function whereOf(raw: TallyRawVoucher): string {
  return raw.number ?? `#${String(raw.provenance[0]?.rowNumber ?? 0)}`
}

/** The row a voucher was read from. Every voucher has one; the fallback is unreachable. */
function sourceRowOf(raw: TallyRawVoucher): SourceRow {
  return raw.provenance[0] ?? { file: '', line: 0, rowNumber: 0 }
}

/** The three issue fields that send a user to the voucher in their own file. */
function locate(raw: TallyRawVoucher): { file: string; line: number; rowNumber: number } {
  const row = sourceRowOf(raw)
  return { file: row.file, line: row.line, rowNumber: row.rowNumber }
}
