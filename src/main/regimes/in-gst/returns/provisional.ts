/*
 * ============================================================================
 * THESE RETURNS ARE STRUCTURALLY COMPLETE AND SCHEMA-UNVERIFIED. READ THIS.
 * ============================================================================
 *
 * Every section shape in this folder was written from the published description of
 * GSTR-1 and GSTR-3B. NONE of it has been checked against GSTN's own JSON schema, and
 * none of it has been through a filing cycle. The arithmetic is tested to the paisa
 * against fixtures worked by hand; the SHAPE — field names, nesting, which figure the
 * portal expects in which box — is a reading, not a confirmation.
 *
 * This is deliberate and it is the project's own position, not a shortcut. ARCHITECTURE
 * §6.6: return schemas ship as a versioned compliance pack, because "an offline tool that
 * silently runs stale rules loses the trust that is the entire reason someone chose it".
 * A tool that quietly files a wrong return is worse than one that says it is provisional.
 *
 * WHAT WOULD SETTLE IT, in order of how much it settles:
 *
 *   1. The published GSTN return JSON schema, checked into the compliance pack, with a
 *      validator run over the artefacts these functions produce. That settles the shape.
 *   2. One real filing cycle by a real taxpayer, with the portal's own validation report
 *      kept beside the artefact. That settles the shape AND the rules.
 *   3. For the individual rules below, the specific document named against each.
 *
 * Until then every artefact this folder produces carries a `SCHEMA_UNVERIFIED` issue.
 * That is not decoration: it is the artefact stating its own status to whatever renders
 * it, so a screen cannot show one of these as a finished return without saying so.
 *
 * ── Two lists, and they answer different questions ─────────────────────────────────
 *
 * `RETURN_MODEL_GAPS` is about the DATA MODEL: fields a return needs that no table has.
 * Each one is an input on `ReturnDocument` today; each one wants a column eventually.
 * This list is what the batch wiring these functions up has to read.
 *
 * `RETURN_DECISIONS` is about the RULES: places where the correct answer was not certain
 * and something had to be chosen. Each decision is named, has a stated alternative, and
 * is pinned by a test — so changing it breaks something, which is the whole point. A
 * silent guess would leave no trace of ever having been made.
 */

/** One thing the data model does not record that a return needs. */
export interface ReturnModelGap {
  /** Stable key. Named for the field, not for the return that wants it. */
  readonly id: string
  /** Where the column belongs, in `table.column` form, when that is decidable. */
  readonly wants: string
  /** Which returns and sections stop being complete without it. */
  readonly neededFor: readonly string[]
  /** What this module does in the meantime. Never "nothing". */
  readonly interim: string
}

/**
 * Every field a return needs that no table in this database has.
 *
 * ORDERED BY HOW MUCH IS WRONG WITHOUT IT, not alphabetically. The ones left change
 * fields the portal rejects on; the three that changed figures a taxpayer SIGNS have been
 * filled and deleted.
 *
 * THREE ENTRIES WERE REMOVED IN PHASE 4.2 AND THE DELETION IS THE POINT. A list of things
 * still owed that carries things already delivered stops being read, which is the same
 * argument the `b2cl-threshold-in-the-compliance-pack` note below makes. What went, and
 * what filled it:
 *
 *   `export-tax-payment` — migration 0020 added `documents.export_tax_payment`, AND
 *   `computeTax` now honours it, which was the half that made this more than a reporting
 *   gap: a supply under an LUT carries its rate and no tax, where before the only way to
 *   reach a nil figure was a rate of zero, which files as nil-rated rather than
 *   zero-rated. `resolveExport` still infers the flavour when a caller hands over a
 *   document that does not state it, and still raises an issue when it does.
 *
 *   `reverse-charge` — migration 0020 added `documents.is_reverse_charge`, NOT NULL, and
 *   `domain/documents/posting.ts` posts the two entries one bill gives rise to: the
 *   recipient owes the output tax and may claim the input credit, and the supplier is
 *   credited with the net.
 *
 *   `itc-eligibility` — migration 0021 added `document_lines.itc_eligibility`, ON THE
 *   LINE, which was the substance of the gap rather than a detail of it. `ReturnLine`
 *   carries it, GSTR-3B table 4 splits a single bill across 4(A) and 4(D) line by line,
 *   and the posting rule costs a blocked line's tax into the expense instead of into an
 *   asset that will never be realised.
 *
 * WHAT SURVIVES THE DELETIONS is that all three are still INPUTS on `ReturnDocument` and
 * `ReturnLine` rather than queries — the seam is the point — and that null still means
 * "the caller did not say". The issues each gap described are therefore still raised;
 * they now report a caller's omission rather than the data model's.
 */
