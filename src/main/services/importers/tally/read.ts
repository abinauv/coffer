/*
 * READING A TALLY XML EXPORT INTO FACTS, WITHOUT DECIDING WHAT ANY OF THEM MEAN.
 *
 * The XML foundation does the reading (`readXmlSubtrees`, one subtree at a time, never the
 * whole file); `elements.ts` says which name is which field; this file turns the elements
 * into small flat records. What a voucher IS — a sales invoice, a receipt, a journal
 * nobody can file — is decided in `vouchers.ts`, afterwards, and there is a reason the two
 * are separate.
 *
 * ---------------------------------------------------------------------------
 * 1. A REAL EXPORT INTRODUCES A LEDGER AFTER THE VOUCHER THAT USES IT.
 *
 * Tally writes its messages in whatever order the request produced. Masters and vouchers
 * come in one stream, a company exported by date range starts with vouchers, and a
 * two-file export (`Masters.xml`, `Vouchers.xml`) is routinely handed over the other way
 * round. So NOTHING here may resolve a ledger while it walks: the parent chain that says
 * whether `Bharat Metals` is a customer is not complete until the last file has been read.
 *
 * The naive fix is two passes over the text, and it is wrong for the reason the whole XML
 * module exists: the second pass would re-read a hundred megabytes. So the walk happens
 * ONCE and produces `TallyRawVoucher` — a flat record of strings and decimals, with the
 * XML dropped — and the classification runs over those afterwards, against a master tree
 * that is by then complete. The memory held is the staged output, which the caller was
 * always going to hold, and never the tree.
 *
 * ---------------------------------------------------------------------------
 * 2. A CANCELLED VOUCHER IS NOT A VOUCHER.
 *
 * Tally keeps cancelled vouchers in the file with `ISCANCELLED=Yes` and keeps their
 * numbers, so the numbering has no gap. They post nothing. An importer that reads them
 * imports invoices that were deliberately voided, against parties who never received them,
 * and the totals it produces are wrong in a way that reconciles against the file it came
 * from. The same for `ISOPTIONAL`, which is Tally's "show me what this would do" voucher
 * and posts nothing either. Both are skipped and both are REPORTED, because a user
 * comparing counts needs to know why nineteen vouchers became seventeen.
 *
 * ---------------------------------------------------------------------------
 * 3. AN ENTRY THAT CANNOT BE READ TAKES ITS WHOLE VOUCHER WITH IT.
 *
 * Everywhere else in these importers a row that fails is dropped and the file goes on. A
 * LEDGER ENTRY is the exception, and the reason is arithmetic: the entries of a voucher
 * are the two halves of one balanced statement, so dropping one and keeping the rest does
 * not lose an entry — it produces a voucher that no longer balances, out of a file where
 * it did. That failure is silent at every level above this one. So an unreadable amount,
 * a missing ledger name or an ambiguous entry container refuses the VOUCHER, once, with
 * the voucher's number in the message.
 */

import { D, type DecimalString } from '@main/domain/money'

import { readXmlSubtrees, type XmlElement, type XmlIssue, type XmlParseOptions } from '../xml'
import type { BatchIssue, ImportedFile, Provenance, SourceRow } from '../model'
import {
  elementKey,
  elementNamesIn,
  tallyChildren,
  tallyElementSpec,
  tallyValue,
  unclaimedChildren,
  type TallyElementName,
  type TallyElementSpec,
} from './elements'
import {
  parseTallyAmount,
  parseTallyCount,
  parseTallyDate,
  parseTallyDays,
  parseTallyFlag,
  tallyEntrySide,
  type TallyEntrySide,
} from './values'

import type { DateString } from '@shared/scalars'

/**
 * One file of an export.
 *
 * A LIST of files, not one, because a Tally export routinely is two: `Masters.xml` and
 * `Vouchers.xml`, produced by two separate menu items and handed over in whichever order
 * they were made. Reading them as one stream is what makes the order between them
 * irrelevant — see decision 1 in the header.
 *
 * `text` is the file's contents. Nothing in this module opens a file, the same rule the
 * CSV and XML foundations keep, so the decision about which paths may be read stays with
 * the caller where it can be enforced once.
 */
