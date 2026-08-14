/*
 * The data half of the regime: rate slabs and classification codes.
 *
 * ARCHITECTURE §6.6 — "GST rates, HSN/SAC lists, return schemas and validation rules
 * ship as a data pack with its own version, loadable without a new binary." Rates change
 * on the Council's timetable, not on ours, and an offline tool quietly running last
 * year's schedule loses the trust that made someone choose it.
 *
 * This file is the shape that pack takes, plus the copy bundled with the binary. It is
 * data and nothing else: no functions, no lookups, no logic. Every consumer takes an
 * `IndiaCompliancePack` as an argument and defaults to the bundled one, so the Phase 5
 * loader has only to produce a different value of this type — no call site changes, and
 * no code moves.
 *
 * What deliberately is *not* here: the CGST/SGST/IGST split, the halving of an
 * intra-state rate, and the state list. Those are the structure of the Act rather than
 * its schedules — they change by amendment, which arrives with a release. Putting them
 * in the pack would let a data file redefine what a tax is.
 *
 * The bundled entries are a seed so that a new company is not staring at an empty HSN
 * picker. They are defaults a user may override per item, not assertions about any
 * particular supply — classification is the taxpayer's call and depends on the goods,
 * not on the four digits somebody typed.
 */

import type { DateString, DecimalString } from '@shared/scalars'

/** A rate that exists in the schedules, offered when picking a rate for an item. */
export interface GstRateSlab {
  /** The full rate as a percentage, e.g. '18'. Intra-state supplies halve it. */
  readonly ratePct: DecimalString
  /** What the user sees in a picker. */
  readonly label: string
  /** Why this slab exists, where it is not obvious. */
  readonly note: string
}

/** Which of the two Indian classification schemes a code belongs to. */
export type ClassificationKind = 'HSN' | 'SAC'

/** One bundled classification code. */
export interface ClassificationEntry {
  readonly code: string
  readonly kind: ClassificationKind
  readonly description: string
  /** The rate the pack suggests when this code is chosen. A default, not a ruling. */
  readonly defaultRatePct: DecimalString
}

export interface IndiaCompliancePack {
  /** Pack version, independent of the application version. */
  readonly packVersion: string
  /** The date from which this pack's contents are the current ones. */
  readonly effectiveFrom: DateString
  /** Where the contents came from, for the "which rules am I running?" screen. */
  readonly source: string
  readonly rateSlabs: readonly GstRateSlab[]
  readonly classificationCodes: readonly ClassificationEntry[]
}

function hsn(
  code: string,
  description: string,
  defaultRatePct: DecimalString,
): ClassificationEntry {
  return { code, kind: 'HSN', description, defaultRatePct }
}

function sac(
  code: string,
  description: string,
  defaultRatePct: DecimalString,
): ClassificationEntry {
  return { code, kind: 'SAC', description, defaultRatePct }
}

/**
 * The pack that ships inside the binary.
 *
 * Bumping `packVersion` is the visible act that says the numbers below changed; a fixture
 * pins both the version and a sample of the contents, so an edit here cannot pass
 * unnoticed.
 */
export const BUNDLED_COMPLIANCE_PACK: IndiaCompliancePack = {
  packVersion: '2026.04.0',
  effectiveFrom: '2026-04-01',
  source: 'Bundled seed data. Replaced by a loaded compliance pack once one is installed.',

  rateSlabs: [
    { ratePct: '0', label: 'Nil', note: 'Exempt, nil-rated and zero-rated supplies.' },
    { ratePct: '0.25', label: '0.25%', note: 'Rough diamonds and unworked precious stones.' },
    { ratePct: '1.5', label: '1.5%', note: 'Cut and polished diamonds.' },
    { ratePct: '3', label: '3%', note: 'Gold, silver, platinum and articles of them.' },
    { ratePct: '5', label: '5%', note: 'Essentials and most transport services.' },
    { ratePct: '12', label: '12%', note: 'Standard-rate goods below the main slab.' },
    { ratePct: '18', label: '18%', note: 'The main slab — most goods and most services.' },
    { ratePct: '28', label: '28%', note: 'Luxury and demerit goods.' },
    { ratePct: '40', label: '40%', note: 'The special demerit rate.' },
  ],

  classificationCodes: [
    hsn('0401', 'Milk and cream, not concentrated or sweetened', '0'),
    hsn('0901', 'Coffee, whether or not roasted', '5'),
    hsn('0902', 'Tea, whether or not flavoured', '5'),
    hsn('1006', 'Rice', '5'),
    hsn('1101', 'Wheat or meslin flour', '5'),
    hsn('1701', 'Cane or beet sugar', '5'),
    hsn('1905', 'Bread, pastry, cakes, biscuits and other bakers wares', '18'),
    hsn('2106', 'Food preparations not elsewhere specified', '18'),
    hsn('2201', 'Waters, including mineral and aerated waters', '18'),
    hsn('3004', 'Medicaments, in measured doses or for retail sale', '5'),
    hsn('3306', 'Oral and dental hygiene preparations', '18'),
    hsn('3401', 'Soap and organic surface-active products', '18'),
    hsn('3923', 'Plastic articles for the conveyance or packing of goods', '18'),
    hsn('4820', 'Registers, account books, notebooks and similar articles', '18'),
    hsn('4901', 'Printed books, brochures and similar printed matter', '0'),
    hsn('6109', 'T-shirts, singlets and other vests, knitted or crocheted', '5'),
    hsn('7113', 'Articles of jewellery and parts of them', '3'),
    hsn('7308', 'Structures and parts of structures, of iron or steel', '18'),
    hsn('8415', 'Air conditioning machines', '28'),
    hsn('8471', 'Automatic data processing machines and units of them', '18'),
    hsn('8517', 'Telephone sets, including smartphones, and other network apparatus', '18'),
    hsn('8544', 'Insulated wire, cable and other insulated electric conductors', '18'),
    hsn('9403', 'Other furniture and parts of it', '18'),
    hsn('9405', 'Luminaires and lighting fittings', '18'),

    sac('995411', 'Construction services of a single dwelling or multi-dwelling building', '18'),
    sac('996511', 'Road transport services of goods', '5'),
    sac('996812', 'Courier services', '18'),
    sac(
      '997212',
      'Rental or leasing services involving own or leased non-residential property',
      '18',
    ),
    sac('998219', 'Other legal services', '18'),
    sac('998222', 'Accounting and bookkeeping services', '18'),
    sac('998313', 'Information technology consulting and support services', '18'),
    sac('998314', 'Information technology design and development services', '18'),
    sac('998363', 'Sale of advertising space, except on commission', '18'),
    sac('998596', 'Events, exhibitions, conventions and trade show organisation services', '18'),
    sac('999293', 'Commercial training and coaching services', '18'),
  ],
}