export const RETURN_MODEL_GAPS: readonly ReturnModelGap[] = [
  {
    id: 'itc-reversals',
    wants: 'A place to record rule 42/43 reversals for a period. Not a document field.',
    neededFor: ['GSTR-3B 4(B)'],
    interim:
      'Taken as an explicit input, defaulting to zero. Zero is a CLAIM, not an absence, ' +
      'so a period with exempt outward supplies and no declared reversal raises ' +
      'EXEMPT_SUPPLIES_WITHOUT_REVERSAL — rule 42 is what makes that combination doubtful.',
  },
  {
    id: 'uqc',
    wants:
      'units_of_measure.regime_code — the column exists (migration 0006) and is never populated',
    neededFor: ['GSTR-1 HSN'],
    interim:
      'Taken as `uqc` on the line and reported as null when absent, with UQC_NOT_MAPPED ' +
      'at severity error, because the portal will not take an HSN row without one. A ' +
      "line with no unit at all is a service and files as 'NA', which is not a gap. What " +
      'is missing is not the column but a UI and a seed mapping that fill it: 0006 says ' +
      '"nothing in Phase 2 reads it", and this is the thing that reads it.',
  },
  {
    id: 'supply-treatment',
    wants:
      "documents.supply_treatment — 'regular' | 'sez-with-payment' | 'sez-without-payment' | 'deemed-export'",
    neededFor: ['GSTR-1 B2B invoice type'],
    interim:
      "Taken as an input, defaulting to 'regular'. It affects only the invoice-type label " +
      'on a B2B row here — the TAX on the document is whatever was invoiced, which is ' +
      'already settled and is not recomputed. An SEZ supply is zero-rated and would also ' +
      'belong in 3.1(b) rather than 3.1(a); this module does not make that move, because ' +
      'a field defaulting to `regular` cannot be trusted to carry it.',
  },
  {
    id: 'import-and-isd-credit',
    wants:
      'A way to mark an inward supply as an import of goods, an import of services, or an ISD distribution',
    neededFor: ['GSTR-3B 4(A)(1)', 'GSTR-3B 4(A)(2)', 'GSTR-3B 4(A)(4)'],
    interim:
      'Taken as explicit inputs, defaulting to zero, each raising FIGURE_NOT_DERIVABLE ' +
      'when it is left at zero and any inward tax exists at all.',
  },
  {
    id: 'non-gst-supplies',
    wants:
      'An outward supply that GST does not reach at all — alcohol, petroleum, a salary recharge',
    neededFor: ['GSTR-3B 3.1(e)'],
    interim:
      'Taken as an explicit input, defaulting to zero. NOT inferred from a nil rate: a ' +
      'nil-rated supply is inside GST and is 3.1(c), and folding the two together would ' +
      'put an exempt supply where a non-GST one belongs and change a rule 42 reversal.',
  },
  {
    id: 'outward-debit-note',
    wants:
      'A sixth document kind: a supplementary invoice that RAISES the value of an outward ' +
      'supply. `shared/documents.ts` has `debit-note` on the purchase side only.',
    neededFor: ['GSTR-1 CDNR', 'GSTR-1 CDNUR', 'GSTR-1 DOC_ISSUE'],
    interim:
      'CDNR and CDNUR carry a `noteType` resolved from the kind’s direction through a ' +
      'total record, so it says `credit` for every note this model can produce and would ' +
      'say `debit` for an outward charge-direction note the day one exists. Nothing is ' +
      'hardcoded to `credit`; the value is simply the only one reachable today.',
  },
  {
    id: 'party-registration-type',
    wants: "parties.registration_type — 'regular' | 'composition' | 'uin' | 'unregistered'",
    neededFor: ['GSTR-3B 3.2'],
    interim:
      'Table 3.2 returns its composition-dealer and UIN-holder rows EMPTY rather than ' +
      'omitting them, so a reader can see the two were considered and found ' +
      'un-answerable. A composition dealer holds a GSTIN like anybody else, so nothing in ' +
      'the model separates them — and their supplies are, correctly, already in B2B.',
  },
  {
    id: 'shipping-bill',
    wants: 'documents.shipping_bill_number, shipping_bill_date, port_code',
    neededFor: ['GSTR-1 EXP'],
    interim:
      'Taken as inputs and reported as null, with EXPORT_SHIPPING_BILL_MISSING at ' +
      'severity error on an export that has none — the portal requires it for a refund.',
  },
  {
    id: 'document-issue-ranges',
    wants:
      'Nothing. `numbering_series` and `numbering_counters` already know, and no query asks them.',
    neededFor: ['GSTR-1 DOC_ISSUE'],
    interim:
      'Taken as an input. The ranges are a fact about the SERIES and the period, not ' +
      'about any document in the return — a period whose every invoice was cancelled ' +
      'still has a range to declare, and a return built only from its documents could ' +
      'not see it. So this is a seam rather than a gap.',
  },
] as const