export interface TallyFile {
  readonly name: string
  readonly text: string
}

/** One bill reference on a ledger entry, as the file states it. */
export interface TallyRawAllocation {
  readonly reference: string
  /** Signed, exactly as written. The sign is Tally's and is not touched here. */
  readonly amount: DecimalString
  /** `BILLTYPE` as written, or null. What it MEANS is `classify.ts`'s answer. */
  readonly billType: string | null
  readonly line: number
}

/** One ledger entry of one voucher, read but not interpreted. */
export interface TallyRawEntry {
  /** The ledger name exactly as the file wrote it. Never resolved here. */
  readonly ledger: string
  /** Signed, exactly as the file states it. Negative is a debit — see `values.ts`. */
  readonly amount: DecimalString
  readonly side: TallyEntrySide
  /** What `ISDEEMEDPOSITIVE` said, or null. */
  readonly statedPositive: boolean | null
  /** True when the flag named the other side from the sign. The sign still won. */
  readonly contradicts: boolean
  readonly allocations: readonly TallyRawAllocation[]
  readonly line: number
}

/** One voucher, read but not classified. */
export interface TallyRawVoucher {
  readonly sourceId: string
  /** As written. `Sales`, `Cash Sales`, anything the company invented. */
  readonly voucherType: string
  /** Tally leaves this blank on plenty of payments. Null is a real answer. */
  readonly number: string | null
  readonly date: DateString
  readonly partyLedger: string | null
  readonly narration: string | null
  readonly reference: string | null
  readonly placeOfSupply: string | null
  readonly entries: readonly TallyRawEntry[]
  /** Stock item names the voucher mentions. See the header of `vouchers.ts` for why only
   * the names. */
  readonly stockItems: readonly string[]
  readonly provenance: Provenance
}

/** One ledger master, read but not classified. */
export interface TallyRawLedger {
  readonly sourceId: string
  readonly name: string
  readonly parent: string
  readonly openingBalance: DecimalString | null
  readonly registrationNumber: string | null
  readonly email: string | null
  readonly jurisdictionName: string | null
  readonly countryName: string | null
  readonly paymentTermsDays: number | null
  readonly provenance: Provenance
}

/** One stock item master. */
export interface TallyRawStockItem {
  readonly sourceId: string
  readonly name: string
  readonly parent: string | null
  readonly unitLabel: string | null
  readonly description: string | null
  readonly supplyType: string | null
  readonly provenance: Provenance
}

/** One unit of measure master. */
export interface TallyRawUnit {
  readonly name: string
  readonly decimalPlaces: number | null
  readonly provenance: Provenance
}

/** Everything the walk produced, in file order. */
export interface TallyReading {
  readonly files: readonly ImportedFile[]
  readonly issues: readonly BatchIssue[]
  readonly vouchers: readonly TallyRawVoucher[]
  readonly ledgers: readonly TallyRawLedger[]
  /** Group name key -> its parent's name as written. The tree `classify.ts` walks. */
  readonly groupParents: ReadonlyMap<string, string>
  /** Group names as written, first-encounter order, so a message can quote the file. */
  readonly groups: readonly { readonly name: string; readonly parent: string }[]
  readonly stockItems: readonly TallyRawStockItem[]
  readonly units: readonly TallyRawUnit[]
}

export interface TallyReadOptions {
  readonly elements?: Readonly<Record<TallyElementName, TallyElementSpec>>
  readonly xml?: XmlParseOptions
}

/**
 * Walk every file and collect what is in it.
 *
 * @throws XmlError for a file that is not well-formed XML, for a `<!DOCTYPE`, or for one
 *   of the reader's caps. A malformed XML document has no rows to salvage — `xml/errors.ts`
 *   argues that at length — so it is a refusal and not an issue.
 */
