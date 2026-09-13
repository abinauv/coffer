/*
 * The stylesheet, inline, print-first.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A CONSTANT IN A TYPESCRIPT FILE AND NOT A `.css` BESIDE IT
 *
 * The template is a pure function that returns a string, so it may not read a file. A
 * `.css` next to it would have to be loaded — which is I/O, and would make the template
 * untestable without a filesystem and unusable from a worker with no cwd. It is also the
 * only way the document can be self-contained: a rendered invoice is handed to
 * `printToPDF` and, later, e-mailed. A stylesheet it has to fetch is a stylesheet that is
 * missing exactly when it matters.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE RECOVERY SHEET TAUGHT, WHICH IS THE ONLY OTHER PRINTED THING IN THE PRODUCT
 *
 * `screens.css`'s `@media print` block does three things and all three are here: it puts
 * black on white rather than trusting the theme, it drops every trace of application
 * chrome, and it marks the blocks that must not be split with `break-inside: avoid`. What
 * is different is that this document has no screen life to hide — it IS the artefact —
 * so the rules are unconditional rather than inside a media query, and `@media print`
 * carries only what genuinely differs when the page becomes paper.
 *
 * ---------------------------------------------------------------------------
 * MILLIMETRES FOR THE PAGE, POINTS FOR THE TYPE
 *
 * A4 is 210mm x 297mm, the margins below are in millimetres, and every column width is a
 * millimetre measurement of a physical piece of paper. Type is in points because that is
 * what type is measured in and because a font size in millimetres would still have to be
 * converted by the renderer.
 *
 * The description column has NO width. `table-layout: fixed` gives the sized columns
 * exactly what they ask for and hands the remainder to the one that asked for nothing,
 * so the table fits whether the tax splits into one column pair or two — which is the
 * difference between an IGST invoice and a CGST+SGST one, and is not knowable here.
 *
 * ---------------------------------------------------------------------------
 * THE THREE RULES THAT SURVIVE A FORTY-LINE INVOICE
 *
 *   thead { display: table-header-group }   the column headings repeat on every page.
 *                                           Without it page two is an unlabelled grid of
 *                                           figures, which is worse than no page two.
 *   tr { break-inside: avoid }              a line does not get its description on one
 *                                           page and its tax on the next.
 *   .block { break-inside: avoid }          the totals, the summaries, the bank details
 *                                           and the signature each move to the next page
 *                                           whole rather than being split across the
 *                                           fold. An orphaned grand total is the failure
 *                                           this is here to prevent.
 *
 * `print-color-adjust: exact` is not decoration either: the copy marking and the header
 * rules are printed in ink because they are what tell three identical sheets apart, and
 * browsers drop backgrounds when printing unless told not to.
 */

/** A4, and the margins the page is laid out inside. Millimetres, per the header. */
export const PAGE = {
  marginTopMm: 10,
  marginSideMm: 10,
  marginBottomMm: 12,
} as const

