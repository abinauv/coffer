/*
 * ═══════════════════════════════════════════════════════════════════════════════════
 *  GST RETURN GENERATION — STRUCTURALLY COMPLETE, SCHEMA-UNVERIFIED. READ THIS FIRST.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * These functions turn a period's documents into GSTR-1 and GSTR-3B. The ARITHMETIC is
 * tested to the paisa against fixtures worked by hand. The SHAPE — field names, nesting,
 * which figure belongs in which box — was written from the published description of the
 * returns and has NEVER been checked against GSTN's own JSON schema, nor been through a
 * filing cycle. Nothing in this folder should be read as confirmation that the portal
 * will accept it.
 *
 * That is a deliberate position and it is already this project's, in ARCHITECTURE §6.6:
 * an offline tool that quietly runs rules it cannot verify loses the trust that made
 * somebody choose it. So every artefact these functions produce carries a
 * `SCHEMA_UNVERIFIED` issue and a `notice` in its own body — a screen cannot render one
 * as a finished return without saying so.
 *
 * WHAT WOULD SETTLE IT: the published GSTN return JSON schema checked into the compliance
 * pack with a validator run over these artefacts, or one real filing cycle with the
 * portal's validation report kept beside the output. `provisional.ts` has the full list,
 * every rule that had to be chosen rather than looked up, and every field the data model
 * does not yet have.
 *
 * ── The shape of the module ────────────────────────────────────────────────────────
 *
 *   types.ts        THE SEAM. What a return needs from a document. No database, no
 *                   clock, no recomputation of tax — see its header on why that last
 *                   one is the rule everything else hangs off.
 *   amounts.ts      The four tax columns, and BOTH of the folder's rounding decisions.
 *   classify.ts     Which section a document belongs in, and what has to be true of it
 *                   before it may be in a return at all. Refusals, never filters.
 *   gstr1.ts        B2B, B2CL, B2CS, CDNR, CDNUR, EXP and DOC_ISSUE.
 *   hsn.ts          The HSN summary, and the UQC gap it exists to surface.
 *   gstr3b.ts       Tables 3.1, 3.2, 4 and the payment, including credit utilisation.
 *   pack.ts         The B2CL threshold, as a pack value rather than a literal.
 *   provisional.ts  What is not settled, and what would settle it.
 *   prepare.ts      The regime-neutral capability: books-shaped documents in, rows with
 *                   their own words out. The only door the rest of main uses.
 */

export { buildGstr1, buildDocIssue, resolveExport, NATURE_OF_DOCUMENT } from './gstr1'
export type {
  B2bInvoice,
  B2bParty,
  B2bSection,
  B2clPlace,
  B2clSection,
  B2csRow,
  B2csSection,
  CdnrParty,
  CdnrSection,
  CdnurNote,
  CdnurSection,
  CdnurType,
  DocIssueRow,
  DocIssueSection,
  ExportGroup,
  ExportInvoice,
  ExpSection,
  Gstr1Input,
  Gstr1Return,
  NoteType,
  RateRow,
  ReportedDocument,
  ReportedNote,
  SupplyType,
} from './gstr1'

export { buildGstr3b, utiliseCredit } from './gstr3b'
export type {
  Gstr3bDeclared,
  Gstr3bDefaults,
  Gstr3bInput,
  Gstr3bItcAvailable,
  Gstr3bItcReversed,
  Gstr3bPayment,
  Gstr3bReturn,
  Gstr3bTable31,
  Gstr3bTable32,
  Gstr3bTable4,
  IgstCreditPreference,
  InterStateSupplyRow,
  SupplyRow,
  Utilisation,
} from './gstr3b'

export { buildHsnSummary, emptyHsnSummary, uqcOf, UQC_NOT_APPLICABLE } from './hsn'
export type { HsnRow, HsnSummary } from './hsn'

export {
  assertNumbersDistinct,
  assertPeriod,
  assertReturnable,
  invoiceValueOf,
  isAboveThreshold,
  isCorrection,
  isExportSupply,
  isInterStateSupply,
  isRegisteredCounterparty,
  parseThreshold,
  sectionOf,
  signOf,
  taxableValueOf,
  taxValueOf,
} from './classify'
export type { Gstr1SectionId } from './classify'

export {
  bucketFor,
  RETURN_TAX_BUCKETS,
  TAX_BUCKETS,
  addTotals,
  fromTaxAmounts,
  grandTotalOf,
  isZeroTotals,
  negateTotals,
  roundTotalsToRupees,
  sumTotals,
  toTaxAmounts,
  totalsOfComponents,
  zeroAmounts,
  zeroTotals,
} from './amounts'
export type { TaxAmounts, TaxBucket, TaxTotals } from './amounts'

export { PROVISIONAL_NOTICE, RETURN_DECISIONS, RETURN_MODEL_GAPS } from './provisional'

export { INDIA_RETURN_FORMS, indiaReturns, toReturnDocument } from './prepare'
export type { ReturnDecision, ReturnModelGap } from './provisional'

export { blockingCount, isReturnError, issue, ReturnError } from './errors'
export type { ReturnErrorCode, ReturnIssue, ReturnIssueCode, ReturnIssueSeverity } from './errors'

export type {
  CorrectedDocument,
  DocumentIssueRange,
  ExportDetail,
  ExportTaxPayment,
  ItcEligibility,
  ReturnCounterparty,
  ReturnDocument,
  ReturnLine,
  ReturnPeriod,
  ReturnTaxAmount,
  SupplyTreatment,
} from './types'
