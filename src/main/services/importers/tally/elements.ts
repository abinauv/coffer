/*
 * WHERE TALLY'S ELEMENTS ARE, DECLARED AS DATA.
 *
 * ---------------------------------------------------------------------------
 * READ THIS FIRST: EVERY NAME BELOW IS A BEST-EFFORT DEFAULT, NOT A SCHEMA.
 *
 * There is no published schema for a Tally XML export and the batch that wrote this had
 * NO SAMPLE EXPORT and no access to Tally. What the file actually contains varies by
 * release, by which report was exported, by whether the company has inventory or GST
 * switched on, and by whether the export came from `Export Masters`, from a `Collection`
 * request or from a third-party connector. Three specific ways it varies, each of which
 * this file is built to survive:
 *
 *   TWO SPELLINGS OF ONE THING.  `ALLLEDGERENTRIES.LIST` and `LEDGERENTRIES.LIST` are the
 *                                same list. `PARTYLEDGERNAME` and `PARTYNAME` are the same
 *                                field. Neither pair is a version marker you can key off:
 *                                both spellings are alive.
 *   CASE AND SPACING.            Tally itself writes `<AMOUNT>`; a file that has been
 *                                through a connector, a report template or somebody's
 *                                script arrives as `<Amount>`. XML IS CASE-SENSITIVE, so a
 *                                literal comparison silently matches nothing and the field
 *                                reads as absent. Matching goes through `elementKey`, which
 *                                folds case and spacing exactly as a CSV heading is folded.
 *   THE SAME FACT TWICE.         A voucher states its type as the `VCHTYPE` ATTRIBUTE and
 *                                again as the `VOUCHERTYPENAME` child element, usually
 *                                identically. So attributes and child elements are read as
 *                                candidates for one field and AGREEMENT is the test, not
 *                                position.
 *
 * So this file is written to be WRONG SAFELY, and the four mechanisms are the same ones
 * `zoho/columns.ts` uses against the same problem in a different format:
 *
 *   - Every field lists SEVERAL candidate names, matched through `elementKey`.
 *   - Every field is OVERRIDABLE by the caller (`TallyElementOverrides`), so a user or a
 *     later batch corrects a name without a code change.
 *   - Two candidates that BOTH carry a value, and disagree, resolve to NOTHING and are
 *     reported as ambiguous — never to whichever is listed first (CONVENTIONS §9). Two
 *     candidates that agree are one value, which is what makes `VCHTYPE` plus
 *     `VOUCHERTYPENAME` the ordinary case rather than a conflict.
 *   - An element the reader met and no field claims is REPORTED, and every distinct
 *     element name in the file is recorded on `ImportedFile.headings`. Those two together
 *     are how a wrong guess in this file is diagnosed from the batch alone, without
 *     anybody re-opening a hundred-megabyte export.
 *
 * ---------------------------------------------------------------------------
 * WHITESPACE IS DECIDED PER FIELD, WHICH IS THE ONLY PLACE IT CAN BE DECIDED.
 *
 * `xml/parse.ts` trims nothing, on purpose and at length: the parser cannot tell an
 * exporter's indentation from a run of spaces somebody typed. Tally pads its exports
 * heavily, so almost every field wants `collapseXmlSpace` — and `narration` must not have
 * it, because a narration is prose and the line breaks in it are the user's. That is what
 * `space` is: `'collapse'` for an identifier, `'keep'` for prose.
 *
 * ---------------------------------------------------------------------------
 * DIRECT CHILDREN ONLY, AND WHAT THAT COSTS
 *
 * A field is looked for among an element's OWN attributes and its DIRECT child elements,
 * never among its descendants. A descendant search would make `AMOUNT` on a voucher find
 * the amount of its first ledger entry, and `NAME` on a ledger find a name inside
 * `LANGUAGENAME.LIST` — both plausible, both silently wrong.
 *
 * The cost is stated rather than hidden: a cheque number lives in
 * `BANKALLOCATIONS.LIST/INSTRUMENTNUMBER` and an address in `ADDRESS.LIST/ADDRESS`, and
 * neither is read here. Nesting is walked explicitly where it is the shape of the data —
 * a voucher's ledger entries, and a ledger entry's bill allocations — by asking for the
 * container and then reading fields off each child.
 */