export const INVOICE_STYLES = `
@page {
  size: A4 portrait;
  margin: ${PAGE.marginTopMm}mm ${PAGE.marginSideMm}mm ${PAGE.marginBottomMm}mm;
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  background: #fff;
  color: #000;
  font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
  font-size: 8.5pt;
  line-height: 1.35;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.doc {
  width: 100%;
}

/* Figures are read down a column, so every digit is the same width and the column ends
 * where the decimal point does. A '1' narrower than a '7' makes a total look wrong. */
.figure {
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum' 1;
}

.muted {
  color: #444;
}

.small {
  font-size: 7.5pt;
}

.block {
  break-inside: avoid;
  page-break-inside: avoid;
}

/* ---- Masthead ------------------------------------------------------------ */

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 6mm;
  border-bottom: 0.6mm solid #000;
  padding-bottom: 3mm;
  margin-bottom: 3mm;
}

.head__mark {
  flex: 0 0 auto;
}

.head__title {
  flex: 1 1 auto;
  text-align: center;
}

.head__heading {
  margin: 0;
  font-size: 15pt;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.head__copy {
  margin-top: 1.5mm;
  font-size: 8pt;
  font-weight: 600;
  letter-spacing: 0.08em;
}

.head__status {
  margin-top: 1.5mm;
  display: inline-block;
  border: 0.4mm solid #000;
  padding: 0.6mm 2mm;
  font-size: 9pt;
  font-weight: 700;
  letter-spacing: 0.12em;
}

.head__meta {
  flex: 0 0 62mm;
  border-collapse: collapse;
  font-size: 8pt;
}

.head__meta th {
  text-align: left;
  font-weight: 400;
  color: #444;
  padding: 0.4mm 2mm 0.4mm 0;
  white-space: nowrap;
}

.head__meta td {
  text-align: right;
  font-weight: 600;
  padding: 0.4mm 0;
  font-variant-numeric: tabular-nums;
}

/* ---- The two ends of the supply ------------------------------------------ */

.parties {
  display: flex;
  gap: 0;
  border: 0.3mm solid #000;
}

.party {
  flex: 1 1 50%;
  padding: 2.5mm 3mm;
}

.party + .party {
  border-left: 0.3mm solid #000;
}

.party__role {
  font-size: 7pt;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #333;
  margin-bottom: 1mm;
}

.party__name {
  font-size: 10pt;
  font-weight: 700;
}

.party__legal {
  font-size: 7.5pt;
  color: #333;
}

.party__address {
  margin: 1mm 0 0;
  padding: 0;
  list-style: none;
}

.party__field {
  margin-top: 0.8mm;
}

.party__label {
  color: #444;
}

.supply {
  border: 0.3mm solid #000;
  border-top: 0;
  padding: 1.6mm 3mm;
  font-weight: 600;
}

.parties--last,
.supply {
  margin-bottom: 3mm;
}

/* ---- The lines ----------------------------------------------------------- */

.lines {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 7.5pt;
}

/* The heading rows repeat on every printed page. See the header. */
.lines thead {
  display: table-header-group;
}

.lines tbody tr,
.lines thead tr {
  break-inside: avoid;
  page-break-inside: avoid;
}

.lines th,
.lines td {
  border: 0.2mm solid #000;
  padding: 1.2mm 1.4mm;
  vertical-align: top;
}

.lines thead th {
  background: #eee;
  font-weight: 700;
  text-align: center;
  font-size: 7pt;
  letter-spacing: 0.02em;
}

/* A description is free text and may be a paragraph. It wraps rather than widening the
 * table or running under the next column. */
.lines__description {
  word-break: break-word;
  overflow-wrap: anywhere;
  hyphens: auto;
}

.lines__charge {
  font-style: italic;
}

.lines__charge-mark {
  font-style: normal;
  font-size: 6.5pt;
  letter-spacing: 0.06em;
  color: #333;
}

.lines__index {
  text-align: center;
}

.lines__code,
.lines__unit {
  text-align: center;
  font-variant-numeric: tabular-nums;
}

/* ---- Summaries and totals ------------------------------------------------ */

.summaries {
  display: flex;
  gap: 4mm;
  align-items: flex-start;
  margin-top: 3mm;
}

.summaries__left {
  flex: 1 1 auto;
  min-width: 0;
}

.summaries__right {
  flex: 0 0 78mm;
}

.grid {
  width: 100%;
  border-collapse: collapse;
  font-size: 7.5pt;
}

.grid caption {
  caption-side: top;
  text-align: left;
  font-size: 7pt;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding-bottom: 1mm;
}

.grid th,
.grid td {
  border: 0.2mm solid #000;
  padding: 1.1mm 1.4mm;
}

.grid thead th {
  background: #eee;
  text-align: center;
  font-size: 7pt;
}

.grid tfoot td,
.grid tfoot th {
  font-weight: 700;
  background: #f4f4f4;
}

.totals {
  width: 100%;
  border-collapse: collapse;
  font-size: 8.5pt;
}

.totals th {
  text-align: left;
  font-weight: 400;
  padding: 1.1mm 2mm 1.1mm 0;
}

.totals td {
  padding: 1.1mm 0;
}

.totals__grand th,
.totals__grand td {
  border-top: 0.5mm solid #000;
  border-bottom: 0.5mm solid #000;
  font-size: 10pt;
  font-weight: 700;
}

.words {
  margin-top: 3mm;
  border: 0.3mm solid #000;
  padding: 2mm 3mm;
}

.words__label {
  font-size: 7pt;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #333;
}

.words__value {
  font-weight: 600;
}

/* ---- The foot ------------------------------------------------------------ */

.foot {
  display: flex;
  gap: 4mm;
  margin-top: 3mm;
  align-items: stretch;
}

.foot__left {
  flex: 1 1 auto;
  min-width: 0;
}

.foot__right {
  flex: 0 0 62mm;
  border: 0.3mm solid #000;
  padding: 2.5mm 3mm;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  text-align: center;
}

.panel {
  border: 0.3mm solid #000;
  padding: 2.5mm 3mm;
}

.panel + .panel {
  margin-top: 2.5mm;
}

.panel__title {
  font-size: 7pt;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #333;
  margin-bottom: 1mm;
}

.panel__list {
  margin: 0;
  padding-left: 4mm;
}

.bank {
  border-collapse: collapse;
}

.bank th {
  text-align: left;
  font-weight: 400;
  color: #444;
  padding: 0.4mm 3mm 0.4mm 0;
  white-space: nowrap;
  vertical-align: top;
}

.bank td {
  padding: 0.4mm 0;
  font-weight: 600;
  word-break: break-word;
}

.sign__for {
  font-weight: 700;
}

.sign__space {
  min-height: 14mm;
}

.sign__caption {
  border-top: 0.3mm solid #000;
  padding-top: 1mm;
  font-size: 7.5pt;
}

.narration {
  margin-top: 3mm;
  font-size: 7.5pt;
}

.narration__label {
  font-weight: 700;
}

@media print {
  /* The theme is irrelevant on paper and a dark one would put white ink on white paper.
   * Stated rather than inherited, exactly as the recovery sheet states it. */
  html,
  body {
    background: #fff;
    color: #000;
  }
}
`
