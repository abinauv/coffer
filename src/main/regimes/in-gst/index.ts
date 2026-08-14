/*
 * The India GST regime.
 *
 * `inGstRegime` is the only export the rest of the application should ever need, and it
 * should reach for it through the registry in `regimes/index.ts` rather than from here —
 * eslint enforces that for `domain/` and the renderer (CONVENTIONS §1.6).
 *
 * The remaining exports are for this regime's own screens and for Phase 5's return
 * generation: a GSTIN field needs the validator, an HSN picker needs the seed codes, and
 * neither wants to go through `TaxRegime` to get them.
 */

export { inGstRegime } from './regime'

export { amountInWords, numberInWords } from './amount-in-words'

export {
  defaultRateFor,
  findClassification,
  HSN_LENGTHS,
  indiaClassification,
  normaliseClassificationCode,
  rateSlabs,
  SAC_LENGTH,
  classificationKindOf,
  searchClassification,
  validateClassificationCode,
} from './classification'

export {
  BUNDLED_COMPLIANCE_PACK,
  type ClassificationEntry,
  type ClassificationKind,
  type GstRateSlab,
  type IndiaCompliancePack,
} from './compliance-pack'

export { INDIA_FILINGS } from './filings'

export {
  GSTIN_LENGTH,
  gstinCheckCharacter,
  gstinJurisdictionCode,
  gstinJurisdictionName,
  normaliseGstin,
  validateGstin,
} from './gstin'

export {
  findJurisdiction,
  INDIAN_JURISDICTIONS,
  intraStateComponentFor,
  isKnownJurisdictionCode,
  jurisdictionName,
  jurisdictions,
  type IndianJurisdiction,
  type IntraStateComponentCode,
  type JurisdictionStatus,
  type JurisdictionType,
} from './jurisdictions'

export { INDIA_NUMBER_FORMAT } from './number-format'

export { INDIA_COUNTRY_CODE, jurisdictionOf, placeOfSupply } from './place-of-supply'

export {
  computeTax,
  GST_COMPONENT_ORDER,
  splitComponents,
  summarise,
  taxLine,
  type GstComponentCode,
} from './tax'