/** One rule that had to be chosen rather than looked up. */
export interface ReturnDecision {
  /** Stable key. Tests refer to it by this. */
  readonly id: string
  /** What was decided, in one sentence. */
  readonly decided: string
  /** Why — the reasoning, not the authority. */
  readonly because: string
  /** The other answer, named, so it is obvious what changing this would mean. */
  readonly alternative: string
  /** What would settle it. Never 'ask a lawyer'. */
  readonly settledBy: string
}

/**
 * Every place a rule was not certain and something had to be chosen.
 *
 * Each one is pinned by a test that asserts the BEHAVIOUR, not the text — so the entry
 * and the code cannot drift apart without something going red. `provisional.test.ts`
 * holds the join: a `PINNED_BY` map from every id here to the test that pins it, asserted
 * to have exactly these ids as its keys. That is what stops this becoming a list of
 * comments nobody maintains — an entry added with nothing behind it fails immediately.
 */
export const RETURN_DECISIONS: readonly ReturnDecision[] = [
  {
    id: 'b2cl-threshold-is-strictly-greater',
    decided:
      'A B2CL invoice is one whose invoice value is STRICTLY GREATER than the threshold. ' +
      'A document exactly at the threshold is B2CS.',
    because:
      'The rule is written as "invoice value more than", and "more than" excludes the ' +
      'boundary. The boundary case is a real one — a round-figure invoice for exactly one ' +
      'lakh is an ordinary thing to raise.',
    alternative: 'Treat `>=` as the test, moving every exactly-at-threshold invoice into B2CL.',
    settledBy: 'The threshold clause of rule 59 as worded in the current notification.',
  },
  {
    id: 'b2cl-invoice-value-includes-tax',
    decided:
      'The value compared against the threshold is the INVOICE value — taxable value plus ' +
      'tax plus any whole-rupee round-off — not the taxable value.',
    because:
      '"Invoice value" is what the customer pays and what the return column is called. ' +
      'Using the taxable value instead would move every invoice within a rate-eighteenth ' +
      'of the threshold into the wrong section.',
    alternative: 'Compare the taxable value, which is the figure the section rows are built from.',
    settledBy: 'The column definition in the published GSTR-1 schema.',
  },
  {
    id: 'utgst-files-in-the-state-tax-column',
    decided: 'UTGST is reported in the same column as SGST.',
    because:
      'The return has one State/UT tax column and a supply attracts one or the other, ' +
      'never both — so a separate UTGST column would be empty on every return that had ' +
      'an SGST figure and vice versa. The component keeps its own code on the document; ' +
      'only the return folds them.',
    alternative: 'A fourth column, filed empty for all but union-territory supplies.',
    settledBy: 'The field list of the published GSTR-1 schema.',
  },
  {
    id: 'exports-infer-payment-from-tax-charged',
    decided:
      'An export with no stated flavour is WITH PAYMENT when it carries tax and UNDER LUT ' +
      'when it carries none; a nil-rated export with no tax is assumed to be under LUT.',
    because:
      'A zero-rated supply under LUT or bond carries no tax by definition, and one on ' +
      'which tax is paid carries IGST — so the tax already answers the question for every ' +
      'export with a rate. Only a nil-rated export is genuinely ambiguous, and LUT is the ' +
      'commoner case; both raise an issue so the assumption is never invisible.',
    alternative:
      'Refuse to build a return until every export names its flavour, which would make ' +
      'the module unusable against every document in the database today.',
    settledBy:
      'Nothing further for a document that states it: `documents.export_tax_payment` ' +
      'exists since migration 0020 and `resolveExport` returns it unchanged. This ' +
      'decision now governs only a document that does NOT state it — one imported from ' +
      'another system, or raised before the column existed — and what would settle that ' +
      'is the same column being filled in.',
  },
  {
    id: 'unregistered-notes-all-go-to-cdnur',
    decided:
      'Every credit or debit note against an unregistered party is listed in CDNUR, ' +
      'whatever its value, and none of them is netted into B2CS.',
    because:
      'Netting a note into an aggregate row destroys the only trace of it: B2CS carries no ' +
      'document number, so once a note is folded in, nothing in the return can be matched ' +
      'back to the paper. A listed note that the portal would rather have seen aggregated ' +
      'is a correctable filing; an aggregated one that should have been listed is not ' +
      'recoverable from the return at all.',
    alternative:
      'Net small intra-state unregistered notes into B2CS and list only the ones above ' +
      'the B2CL threshold, which is how the portal describes it.',
    settledBy: 'The CDNUR row definition and its UR-type enumeration in the published schema.',
  },
  {
    id: 'hsn-summary-nets-corrections',
    decided:
      'The HSN summary carries a credit or debit note with the sign of its direction, so ' +
      'a period’s HSN total is the NET supply. The value sections carry every figure ' +
      'positive, as the document was raised.',
    because:
      'The HSN summary is a statement of what was supplied in the period, and a returned ' +
      'consignment was not supplied. The value sections are a statement of what documents ' +
      'were issued, and a credit note for 5,000 was issued for 5,000, not for -5,000.',
    alternative:
      'Report the HSN summary gross, matching the value sections exactly and overstating ' +
      'the period’s supply by the value of every return.',
    settledBy: 'The HSN table’s own instructions in the published schema.',
  },
  {
    id: 'cancelled-documents-appear-only-in-doc-issue',
    decided:
      'A cancelled document contributes to no value section and is counted in DOC_ISSUE ' +
      'as cancelled.',
    because:
      'A cancelled document makes no supply, so there is no value to report — but its ' +
      'number was consumed, and DOC_ISSUE exists precisely to account for numbers that ' +
      'were issued and not used. Omitting it entirely would leave a hole in the series ' +
      'that somebody has to explain to an officer.',
    alternative:
      'Report it in its value section at nil, which would put a document number in the ' +
      'return against a supply that was never made.',
    settledBy: 'Nothing external — this follows from rule 46(b) and migration 0008’s rule 2.',
  },
  {
    id: 'outward-reverse-charge-carries-no-liability',
    decided:
      'An outward supply flagged reverse charge contributes its taxable value to GSTR-3B ' +
      '3.1(a) and contributes NOTHING to the tax payable.',
    because:
      'On a reverse-charge supply the recipient discharges the tax. Counting it as the ' +
      'supplier’s liability would charge the same tax twice across two returns.',
    alternative:
      'Exclude the taxable value from 3.1(a) as well, which would understate turnover ' +
      'against the same period’s GSTR-1.',
    settledBy:
      'The 3.1 row definitions, and specifically whether row 3.1.1 (supplies under ' +
      'section 9(5)) is where these belong instead. This module does not produce 3.1.1.',
  },
  {
    id: 'igst-credit-is-spent-before-any-other',
    decided:
      'IGST credit is set against IGST liability first and its remainder against CGST and ' +
      'then SGST; only then is CGST or SGST credit used, each against its own liability ' +
      'first and IGST second. CGST and SGST credit never cross.',
    because:
      'Section 49A requires the integrated-tax credit to be exhausted before the others. ' +
      'The prohibition on CGST-against-SGST is the settled part and is not a choice.',
    alternative:
      'Spend CGST and SGST credit first, which leaves an IGST balance carried forward and ' +
      'is what section 49A exists to prevent.',
    settledBy: 'Sections 49, 49A and 49B with rule 88A as currently amended.',
  },
  {
    id: 'igst-remainder-goes-to-cgst-before-sgst',
    decided:
      'Where IGST credit remains after covering the IGST liability, it is applied to CGST ' +
      'before SGST — and the order is an input, `igstCreditPreference`, not a rule.',
    because:
      'Rule 88A leaves the order free, so any fixed order is a choice and not a rule. It ' +
      'is made an argument so that the choice is visible at the call site and a taxpayer ' +
      'who wants the other one is not arguing with the code.',
    alternative: "Apply it to SGST first — available as `igstCreditPreference: 'sgst-first'`.",
    settledBy: 'Nothing. Rule 88A genuinely leaves it open; this is a preference, not a rule.',
  },
  {
    id: 'rcm-credit-is-claimed-in-the-same-period',
    decided:
      'Credit on an inward reverse-charge supply is reported as available in 4(A)(3) in ' +
      'the same period the liability arises in 3.1(d).',
    because:
      'It is the ordinary case: the self-invoice, the payment and the claim happen in one ' +
      'cycle, and reporting the liability without the credit beside it would show a ' +
      'period paying tax it never recovers.',
    alternative:
      'Defer the credit to the following period, which is what the law requires where the ' +
      'tax has not actually been paid by the time the return is filed — a timing fact no ' +
      'document in this model records.',
    settledBy:
      'A record of when the reverse-charge tax was paid, which is a cash-ledger fact this ' +
      'product does not keep.',
  },
  {
    id: 'reverse-charge-tax-is-always-paid-in-cash',
    decided:
      'Tax on inward reverse-charge supplies is added to the cash payable and no input ' +
      'tax credit is set against it.',
    because:
      'Reverse-charge liability is discharged in cash; the credit for it becomes available ' +
      'only once it is paid, which is a later period’s figure and not this one’s.',
    alternative:
      'Offset it with available credit, understating the cash due and overstating the ' +
      'balance carried forward.',
    settledBy: 'Section 49(4) and the proviso on reverse-charge payment.',
  },
  {
    id: 'gstr1-rounds-nowhere',
    decided: 'No figure in GSTR-1 is rounded. Every one is an exact sum of 2dp document figures.',
    because:
      'GSTR-1 reports documents, and the customer holds a copy of every one of them. A ' +
      'rounded return figure would disagree with the invoice it came from, and the ' +
      'disagreement would be invisible until the customer’s GSTR-2B failed to match.',
    alternative: 'Round each section to the rupee, as GSTR-3B does.',
    settledBy: 'The numeric field definitions in the published GSTR-1 schema.',
  },
  {
    id: 'gstr3b-rounds-only-the-cash-payable',
    decided:
      'GSTR-3B is computed at 2dp throughout and rounded to the rupee at exactly one ' +
      'point: the cash payable, per component. The total payable is the sum of the ' +
      'ROUNDED components, never the rounded sum.',
    because:
      'Money leaves the bank in whole rupees, and the challan has to add up to the cells ' +
      'beside it. Rounding anything upstream would make 3.1 disagree with the same ' +
      'period’s GSTR-1 — which is this project’s own measured finding about rounding tax ' +
      'components separately, in a different costume.',
    alternative:
      'Round the total and let the components be whatever they were, which produces a ' +
      'return whose parts do not add to its own total.',
    settledBy: 'Whether the portal accepts paise in 3.1 and 4, which the schema states.',
  },
] as const

/** The notice every artefact carries, so a screen cannot render one without it. */
export const PROVISIONAL_NOTICE =
  'These figures are computed from your own documents and are correct to the paisa. The ' +
  'SHAPE of this return has not been checked against the portal’s published schema and ' +
  'has not been through a filing cycle — check it before you upload it.'
