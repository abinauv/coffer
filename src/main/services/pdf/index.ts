/*
 * Printing a trade document. Import from here, not from the individual files.
 *
 * THE SECOND THING IN `services/` (ARCHITECTURE §5, which names `pdf` first in the list),
 * and, like the CSV importer beside it, THE WHOLE MODULE IS PURE. Nothing here opens a
 * file, imports `electron`, touches a DOM or reads a clock. A document goes in and an
 * HTML string comes out, which leaves the I/O decision — which window renders it, where
 * the PDF is written, and which paths a user may be persuaded to write to — with the
 * caller, where the answer can be enforced once.
 *
 * README.md promises "PDFs that look professional" and for most Indian small businesses
 * the invoice IS the product: it is the artefact the customer receives. This is the half
 * of that promise which can be written, tested and pinned against a fixture without an
 * Electron window in the room. `printToPDF` and the IPC channel come at a later gate.
 *
 * The pipeline, and what each half refuses to decide for you:
 *
 *   buildInvoicePrintModel   Document + profile + party + regime -> a print model.
 *                            Everything that is true of what we STORE lives here,
 *                            including the four blocks the company profile cannot hold
 *                            yet. Folds the two tax summaries.
 *   renderInvoiceHtml        a print model -> one copy of one document, as HTML.
 *                            Computes nothing, escapes everything, reads the heading off
 *                            the kind table and takes its number format from the regime.
 *
 * The seam between them is `InvoicePrintModel`. It exists so that the migration adding a
 * logo, bank details, terms and a signatory changes the mapper and leaves the template
 * alone — see the header of `model.ts`.
 */

export { renderInvoiceCopies, renderInvoiceHtml, headingFor } from './invoice-template'
export { INVOICE_STYLES, PAGE } from './invoice-styles'

export { buildInvoicePrintModel, hsnSummaryOf, rateSummaryOf, taxColumnsFor } from './invoice-model'
export type { InvoiceBranding, InvoicePrintSources } from './invoice-model'

export { COPY_MARKINGS, INVOICE_COPIES } from './model'
export type {
  InvoiceCopy,
  InvoicePrintModel,
  InvoiceRenderOptions,
  PrintBankDetails,
  PrintCorrectedDocument,
  PrintHsnRow,
  PrintImage,
  PrintLine,
  PrintParty,
  PrintRateSlab,
  PrintSignatory,
  PrintTax,
  PrintTaxColumn,
  PrintTotals,
} from './model'

export {
  formatAmount,
  formatPrintDate,
  formatQuantity,
  formatRate,
  groupDigits,
  isFormattableDecimal,
  isZeroAmount,
} from './format'

export { escapeHtml, html, lines, raw, toHtmlString, Html } from './escape'
export type { HtmlValue } from './escape'

export { PrintError, isPrintError } from './errors'
export type { PrintErrorCode } from './errors'