export function readTallyFiles(
  files: readonly TallyFile[],
  options: TallyReadOptions = {},
): TallyReading {
  const table = options.elements
  const collector = new IssueCollector()
  const readFiles: ImportedFile[] = []
  const vouchers: TallyRawVoucher[] = []
  const ledgers: TallyRawLedger[] = []
  const groups: { name: string; parent: string }[] = []
  const groupParents = new Map<string, string>()
  const stockItems: TallyRawStockItem[] = []
  const units: TallyRawUnit[] = []

  const wanted = subtreeNames(table)

  for (const file of files) {
    const names = new Set<string>()
    let read = 0
    let staged = 0

    const onIssue = (issue: XmlIssue): void => {
      collector.push(liftXmlIssue(file.name, issue))
    }

    for (const subtree of readXmlSubtrees(
      file.text,
      (context) => wanted.has(elementKey(context.name)),
      { ...(options.xml ?? {}), onIssue },
    )) {
      for (const ancestor of subtree.path) {
        names.add(ancestor)
      }
      elementNamesIn(subtree.element, names)
      read += 1

      const row: SourceRow = {
        file: file.name,
        line: subtree.element.line,
        rowNumber: subtree.ordinal,
      }
      const context: ReadContext = { table, collector, row, produced: false }

      const kind = wanted.get(elementKey(subtree.element.name))
      if (kind === 'message') {
        readMessage(subtree.element, wanted, context, {
          vouchers,
          ledgers,
          groups,
          groupParents,
          stockItems,
          units,
        })
      } else if (kind !== undefined) {
        readEntity(kind, subtree.element, context, {
          vouchers,
          ledgers,
          groups,
          groupParents,
          stockItems,
          units,
        })
      }
      if (context.produced) {
        staged += 1
      }
    }

    readFiles.push({
      name: file.name,
      entity: 'tally-xml',
      /* Every element name the file used, in the order they were first seen. The XML
       * analogue of the Zoho reader's `headings`, and it is here for the same reason: a
       * field this importer looked for under the wrong name is diagnosed by reading this
       * list, without anybody re-opening the export. */
      headings: [...names],
      rowsRead: read,
      rowsStaged: staged,
      /* Tally writes YYYYMMDD, which is not one of the CSV module's `DateFormat`s and does
       * not need to be surveyed: there is no second reading of eight digits. Null says
       * "no format was chosen", which is exactly true. */
      dateFormat: null,
    })
  }

  collector.flushUnclaimed()

  return {
    files: readFiles,
    issues: collector.issues,
    vouchers,
    ledgers,
    groupParents,
    groups,
    stockItems,
    units,
  }
}

/**
 * Attach a file name to an issue the XML reader produced.
 *
 * BOTH XML ISSUE CODES BECOME `UNMAPPED_COLUMN`, AND THAT IS A BORROWED CODE. `XmlIssue`
 * has its own closed union (`ENCODING_UNVERIFIED`, `REPLACEMENT_CHARACTER`) which
 * `BatchIssueCode` does not contain, and widening `BatchIssueCode` is a change to
 * `model.ts`, which this batch does not own. `xml/errors.ts` predicts the same collision
 * and names the fix: a shared `importers/issues.ts` both readers contribute codes to. Until
 * then the code is the closest the frozen union has — an observation about the file that
 * no field claims — and `field` carries which observation it actually is, so a reader is
 * never left guessing.
 */
export function liftXmlIssue(file: string, issue: XmlIssue): BatchIssue {
  return {
    code: 'UNMAPPED_COLUMN',
    severity: issue.severity,
    message: issue.message,
    file,
    field: issue.code === 'ENCODING_UNVERIFIED' ? 'encoding' : 'text',
    ...(issue.line === undefined ? {} : { line: issue.line }),
    ...(issue.value === undefined ? {} : { value: issue.value }),
  }
}

// ---- Internals ------------------------------------------------------------

/** The five things a message carries, plus the message itself, keyed for matching. */
type SubtreeKind = 'message' | 'voucher' | 'ledger' | 'group' | 'stockItem' | 'unit'

const SUBTREE_KINDS: readonly SubtreeKind[] = [
  'message',
  'voucher',
  'ledger',
  'group',
  'stockItem',
  'unit',
]

/**
 * Element key -> what it is.
 *
 * Built from the table so a caller's correction to `TALLY_ELEMENTS.voucher` changes what
 * the walk matches as well as what it reads. A second hard-coded list here would agree
 * with the table by inspection and stop agreeing the first time somebody corrected one.
 */