import {
  childElements,
  collapseXmlSpace,
  isXmlWhitespaceOnly,
  textOf,
  type XmlElement,
} from '../xml'
import { normaliseHeading } from '../csv'
import { ImportError } from '../model'

/**
 * The key two element or attribute names are the same under.
 *
 * `normaliseHeading` — NFC, invisibles removed, whitespace collapsed, LOWER CASE — so a
 * name is matched exactly the way a CSV heading is, and the two readers cannot drift apart
 * on what "the same name" means.
 *
 * FOLDING CASE IS THE WHOLE POINT AND IT IS NOT COSMETIC. XML is case-sensitive, Tally
 * writes its own tags in upper case, and files that have been through a connector or a
 * template arrive mixed. A literal comparison against `AMOUNT` reads `<Amount>` as ABSENT
 * — not as an error, as absent — so the voucher imports with no amount on one entry and
 * fails to balance for a reason that points nowhere near the real cause.
 *
 * NOT folded: a trailing `.LIST`. `ALLLEDGERENTRIES.LIST` is a container and
 * `ALLLEDGERENTRIES` would be a different element; folding the suffix away would let a
 * field match its own container.
 */
export function elementKey(name: string): string {
  return normaliseHeading(name)
}

/** Every name this importer looks for, as a closed union. An override names one of these. */
export type TallyElementName =
  /* The envelope. Matched at any depth — see the note on `TALLY_ELEMENTS.message`. */
  | 'message'
  /* The five things a message carries. */
  | 'voucher'
  | 'ledger'
  | 'group'
  | 'stockItem'
  | 'unit'
  /* Voucher fields. */
  | 'voucherType'
  | 'voucherNumber'
  | 'voucherDate'
  | 'partyLedger'
  | 'narration'
  | 'reference'
  | 'placeOfSupply'
  | 'isCancelled'
  | 'isOptional'
  | 'sourceId'
  /* Repeated groups inside a voucher, and inside a ledger entry. */
  | 'ledgerEntries'
  | 'inventoryEntries'
  | 'billAllocations'
  /* Ledger-entry fields. */
  | 'ledgerName'
  | 'amount'
  | 'isDeemedPositive'
  /* Bill-allocation fields. */
  | 'billReference'
  | 'billType'
  /* Inventory-entry fields. */
  | 'stockItemName'
  /* Master fields. */
  | 'masterName'
  | 'parent'
  | 'openingBalance'
  | 'registrationNumber'
  | 'email'
  | 'jurisdictionName'
  | 'countryName'
  | 'creditPeriod'
  | 'description'
  | 'baseUnit'
  | 'decimalPlaces'
  | 'supplyType'

/**
 * How a field's text is read.
 *
 * `'collapse'` for anything that is an identifier — a ledger name, a voucher number, a
 * date, an amount. `'keep'` for prose. See the whitespace note in the header.
 */
export type TallySpace = 'collapse' | 'keep'

/**
 * One element the reader looks for.
 *
 * `container` is a repeated child group whose ELEMENTS are the data (a voucher's ledger
 * entries); `value` is a field whose TEXT is the data. They are different lookups — one
 * returns elements, the other returns one agreed string — and a discriminated union is
 * what stops a caller asking the wrong one of a name and getting a plausible answer.
 */
export type TallyElementSpec =
  | {
      readonly kind: 'value'
      readonly elements: readonly string[]
      /** Attribute names on the element itself. Read as candidates beside the children. */
      readonly attributes: readonly string[]
      readonly space: TallySpace
    }
  | { readonly kind: 'container'; readonly elements: readonly string[] }

