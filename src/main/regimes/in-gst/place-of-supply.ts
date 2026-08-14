/*
 * Place of supply — the question that decides which taxes apply.
 *
 * Under GST the tax split follows the *place of supply*, not the customer's billing
 * address and not where the goods physically went. For the ordinary case those coincide:
 * the place of supply is the recipient's location, so a Tamil Nadu supplier billing a
 * Tamil Nadu customer charges CGST + SGST, and the same supplier billing Karnataka
 * charges IGST.
 *
 * What this module deliberately does *not* do is guess. Three cases where the answer is
 * not the customer's state — supplies to an SEZ, goods delivered on a third party's
 * instruction (section 10(1)(b)), and services with their own place-of-supply rule such
 * as immovable property or transport — all resolve to a jurisdiction the caller knows
 * and this function does not. The seam for them is `TaxParty.jurisdictionCode`: the
 * caller passes the jurisdiction it has determined, and this module believes it. Baking
 * a guess in here is how the reference project ended up with one client's policy
 * embedded in a tax function.
 */

import type { PlaceOfSupply, TaxParty } from '@main/regimes/types'
import { gstinJurisdictionCode } from './gstin'

/** ISO 3166-1 alpha-2 for India, lower case. The regime's own country. */
export const INDIA_COUNTRY_CODE = 'in'

function normaliseCountry(countryCode: string): string {
  return countryCode.trim().toLowerCase()
}

/**
 * The jurisdiction a party sits in: the explicit code where there is one, otherwise the
 * state code carried in its GSTIN.
 *
 * The explicit code wins because it is the one a user can see and correct. The GSTIN is
 * a fallback rather than the primary source for the same reason: a party can be
 * unregistered and still have a state.
 */
export function jurisdictionOf(party: TaxParty): string | null {
  const explicit = party.jurisdictionCode?.trim()
  if (explicit !== undefined && explicit !== '') {
    return explicit
  }
  if (party.registrationNumber === null) {
    return null
  }
  return gstinJurisdictionCode(party.registrationNumber)
}

/**
 * Where the supply is treated as taking place.
 *
 * `isIntraJurisdiction` is true only when both states are known *and* equal. An unknown
 * state on either side is not evidence that they match, so it resolves to inter-state —
 * which is the conservative answer, because IGST charged where CGST+SGST was due is a
 * correctable filing error, whereas a state split recorded against the wrong state is
 * money paid to the wrong government.
 */
export function placeOfSupply(supplier: TaxParty, customer: TaxParty): PlaceOfSupply {
  const customerCountry = normaliseCountry(customer.countryCode)
  const isExport = customerCountry !== INDIA_COUNTRY_CODE

  if (isExport) {
    /* A supply leaving India has no Indian state as its place of supply. Exports are
     * treated as inter-state, so `isIntraJurisdiction` is false whatever the states say. */
    return {
      jurisdictionCode: null,
      countryCode: customerCountry,
      isIntraJurisdiction: false,
      isExport: true,
    }
  }

  const supplierJurisdiction = jurisdictionOf(supplier)
  const customerJurisdiction = jurisdictionOf(customer)

  return {
    jurisdictionCode: customerJurisdiction,
    countryCode: INDIA_COUNTRY_CODE,
    isIntraJurisdiction:
      supplierJurisdiction !== null &&
      customerJurisdiction !== null &&
      supplierJurisdiction === customerJurisdiction,
    isExport: false,
  }
}