function subtreeNames(
  table: Readonly<Record<TallyElementName, TallyElementSpec>> | undefined,
): ReadonlyMap<string, SubtreeKind> {
  const names = new Map<string, SubtreeKind>()
  for (const kind of SUBTREE_KINDS) {
    for (const candidate of tallyElementSpec(kind, table).elements) {
      names.set(elementKey(candidate), kind)
    }
  }
  return names
}

interface Sink {
  readonly vouchers: TallyRawVoucher[]
  readonly ledgers: TallyRawLedger[]
  readonly groups: { name: string; parent: string }[]
  readonly groupParents: Map<string, string>
  readonly stockItems: TallyRawStockItem[]
  readonly units: TallyRawUnit[]
}

interface ReadContext {
  readonly table: Readonly<Record<TallyElementName, TallyElementSpec>> | undefined
  readonly collector: IssueCollector
  readonly row: SourceRow
  produced: boolean
}

function readMessage(
  message: XmlElement,
  wanted: ReadonlyMap<string, SubtreeKind>,
  context: ReadContext,
  sink: Sink,
): void {
  for (const child of message.children) {
    if (child.kind !== 'element') {
      continue
    }
    const kind = wanted.get(elementKey(child.name))
    if (kind === undefined || kind === 'message') {
      /* A message holding another message is not a shape any export produces, and
       * treating it as one would recurse on the caller's data. Reported as unclaimed,
       * like anything else nobody asked for. */
      context.collector.unclaimed('a TALLYMESSAGE', child.name, child.line, context.row.file)
      continue
    }
    readEntity(kind, child, context, sink)
  }
}

function readEntity(
  kind: SubtreeKind,
  element: XmlElement,
  context: ReadContext,
  sink: Sink,
): void {
  switch (kind) {
    case 'voucher': {
      const voucher = readVoucher(element, context)
      if (voucher !== null) {
        sink.vouchers.push(voucher)
        context.produced = true
      }
      return
    }
    case 'ledger': {
      const ledger = readLedger(element, context)
      if (ledger !== null) {
        sink.ledgers.push(ledger)
        context.produced = true
      }
      return
    }
    case 'group': {
      const group = readGroup(element, context)
      if (group !== null) {
        sink.groups.push(group)
        /* First spelling wins the tree and a second is reported: two groups of one name
         * with different parents would make the chain walk answer differently depending on
         * which one a map happened to hold. */
        const key = elementKey(group.name)
        if (sink.groupParents.has(key)) {
          context.collector.push({
            code: 'DUPLICATE_SOURCE_ID',
            severity: 'error',
            message:
              `This export has two groups called ${JSON.stringify(group.name)}. Coffer cannot ` +
              'tell which one a ledger under that name belongs to, so it has kept the first.',
            file: context.row.file,
            line: element.line,
            rowNumber: context.row.rowNumber,
            value: group.name,
          })
        } else {
          sink.groupParents.set(key, group.parent)
        }
        context.produced = true
      }
      return
    }
    case 'stockItem': {
      const item = readStockItem(element, context)
      if (item !== null) {
        sink.stockItems.push(item)
        context.produced = true
      }
      return
    }
    case 'unit': {
      const unit = readUnit(element, context)
      if (unit !== null) {
        sink.units.push(unit)
        context.produced = true
      }
      return
    }
    case 'message':
      /* Reached only when a message is the direct subject of `readEntity`, which
       * `readMessage` refuses above. Nothing to read. */
      return
  }
}

/** Fields a voucher claims. Anything else among its children is reported. */
const VOUCHER_FIELDS: readonly TallyElementName[] = [
  'voucherType',
  'voucherNumber',
  'voucherDate',
  'partyLedger',
  'narration',
  'reference',
  'placeOfSupply',
  'isCancelled',
  'isOptional',
  'sourceId',
  'ledgerEntries',
  'inventoryEntries',
]

const ENTRY_FIELDS: readonly TallyElementName[] = [
  'ledgerName',
  'amount',
  'isDeemedPositive',
  'billAllocations',
]

const LEDGER_FIELDS: readonly TallyElementName[] = [
  'masterName',
  'parent',
  'openingBalance',
  'registrationNumber',
  'email',
  'jurisdictionName',
  'countryName',
  'creditPeriod',
  'sourceId',
]