const value = (
  elements: readonly string[],
  options: { attributes?: readonly string[]; space?: TallySpace } = {},
): TallyElementSpec => ({
  kind: 'value',
  elements,
  attributes: options.attributes ?? [],
  space: options.space ?? 'collapse',
})

const container = (elements: readonly string[]): TallyElementSpec => ({
  kind: 'container',
  elements,
})

/**
 * The table.
 *
 * A total record over `TallyElementName` (CONVENTIONS §9): a name added to the union does
 * not compile until it has a row here, rather than falling through to whatever a lookup
 * happened to return.
 *
 * DELIBERATELY ABSENT, each for a reason, because "why is this name not here" is the
 * question a later batch with a real export will ask:
 *
 *   `EFFECTIVEDATE`   is a DIFFERENT FACT from `DATE` — the date a voucher takes effect
 *                     for ageing, which Tally lets differ from the date it is entered on.
 *                     Listing it as a candidate for `voucherDate` would make one of the
 *                     two silently win.
 *   `STATENAME`       on a voucher is the party's own state, not the place of supply.
 *                     The two differ on exactly the vouchers where it matters.
 *   `ACTUALQTY`,      carry a UNIT inside the text (`100 Nos`) and disagree with each
 *   `BILLEDQTY`       other whenever anything was supplied free. Inventory quantities are
 *                     not staged at all — see the header of `vouchers.ts`.
 *   `MASTERID`,       are Tally's own row numbers and are NOT stable across a re-export
 *   `ALTERID`         from a restored company, which is exactly what a source identifier
 *                     has to be. `GUID` is, and `sourceId` uses it.
 *   any tax element   `CGST`, `IGST`, a rate, a component: CONVENTIONS §1.6. Which
 *                     components apply is the regime's answer and this module may not
 *                     name one. A tax ledger is recognised through its PARENT GROUP
 *                     instead, which names no tax — see `classify.ts`.
 */
export const TALLY_ELEMENTS: Readonly<Record<TallyElementName, TallyElementSpec>> = {
  /*
   * Matched BY NAME AT ANY DEPTH, never by path.
   *
   * The documented shape is ENVELOPE/BODY/IMPORTDATA/REQUESTDATA/TALLYMESSAGE, and a real
   * export is as likely to be ENVELOPE/BODY/DATA/TALLYMESSAGE or to have no message
   * wrapper at all. A predicate keyed on the path would read nothing from a file that is
   * otherwise perfectly ordinary, and would say only that it found no vouchers. So the
   * reader matches the message AND the five things a message carries, and a voucher
   * outside a message is read exactly the same way — `readXmlSubtrees` does not yield a
   * match inside a match, so a voucher inside a message is never read twice.
   */
  message: container(['TALLYMESSAGE']),

  voucher: container(['VOUCHER']),
  ledger: container(['LEDGER']),
  group: container(['GROUP']),
  stockItem: container(['STOCKITEM']),
  unit: container(['UNIT']),

  voucherType: value(['VOUCHERTYPENAME', 'VCHTYPE'], { attributes: ['VCHTYPE'] }),
  voucherNumber: value(['VOUCHERNUMBER'], { attributes: ['VCHNUMBER'] }),
  voucherDate: value(['DATE']),
  partyLedger: value(['PARTYLEDGERNAME', 'PARTYNAME']),
  narration: value(['NARRATION'], { space: 'keep' }),
  reference: value(['REFERENCE', 'REFERENCENUMBER']),
  placeOfSupply: value(['PLACEOFSUPPLY']),
  isCancelled: value(['ISCANCELLED']),
  isOptional: value(['ISOPTIONAL']),
  sourceId: value(['GUID'], { attributes: ['REMOTEID'] }),

  ledgerEntries: container(['ALLLEDGERENTRIES.LIST', 'LEDGERENTRIES.LIST']),
  inventoryEntries: container(['ALLINVENTORYENTRIES.LIST', 'INVENTORYENTRIES.LIST']),
  billAllocations: container(['BILLALLOCATIONS.LIST']),

  ledgerName: value(['LEDGERNAME']),
  amount: value(['AMOUNT']),
  isDeemedPositive: value(['ISDEEMEDPOSITIVE']),

  billReference: value(['NAME']),
  billType: value(['BILLTYPE']),

  stockItemName: value(['STOCKITEMNAME']),

  masterName: value(['NAME'], { attributes: ['NAME'] }),
  parent: value(['PARENT']),
  openingBalance: value(['OPENINGBALANCE']),
  /* A party's registration number, exactly as `zoho/columns.ts` reads `GSTIN` into the
   * same field. This is a party's identifier, not a tax computation: CONVENTIONS §1.6 is
   * about where tax LOGIC lives, and there is none here. */
  registrationNumber: value(['PARTYGSTIN', 'GSTREGISTRATIONNUMBER']),
  email: value(['EMAIL']),
  jurisdictionName: value(['LEDSTATENAME', 'STATENAME']),
  countryName: value(['COUNTRYNAME', 'LEDGERCOUNTRYNAME']),
  creditPeriod: value(['CREDITPERIOD']),
  description: value(['DESCRIPTION'], { space: 'keep' }),
  baseUnit: value(['BASEUNITS']),
  decimalPlaces: value(['DECIMALPLACES']),
  supplyType: value(['GSTTYPEOFSUPPLY', 'TYPEOFSUPPLY']),
}

