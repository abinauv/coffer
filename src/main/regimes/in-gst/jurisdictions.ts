/*
 * The Indian states and union territories, by GST state code.
 *
 * The code is the first two digits of every GSTIN, and it is what decides the tax
 * split: a supply that stays inside one code is CGST + SGST, one that crosses codes is
 * IGST. So this table is not decoration — `place-of-supply.ts` and `tax.ts` both read
 * it, and getting an entry wrong changes what a user is charged.
 *
 * Two facts here are easy to miss and both are load-bearing:
 *
 *   - A union territory *without* its own legislature levies UTGST where a state levies
 *     SGST. Delhi, Puducherry and Jammu & Kashmir are union territories that do have a
 *     legislature, so they levy SGST like a state. That is why the component is a field
 *     rather than something derived from `type`.
 *   - Codes are never reused, but they are retired. 25 (Daman and Diu) and 28 (the
 *     undivided Andhra Pradesh) still appear on documents issued before the respective
 *     reorganisations, so validation must accept them; a picker offering them today
 *     would be wrong. Hence `status`.
 *
 * The list is a fact about Indian law, not about a rate, so it stays in code rather than
 * in the compliance pack (ARCHITECTURE §6.6) — a state is created by an Act of
 * Parliament, which arrives with a release, not with a data refresh.
 */

/** Whether the jurisdiction is a state, a union territory, or neither. */
export type JurisdictionType = 'state' | 'union-territory' | 'other'

/**
 * Whether a code is one that may be used today. `superseded` codes are still valid on
 * historical documents and must still validate — they are simply not offered.
 */
export type JurisdictionStatus = 'current' | 'superseded'

/** The state-level component of an intra-state supply. */
export type IntraStateComponentCode = 'SGST' | 'UTGST'

export interface IndianJurisdiction {
  /** Two-digit GST state code, e.g. '33'. */
  readonly code: string
  readonly name: string
  readonly type: JurisdictionType
  /**
   * SGST for states and for union territories with their own legislature; UTGST for
   * union territories without one.
   */
  readonly intraStateComponent: IntraStateComponentCode
  readonly status: JurisdictionStatus
}

function state(code: string, name: string): IndianJurisdiction {
  return { code, name, type: 'state', intraStateComponent: 'SGST', status: 'current' }
}

/** A union territory without a legislature: UTGST, not SGST. */
function unionTerritory(code: string, name: string): IndianJurisdiction {
  return {
    code,
    name,
    type: 'union-territory',
    intraStateComponent: 'UTGST',
    status: 'current',
  }
}

/** A union territory that has its own legislature, and so levies SGST. */
function unionTerritoryWithLegislature(code: string, name: string): IndianJurisdiction {
  return { code, name, type: 'union-territory', intraStateComponent: 'SGST', status: 'current' }
}

function superseded(entry: IndianJurisdiction): IndianJurisdiction {
  return { ...entry, status: 'superseded' }
}

/** Every GST state code, current and retired, in code order. */
export const INDIAN_JURISDICTIONS: readonly IndianJurisdiction[] = [
  unionTerritoryWithLegislature('01', 'Jammu and Kashmir'),
  state('02', 'Himachal Pradesh'),
  state('03', 'Punjab'),
  unionTerritory('04', 'Chandigarh'),
  state('05', 'Uttarakhand'),
  state('06', 'Haryana'),
  unionTerritoryWithLegislature('07', 'Delhi'),
  state('08', 'Rajasthan'),
  state('09', 'Uttar Pradesh'),
  state('10', 'Bihar'),
  state('11', 'Sikkim'),
  state('12', 'Arunachal Pradesh'),
  state('13', 'Nagaland'),
  state('14', 'Manipur'),
  state('15', 'Mizoram'),
  state('16', 'Tripura'),
  state('17', 'Meghalaya'),
  state('18', 'Assam'),
  state('19', 'West Bengal'),
  state('20', 'Jharkhand'),
  state('21', 'Odisha'),
  state('22', 'Chhattisgarh'),
  state('23', 'Madhya Pradesh'),
  state('24', 'Gujarat'),
  /* Merged into 26 in January 2020. Kept so pre-merger documents still validate. */
  superseded(unionTerritory('25', 'Daman and Diu')),
  unionTerritory('26', 'Dadra and Nagar Haveli and Daman and Diu'),
  state('27', 'Maharashtra'),
  /* The undivided Andhra Pradesh. Telangana is 36 and the successor state is 37. */
  superseded(state('28', 'Andhra Pradesh (before bifurcation)')),
  state('29', 'Karnataka'),
  state('30', 'Goa'),
  unionTerritory('31', 'Lakshadweep'),
  state('32', 'Kerala'),
  state('33', 'Tamil Nadu'),
  unionTerritoryWithLegislature('34', 'Puducherry'),
  unionTerritory('35', 'Andaman and Nicobar Islands'),
  state('36', 'Telangana'),
  state('37', 'Andhra Pradesh'),
  unionTerritory('38', 'Ladakh'),
  /* 97 covers supplies in India's exclusive economic zone and other offshore areas.
   * 99 is not a place of supply at all — it identifies registrations administered
   * centrally, and it appears in a GSTIN, which is why it has to be recognised here. */
  {
    code: '97',
    name: 'Other Territory',
    type: 'other',
    intraStateComponent: 'UTGST',
    status: 'current',
  },
  {
    code: '99',
    name: 'Centre Jurisdiction',
    type: 'other',
    intraStateComponent: 'UTGST',
    status: 'current',
  },
]

const BY_CODE: ReadonlyMap<string, IndianJurisdiction> = new Map(
  INDIAN_JURISDICTIONS.map((entry) => [entry.code, entry]),
)

/** The full record for a code, or null when the code is not an Indian state code. */
export function findJurisdiction(code: string): IndianJurisdiction | null {
  return BY_CODE.get(code) ?? null
}

/** True when `code` is a state code that has ever been issued, retired ones included. */
export function isKnownJurisdictionCode(code: string): boolean {
  return BY_CODE.has(code)
}

/**
 * The name for a code, or null. Resolves retired codes too — a 2018 invoice carrying
 * state code 28 should still print 'Andhra Pradesh (before bifurcation)' rather than
 * a blank.
 */
export function jurisdictionName(code: string): string | null {
  return findJurisdiction(code)?.name ?? null
}

/**
 * The jurisdictions a user may pick today: current codes only, and not the two that are
 * registration artefacts rather than places (97 and 99).
 */
export function jurisdictions(): ReadonlyArray<{ code: string; name: string }> {
  return INDIAN_JURISDICTIONS.filter(
    (entry) => entry.status === 'current' && entry.type !== 'other',
  ).map((entry) => ({ code: entry.code, name: entry.name }))
}

/**
 * Which component a supply inside `code` levies alongside CGST.
 *
 * Defaults to SGST for a code we do not recognise: an unknown code is a data problem
 * worth surfacing elsewhere, and SGST is the answer for 32 of the 38 real ones.
 */
export function intraStateComponentFor(code: string): IntraStateComponentCode {
  return findJurisdiction(code)?.intraStateComponent ?? 'SGST'
}