const STOCK_ITEM_FIELDS: readonly TallyElementName[] = [
  'masterName',
  'parent',
  'baseUnit',
  'description',
  'supplyType',
  'sourceId',
]

const UNIT_FIELDS: readonly TallyElementName[] = ['masterName', 'decimalPlaces', 'sourceId']

function readVoucher(voucher: XmlElement, context: ReadContext): TallyRawVoucher | null {
  const reader = new FieldReader(voucher, context, 'a voucher')
  reader.reportUnclaimed(VOUCHER_FIELDS)

  const voucherType = reader.text('voucherType') ?? ''
  const number = reader.text('voucherNumber')
  const where = number ?? `#${String(context.row.rowNumber)}`

  for (const flag of ['isCancelled', 'isOptional'] as const) {
    const stated = reader.text(flag)
    if (stated === null) {
      continue
    }
    const parsed = parseTallyFlag(stated)
    if (!parsed.ok) {
      context.collector.push(
        reader.issue(
          'MISSING_VALUE',
          'warning',
          `Voucher ${where} says ${flag === 'isCancelled' ? 'ISCANCELLED' : 'ISOPTIONAL'} ` +
            `${parsed.message}, so Coffer has read it as an ordinary voucher.`,
          flag,
          stated,
        ),
      )
      continue
    }
    if (parsed.value) {
      context.collector.push(
        reader.issue(
          'MISSING_VALUE',
          'warning',
          `Voucher ${where} is marked ${flag === 'isCancelled' ? 'cancelled' : 'optional'} in ` +
            'Tally and posts nothing there, so it has not been imported.',
          flag,
          voucherType,
        ),
      )
      return null
    }
  }

  const statedDate = reader.text('voucherDate')
  if (statedDate === null) {
    context.collector.push(
      reader.issue(
        'MISSING_VALUE',
        'error',
        `Voucher ${where} carries no date, so there is no period to enter it in.`,
        'date',
      ),
    )
    return null
  }
  const date = parseTallyDate(statedDate)
  if (!date.ok) {
    context.collector.push(
      reader.issue(
        'INVALID_DATE',
        'error',
        `The date on voucher ${where} ${date.message}.`,
        'date',
        statedDate,
      ),
    )
    return null
  }

  const found = tallyChildren(voucher, 'ledgerEntries', context.table)
  if (found.kind === 'ambiguous') {
    context.collector.push(
      reader.issue(
        'AMBIGUOUS_COLUMN',
        'error',
        `Voucher ${where} carries its ledger entries under ${found.found.join(' and ')}, which ` +
          'are two names for one list. Coffer will not add them together and will not guess ' +
          'which to read, so this voucher has not been imported.',
        'ledgerEntries',
        found.found.join(', '),
      ),
    )
    return null
  }
  if (found.kind === 'none') {
    context.collector.push(
      reader.issue(
        'MISSING_VALUE',
        'error',
        `Voucher ${where} has no ledger entries, so there is nothing in it to post.`,
        'ledgerEntries',
      ),
    )
    return null
  }

  const entries: TallyRawEntry[] = []
  for (const child of found.children) {
    const entry = readEntry(child, context, where)
    if (entry === null) {
      return null
    }
    entries.push(entry)
  }

  return {
    sourceId: reader.text('sourceId') ?? `voucher:${voucherType}:${where}`,
    voucherType,
    number,
    date: date.value,
    partyLedger: reader.text('partyLedger'),
    narration: reader.text('narration'),
    reference: reader.text('reference'),
    placeOfSupply: reader.text('placeOfSupply'),
    entries,
    stockItems: readStockItemNames(voucher, context),
    provenance: [context.row],
  }
}