/**
 * Corrections to the names above: element name -> the names to look under.
 *
 * REPLACES the candidates rather than adding to them, exactly as `ZohoColumnOverrides`
 * does and for the same reason: adding would leave the wrong default in play, and a file
 * carrying both the default and the correction would then be reported as ambiguous, which
 * is the opposite of what somebody supplying a correction is asking for.
 *
 * `elements` and `attributes` are corrected independently, so a caller fixing a renamed
 * child element does not have to restate the attribute it is also written as.
 */
export type TallyElementOverrides = Readonly<
  Partial<
    Record<
      TallyElementName,
      { readonly elements?: readonly string[]; readonly attributes?: readonly string[] }
    >
  >
>

/**
 * The element table with the caller's corrections applied.
 *
 * @throws ImportError when a correction names an element this importer has no field for,
 *   or names no candidates at all. Both are the caller's mistake and both are silent
 *   otherwise: a typo in a field name would simply do nothing, and the user would be told
 *   their export was missing an element they had just supplied the name for.
 */
export function tallyElements(
  overrides: TallyElementOverrides = {},
): Readonly<Record<TallyElementName, TallyElementSpec>> {
  const table: Record<string, TallyElementSpec> = { ...TALLY_ELEMENTS }
  for (const [name, correction] of Object.entries(overrides)) {
    const spec = table[name]
    if (spec === undefined) {
      throw new ImportError(
        'IMPORT_SPEC_INVALID',
        `Coffer's Tally import has no element called ${JSON.stringify(name)}. It has: ` +
          `${Object.keys(TALLY_ELEMENTS).join(', ')}.`,
      )
    }
    if (correction === undefined) {
      continue
    }
    const elements = correction.elements ?? spec.elements
    if (elements.length === 0) {
      throw new ImportError(
        'IMPORT_SPEC_INVALID',
        `The correction for ${JSON.stringify(name)} names no elements to read from.`,
      )
    }
    table[name] =
      spec.kind === 'container'
        ? { kind: 'container', elements }
        : {
            kind: 'value',
            elements,
            attributes: correction.attributes ?? spec.attributes,
            space: spec.space,
          }
  }
  return table as Readonly<Record<TallyElementName, TallyElementSpec>>
}

/** The spec for one element. Refuses rather than returning nothing — see `tallyElements`. */
export function tallyElementSpec(
  name: TallyElementName,
  table: Readonly<Record<TallyElementName, TallyElementSpec>> = TALLY_ELEMENTS,
): TallyElementSpec {
  const spec = table[name]
  if (spec === undefined) {
    throw new ImportError(
      'IMPORT_SPEC_INVALID',
      `Coffer's Tally import has no element called ${JSON.stringify(name)}.`,
    )
  }
  return spec
}