function readEntry(entry: XmlElement, context: ReadContext, where: string): TallyRawEntry | null {
  const reader = new FieldReader(entry, context, 'a ledger entry')
  reader.reportUnclaimed(ENTRY_FIELDS)

  const ledger = reader.text('ledgerName')
  if (ledger === null) {
    context.collector.push(
      reader.issue(
        'MISSING_VALUE',
        'error',
        `An entry on voucher ${where} names no ledger. Dropping one entry would leave the ` +
          'voucher unbalanced, so the whole voucher has been left out.',
        'ledgerName',
      ),
    )
    return null
  }

  const stated = reader.text('amount')
  if (stated === null) {
    context.collector.push(
      reader.issue(
        'MISSING_VALUE',
        'error',
        `The entry for ${JSON.stringify(ledger)} on voucher ${where} carries no amount, so the ` +
          'whole voucher has been left out.',
        'amount',
      ),
    )
    return null
  }
  const amount = parseTallyAmount(stated)
  if (!amount.ok) {
    context.collector.push(
      reader.issue(
        'INVALID_AMOUNT',
        'error',
        `The amount on ${JSON.stringify(ledger)} in voucher ${where} ${amount.message}, so the ` +
          'whole voucher has been left out.',
        'amount',
        stated,
      ),
    )
    return null
  }

  let statedPositive: boolean | null = null
  const flag = reader.text('isDeemedPositive')
  if (flag !== null) {
    const parsed = parseTallyFlag(flag)
    if (parsed.ok) {
      statedPositive = parsed.value
    } else {
      context.collector.push(
        reader.issue(
          'MISSING_VALUE',
          'warning',
          `ISDEEMEDPOSITIVE on ${JSON.stringify(ledger)} in voucher ${where} ${parsed.message}, ` +
            'so Coffer has read the side off the amount alone.',
          'isDeemedPositive',
          flag,
        ),
      )
    }
  }

  const reading = tallyEntrySide(D(amount.value), statedPositive)
  if (reading.contradicts) {
    context.collector.push(
      reader.issue(
        'CONFLICTING_HEADER',
        'warning',
        `On voucher ${where}, ${JSON.stringify(ledger)} is written as ${amount.value}, which is ` +
          `a ${reading.side}, and ISDEEMEDPOSITIVE says it is a ` +
          `${statedPositive === true ? 'debit' : 'credit'}. Coffer has gone with the amount, ` +
          'because the amount is what gets posted.',
        'isDeemedPositive',
        amount.value,
      ),
    )
  }

  return {
    ledger,
    amount: amount.value,
    side: reading.side,
    statedPositive,
    contradicts: reading.contradicts,
    allocations: readAllocations(entry, context, where, ledger),
    line: entry.line,
  }
}

function readAllocations(
  entry: XmlElement,
  context: ReadContext,
  where: string,
  ledger: string,
): readonly TallyRawAllocation[] {
  const found = tallyChildren(entry, 'billAllocations', context.table)
  if (found.kind === 'none') {
    return []
  }
  if (found.kind === 'ambiguous') {
    context.collector.push({
      code: 'AMBIGUOUS_COLUMN',
      severity: 'warning',
      message:
        `The bill references on ${JSON.stringify(ledger)} in voucher ${where} are written under ` +
        `${found.found.join(' and ')}, which are two names for one list. Coffer has matched ` +
        'nothing against a document; the money is on account until you match it by hand.',
      file: context.row.file,
      line: entry.line,
      rowNumber: context.row.rowNumber,
      field: 'billAllocations',
    })
    return []
  }

  const allocations: TallyRawAllocation[] = []
  for (const child of found.children) {
    const reader = new FieldReader(child, context, 'a bill reference')
    const reference = reader.text('billReference')
    const stated = reader.text('amount')
    if (reference === null || stated === null) {
      context.collector.push(
        reader.issue(
          'MISSING_VALUE',
          'warning',
          `A bill reference on ${JSON.stringify(ledger)} in voucher ${where} has no ` +
            `${reference === null ? 'name' : 'amount'}, so nothing has been matched against a ` +
            'document for it.',
          'billAllocations',
        ),
      )
      continue
    }
    const amount = parseTallyAmount(stated)
    if (!amount.ok) {
      context.collector.push(
        reader.issue(
          'INVALID_AMOUNT',
          'warning',
          `The amount on bill reference ${JSON.stringify(reference)} in voucher ${where} ` +
            `${amount.message}, so nothing has been matched against it.`,
          'billAllocations',
          stated,
        ),
      )
      continue
    }
    allocations.push({
      reference,
      amount: amount.value,
      billType: reader.text('billType'),
      line: child.line,
    })
  }
  return allocations
}

function readStockItemNames(voucher: XmlElement, context: ReadContext): readonly string[] {
  const found = tallyChildren(voucher, 'inventoryEntries', context.table)
  if (found.kind !== 'one') {
    return []
  }
  const names: string[] = []
  for (const child of found.children) {
    const reader = new FieldReader(child, context, 'an inventory entry')
    const name = reader.text('stockItemName')
    if (name !== null && !names.includes(name)) {
      names.push(name)
    }
  }
  return names
}

function readLedger(ledger: XmlElement, context: ReadContext): TallyRawLedger | null {
  const reader = new FieldReader(ledger, context, 'a ledger')
  reader.reportUnclaimed(LEDGER_FIELDS)

  const name = reader.text('masterName')
  if (name === null) {
    context.collector.push(
      reader.issue('MISSING_VALUE', 'error', 'A ledger in this export has no name.', 'name'),
    )
    return null
  }

  let openingBalance: DecimalString | null = null
  const stated = reader.text('openingBalance')
  if (stated !== null) {
    const amount = parseTallyAmount(stated)
    if (amount.ok) {
      openingBalance = amount.value
    } else {
      context.collector.push(
        reader.issue(
          'INVALID_AMOUNT',
          'error',
          `The opening balance on ${JSON.stringify(name)} ${amount.message}, so it has not been ` +
            'brought in. Enter it by hand before you rely on this account.',
          'openingBalance',
          stated,
        ),
      )
    }
  }

  let paymentTermsDays: number | null = null
  const period = reader.text('creditPeriod')
  if (period !== null) {
    const days = parseTallyDays(period)
    if (days.ok) {
      paymentTermsDays = days.value
    } else {
      context.collector.push(
        reader.issue(
          'INVALID_NUMBER',
          'warning',
          `The credit period on ${JSON.stringify(name)} ${days.message}, so Coffer has left this ` +
            'party with no payment terms.',
          'creditPeriod',
          period,
        ),
      )
    }
  }

  return {
    sourceId: reader.text('sourceId') ?? `ledger:${elementKey(name)}`,
    name,
    parent: reader.text('parent') ?? '',
    openingBalance,
    registrationNumber: reader.text('registrationNumber'),
    email: reader.text('email'),
    jurisdictionName: reader.text('jurisdictionName'),
    countryName: reader.text('countryName'),
    paymentTermsDays,
    provenance: [context.row],
  }
}

function readGroup(
  group: XmlElement,
  context: ReadContext,
): { name: string; parent: string } | null {
  const reader = new FieldReader(group, context, 'a group')
  reader.reportUnclaimed(['masterName', 'parent', 'sourceId'])

  const name = reader.text('masterName')
  if (name === null) {
    context.collector.push(
      reader.issue('MISSING_VALUE', 'error', 'A group in this export has no name.', 'name'),
    )
    return null
  }
  return { name, parent: reader.text('parent') ?? '' }
}

function readStockItem(item: XmlElement, context: ReadContext): TallyRawStockItem | null {
  const reader = new FieldReader(item, context, 'a stock item')
  reader.reportUnclaimed(STOCK_ITEM_FIELDS)

  const name = reader.text('masterName')
  if (name === null) {
    context.collector.push(
      reader.issue('MISSING_VALUE', 'error', 'A stock item in this export has no name.', 'name'),
    )
    return null
  }
  return {
    sourceId: reader.text('sourceId') ?? `item:${elementKey(name)}`,
    name,
    parent: reader.text('parent'),
    unitLabel: reader.text('baseUnit'),
    description: reader.text('description'),
    supplyType: reader.text('supplyType'),
    provenance: [context.row],
  }
}