/** One candidate that carried something, and which name it was written under. */
export interface TallyReading {
  /** The candidate name AS THE FILE SPELLS IT, so a message can quote the file. */
  readonly from: string
  readonly value: string
}

/**
 * What reading one field found.
 *
 * Three states and not `string | undefined`, because "two candidates disagree" is a fact
 * the caller has to report rather than resolve. `.find` would turn it into table order
 * (CONVENTIONS §9) and nothing downstream could see the difference.
 */
export type TallyValue =
  | { readonly kind: 'one'; readonly value: string; readonly from: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous'; readonly found: readonly TallyReading[] }

/**
 * Read one field off an element, from its attributes and its direct children.
 *
 * AGREEMENT, NOT POSITION. Every candidate that carries a non-blank value is collected;
 * one distinct value is the answer, none is absence, and two are a conflict. That is what
 * makes `VCHTYPE="Sales"` beside `<VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>` — which is
 * what a real voucher looks like — one reading rather than an ambiguity, while a voucher
 * whose two spellings genuinely disagree is reported instead of being decided by which
 * name this file happens to list first.
 *
 * BLANK IS ABSENT, and blankness is judged on the collapsed text whichever `space` the
 * field uses: a `<NARRATION>` holding nothing but an exporter's indentation is an empty
 * narration, not a narration made of spaces.
 *
 * @throws ImportError when asked for a container. A container's data is its ELEMENTS;
 *   returning its concatenated text would silently hand back every ledger name in a
 *   voucher joined together.
 */
export function tallyValue(
  element: XmlElement,
  name: TallyElementName,
  table: Readonly<Record<TallyElementName, TallyElementSpec>> = TALLY_ELEMENTS,
): TallyValue {
  const spec = tallyElementSpec(name, table)
  if (spec.kind === 'container') {
    throw new ImportError(
      'IMPORT_SPEC_INVALID',
      `${JSON.stringify(name)} is a repeated group in a Tally export, not a field. Read its ` +
        'elements with tallyChildren.',
    )
  }

  const found: TallyReading[] = []
  const keys = new Set(spec.attributes.map(elementKey))
  for (const [attribute, raw] of Object.entries(element.attributes)) {
    if (keys.has(elementKey(attribute))) {
      collect(found, attribute, raw, spec.space)
    }
  }
  const elementKeys = new Set(spec.elements.map(elementKey))
  for (const child of childElements(element)) {
    if (elementKeys.has(elementKey(child.name))) {
      collect(found, child.name, textOf(child), spec.space)
    }
  }

  const distinct = new Map<string, TallyReading>()
  for (const reading of found) {
    if (!distinct.has(reading.value)) {
      distinct.set(reading.value, reading)
    }
  }
  const [only, ...rest] = [...distinct.values()]
  if (only === undefined) {
    return { kind: 'none' }
  }
  if (rest.length > 0) {
    return { kind: 'ambiguous', found: [...distinct.values()] }
  }
  return { kind: 'one', value: only.value, from: only.from }
}

/** The value when there was exactly one, and `null` for absence or a conflict. */
export function tallyText(
  element: XmlElement,
  name: TallyElementName,
  table: Readonly<Record<TallyElementName, TallyElementSpec>> = TALLY_ELEMENTS,
): string | null {
  const read = tallyValue(element, name, table)
  return read.kind === 'one' ? read.value : null
}

/** What asking for a repeated group found. */
export type TallyChildren =
  | {
      readonly kind: 'one'
      /** The spelling the file used, so a message can quote it. */
      readonly from: string
      readonly children: readonly XmlElement[]
    }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous'; readonly found: readonly string[] }

/**
 * The elements of one repeated group.
 *
 * TWO SPELLINGS PRESENT IS AMBIGUOUS AND YIELDS NOTHING, and this is the case
 * `ALLLEDGERENTRIES.LIST` and `LEDGERENTRIES.LIST` exist to be handled by. Concatenating
 * them would double a voucher that wrote both, which is a voucher that then posts twice
 * its value; taking the first would make the answer depend on which name is listed above
 * the other in this file. Neither is a decision this module gets to make on somebody's
 * books, so both spellings are named in the report and the voucher is not staged.
 */
export function tallyChildren(
  element: XmlElement,
  name: TallyElementName,
  table: Readonly<Record<TallyElementName, TallyElementSpec>> = TALLY_ELEMENTS,
): TallyChildren {
  const spec = tallyElementSpec(name, table)
  const wanted = new Map<string, string>()
  for (const candidate of spec.elements) {
    wanted.set(elementKey(candidate), candidate)
  }

  const bySpelling = new Map<string, XmlElement[]>()
  for (const child of childElements(element)) {
    const key = elementKey(child.name)
    if (!wanted.has(key)) {
      continue
    }
    const already = bySpelling.get(key)
    if (already === undefined) {
      bySpelling.set(key, [child])
    } else {
      already.push(child)
    }
  }

  const [only, ...rest] = [...bySpelling.entries()]
  if (only === undefined) {
    return { kind: 'none' }
  }
  if (rest.length > 0) {
    return {
      kind: 'ambiguous',
      found: [...bySpelling.values()].map((children) => children[0]?.name ?? ''),
    }
  }
  return { kind: 'one', from: only[1][0]?.name ?? only[0], children: only[1] }
}

/** One element name the reader met and no field claimed. */
export interface UnclaimedElement {
  readonly name: string
  /** 1-based line of its first occurrence, so a message can send the user there. */
  readonly line: number
  readonly count: number
}

/**
 * Direct child elements whose name none of `claimed` matches, one entry per name.
 *
 * REPORTED RATHER THAN DROPPED, which is the whole answer to "what if a name in this file
 * is wrong". A field this importer looked for under the wrong name shows up here as an
 * element nobody claimed, in the same batch, with the line to look at — so the diagnosis
 * costs a glance at the import report rather than a debugging session against a
 * hundred-megabyte file.
 *
 * Aggregated by name with a count, because a real export repeats `LANGUAGENAME.LIST` on
 * every one of forty thousand ledgers, and forty thousand issues saying the same sentence
 * is a report nobody reads.
 */
export function unclaimedChildren(
  element: XmlElement,
  claimed: readonly TallyElementName[],
  table: Readonly<Record<TallyElementName, TallyElementSpec>> = TALLY_ELEMENTS,
): readonly UnclaimedElement[] {
  const keys = new Set<string>()
  for (const name of claimed) {
    for (const candidate of tallyElementSpec(name, table).elements) {
      keys.add(elementKey(candidate))
    }
  }

  const found = new Map<string, { name: string; line: number; count: number }>()
  for (const child of childElements(element)) {
    const key = elementKey(child.name)
    if (keys.has(key)) {
      continue
    }
    const already = found.get(key)
    if (already === undefined) {
      found.set(key, { name: child.name, line: child.line, count: 1 })
    } else {
      already.count += 1
    }
  }
  return [...found.values()]
}

/** Every distinct element name at or under `element`, in document order of first sight. */
export function elementNamesIn(element: XmlElement, into: Set<string>): void {
  const stack: XmlElement[] = [element]
  while (stack.length > 0) {
    const next = stack.pop()
    if (next === undefined) {
      break
    }
    into.add(next.name)
    const children = childElements(next)
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]
      if (child !== undefined) {
        stack.push(child)
      }
    }
  }
}

// ---- Internals ------------------------------------------------------------

function collect(into: TallyReading[], from: string, raw: string, space: TallySpace): void {
  if (isXmlWhitespaceOnly(raw)) {
    return
  }
  into.push({ from, value: space === 'keep' ? raw : collapseXmlSpace(raw) })
}