function readUnit(unit: XmlElement, context: ReadContext): TallyRawUnit | null {
  const reader = new FieldReader(unit, context, 'a unit')
  reader.reportUnclaimed(UNIT_FIELDS)

  const name = reader.text('masterName')
  if (name === null) {
    context.collector.push(
      reader.issue('MISSING_VALUE', 'error', 'A unit in this export has no name.', 'name'),
    )
    return null
  }

  let decimalPlaces: number | null = null
  const stated = reader.text('decimalPlaces')
  if (stated !== null) {
    const places = parseTallyCount(stated)
    if (places.ok) {
      decimalPlaces = places.value
    } else {
      context.collector.push(
        reader.issue(
          'INVALID_NUMBER',
          'warning',
          `The decimal places on unit ${JSON.stringify(name)} ${places.message}, so Coffer will ` +
            'ask you how precise this unit is.',
          'decimalPlaces',
          stated,
        ),
      )
    }
  }

  return { name, decimalPlaces, provenance: [context.row] }
}

/**
 * Reading fields off one element, with every ambiguity reported once.
 *
 * A class rather than a function because the same three things — the table, the collector
 * and the source row — go into every read, and threading them through forty call sites is
 * where a `file` gets left off an issue and a message stops saying which file it is about.
 */
class FieldReader {
  constructor(
    private readonly element: XmlElement,
    private readonly context: ReadContext,
    private readonly what: string,
  ) {}

  /** The one value for a field, or null when the file gave none or gave two that differ. */
  text(name: TallyElementName): string | null {
    const read = tallyValue(this.element, name, this.context.table)
    if (read.kind === 'one') {
      return read.value
    }
    if (read.kind === 'ambiguous') {
      this.context.collector.push(
        this.issue(
          'AMBIGUOUS_COLUMN',
          'warning',
          `${this.what[0]?.toUpperCase() ?? ''}${this.what.slice(1)} in this export writes ` +
            `${read.found.map((one) => `${one.from}=${JSON.stringify(one.value)}`).join(' and ')}, ` +
            'which are two names for one thing and do not agree. Coffer has read neither.',
          name,
          read.found.map((one) => one.value).join(' | '),
        ),
      )
    }
    return null
  }

  /** Every direct child no field claims, gathered for one report per name at the end. */
  reportUnclaimed(claimed: readonly TallyElementName[]): void {
    for (const unclaimed of unclaimedChildren(this.element, claimed, this.context.table)) {
      this.context.collector.unclaimed(
        this.what,
        unclaimed.name,
        unclaimed.line,
        this.context.row.file,
        unclaimed.count,
      )
    }
  }

  issue(
    code: BatchIssue['code'],
    severity: BatchIssue['severity'],
    message: string,
    field: string,
    value?: string,
  ): BatchIssue {
    return {
      code,
      severity,
      message,
      file: this.context.row.file,
      line: this.element.line,
      rowNumber: this.context.row.rowNumber,
      field,
      ...(value === undefined ? {} : { value }),
    }
  }
}

/**
 * The issue list, plus the one thing that has to be aggregated rather than listed.
 *
 * An unclaimed element is reported ONCE PER NAME PER CONTEXT with a count. A real export
 * repeats `LANGUAGENAME.LIST` on every one of forty thousand ledgers, and forty thousand
 * copies of one sentence is a report nobody reads and therefore a report that hides the
 * three issues that mattered.
 */
class IssueCollector {
  readonly issues: BatchIssue[] = []
  private readonly unclaimedNames = new Map<
    string,
    { what: string; name: string; line: number; file: string; count: number }
  >()

  push(issue: BatchIssue): void {
    this.issues.push(issue)
  }

  unclaimed(what: string, name: string, line: number, file: string, count = 1): void {
    const key = `${what} ${file} ${elementKey(name)}`
    const already = this.unclaimedNames.get(key)
    if (already === undefined) {
      this.unclaimedNames.set(key, { what, name, line, file, count })
    } else {
      already.count += count
    }
  }

  flushUnclaimed(): void {
    for (const found of this.unclaimedNames.values()) {
      this.issues.push({
        code: 'UNMAPPED_COLUMN',
        severity: 'warning',
        message:
          `<${found.name}> appears ${String(found.count)} ${found.count === 1 ? 'time' : 'times'} ` +
          `inside ${found.what} in this export and Coffer does not read it. If it holds ` +
          'something you need, tell Coffer which field it is.',
        file: found.file,
        line: found.line,
        heading: found.name,
      })
    }
  }
}
