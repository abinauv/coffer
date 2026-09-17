/*
 * The invoice template: a print model in, an HTML document out.
 *
 * ---------------------------------------------------------------------------
 * A PURE FUNCTION, AND EVERY WORD OF THAT IS LOAD-BEARING
 *
 * No I/O, no `electron`, no DOM, no clock and no randomness. A string in and a string
 * out, so the same model renders the same bytes on every machine for ever. That is what
 * makes a golden fixture possible at all: a template that reached for `new Date()` to
 * stamp "printed on" would produce a different document every day and could only be
 * tested against itself.
 *
 * The Electron side — `printToPDF`, the IPC channel, a window to render in — is a later
 * batch behind a contract gate. Nothing here knows it exists.
 *
 * ---------------------------------------------------------------------------
 * THE TEMPLATE COMPUTES NOTHING
 *
 * CONVENTIONS §1.7 says the renderer never computes money, and this is the same rule one
 * layer over. Every figure printed below is a decimal string taken off the model and
 * handed to a formatter, which rearranges characters and never parses. No total is
 * summed here, no line is extended, no tax is added up, and no sign is flipped. There is
 * a test that hands this function a model whose totals deliberately disagree with its own
 * lines and asserts that what prints is the model's total — a test that can only pass
 * while this rule holds.
 *
 * ---------------------------------------------------------------------------
 * THE HEADING IS READ OFF THE KIND TABLE, NEVER TYPED
 *
 * `definitionOf(model.kind).label`. A credit note prints "Credit note" because the table
 * says so, and there is no string in this file that could put "Tax Invoice" on one. This
 * project has repeatedly found that writing a label out by hand is how the wrong word
 * reaches a user's paperwork — `settlesLabel` in the renderer exists because of it — and
 * the test for this iterates `DOCUMENT_KINDS` rather than listing the kinds again, so a
 * sixth kind is covered the day it is added.
 *
 * ---------------------------------------------------------------------------
 * EVERY VALUE IS ESCAPED, BY CONSTRUCTION
 *
 * Not by discipline. `html` is a tagged template that escapes every interpolation, and
 * the only way past it is to say `raw(...)`, which appears in this file exactly twice —
 * for the stylesheet and for the doctype. A party called `Sharma & Sons <Pvt> Ltd` prints
 * as itself; a narration with a quote in it does not close an attribute. See escape.ts.
 */

import { definitionOf } from '@shared/documents'
import type { DocumentStatusDto } from '@shared/dto'

import { html, lines, raw, toHtmlString, type Html } from './escape'
import { formatAmount, formatPrintDate, formatQuantity, formatRate, isZeroAmount } from './format'
import { INVOICE_STYLES } from './invoice-styles'
import {
  COPY_MARKINGS,
  type InvoiceCopy,
  type InvoicePrintModel,
  type InvoiceRenderOptions,
  type PrintFontFace,
  type PrintBankDetails,
  type PrintImage,
  type PrintParty,
  type PrintSignatory,
  type PrintTax,
} from './model'

/**
 * What each status stamps on the face of the document.
 *
 * A TOTAL RECORD over the status union, per CONVENTIONS §1.9, and null is an answer: an
 * issued document is the ordinary case and carries no stamp. Written as a conditional it
 * would be right for as long as there were three statuses, and would silently give a
 * fourth whatever the last branch said.
 */
const STATUS_MARKS: Readonly<Record<DocumentStatusDto, string | null>> = {
  draft: 'DRAFT — NOT ISSUED',
  issued: null,
  cancelled: 'CANCELLED',
}

/**
 * Column widths, in millimetres, for the columns that get one.
 *
 * The description column is absent on purpose — see the stylesheet's header. Everything
 * here is a measurement of paper: A4 less the page margins is 190mm, and these plus the
 * tax pairs have to leave the description something to live in.
 */
const COLUMN_MM = {
  index: 6,
  classification: 14,
  quantity: 18,
  unitPrice: 18,
  discount: 14,
  taxable: 20,
  taxRate: 10,
  taxAmount: 18,
} as const

function widthCol(millimetres: number): Html {
  return html`<col style="width: ${millimetres}mm" />`
}

function image(picture: PrintImage | undefined): Html | null {
  if (picture === undefined) return null
  return html`<img
    src="${picture.source}"
    alt="${picture.alt}"
    style="width: ${picture.widthMm}mm; height: auto"
  />`
}

// ---- The masthead -----------------------------------------------------------

function metaRow(label: string, value: Html | string | null): Html | null {
  if (value === null) return null
  return html`<tr>
    <th>${label}</th>
    <td>${value}</td>
  </tr>`
}

function masthead(model: InvoicePrintModel, copy: InvoiceCopy): Html {
  const definition = definitionOf(model.kind)
  const mark = STATUS_MARKS[model.status]

  return html`<header class="head">
    <div class="head__mark">${image(model.logo)}</div>
    <div class="head__title">
      <h1 class="head__heading">${definition.label}</h1>
      <div class="head__copy">${COPY_MARKINGS[copy]}</div>
      ${mark === null ? null : html`<div class="head__status">${mark}</div>`}
    </div>
    <table class="head__meta">
      <tbody>
        ${lines([
          metaRow('Number', model.number ?? '—'),
          metaRow('Date', formatPrintDate(model.date)),
          model.dueDate === null ? null : metaRow('Due', formatPrintDate(model.dueDate)),
          model.reference === null ? null : metaRow(model.reference.label, model.reference.value),
          model.corrects === undefined
            ? null
            : metaRow(
                `Against ${model.corrects.label.toLowerCase()}`,
                html`${model.corrects.number} · ${formatPrintDate(model.corrects.date)}`,
              ),
        ])}
      </tbody>
    </table>
  </header>`
}

// ---- The two ends of the supply --------------------------------------------

function partyField(label: string, value: string | null): Html | null {
  if (value === null || value === '') return null
  return html`<div class="party__field">
    <span class="party__label">${label}:</span> <strong>${value}</strong>
  </div>`
}

function partyBox(role: string, party: PrintParty, registrationLabel: string): Html {
  return html`<div class="party">
    <div class="party__role">${role}</div>
    <div class="party__name">${party.name}</div>
    ${party.legalName === null ? null : html`<div class="party__legal">${party.legalName}</div>`}
    <ul class="party__address">
      ${lines(party.addressLines.map((line) => html`<li>${line}</li>`))}
    </ul>
    ${lines([
      partyField(registrationLabel, party.registrationNumber),
      partyField('State', party.jurisdiction),
      partyField('Email', party.email),
      partyField('Phone', party.phone),
    ])}
  </div>`
}

// ---- The line table ---------------------------------------------------------

/**
 * A line's amount for one tax column, looked up by code.
 *
 * `filter` and a length check rather than `find`, because "the CGST on this line" is a
 * rule that says ONE and `find` silently implements "whichever the regime listed first".
 * A line carrying a component twice is a bug upstream, and printing the first of the two
 * would hide it behind a plausible-looking figure. CONVENTIONS §1.9's corollary.
 */
function taxOn(taxes: readonly PrintTax[], code: string): PrintTax | null {
  const matches = taxes.filter((tax) => tax.code === code)
  const [only, ...rest] = matches
  if (only === undefined || rest.length > 0) return null
  return only
}

function lineTable(model: InvoicePrintModel): Html {
  const { numberFormat: format, taxColumns } = model
  const hasTaxColumns = taxColumns.length > 0

  const columns = lines([
    widthCol(COLUMN_MM.index),
    raw('<col />'),
    widthCol(COLUMN_MM.classification),
    widthCol(COLUMN_MM.quantity),
    widthCol(COLUMN_MM.unitPrice),
    widthCol(COLUMN_MM.discount),
    widthCol(COLUMN_MM.taxable),
    taxColumns.map(() => lines([widthCol(COLUMN_MM.taxRate), widthCol(COLUMN_MM.taxAmount)])),
  ])

  /*
   * TWO HEADING ROWS WHEN THERE IS TAX AND ONE WHEN THERE IS NOT, rather than one shape
   * with an empty second row. A `rowspan="2"` over a row that has no cells is a layout
   * whose behaviour differs between engines, and a nil-rated invoice — an exempt supply,
   * a bill of supply — is an ordinary document rather than an edge case.
   */
  const span = hasTaxColumns ? raw(' rowspan="2"') : raw('')
  const heading = lines([
    html`<tr>
      <th${span}>#</th>
      <th${span}>Description</th>
      <th${span}>${model.classificationLabel}</th>
      <th${span}>Qty</th>
      <th${span}>Rate</th>
      <th${span}>Discount</th>
      <th${span}>Taxable value</th>
      ${taxColumns.map((column) => html`<th colspan="2">${column.label}</th>`)}
    </tr>`,
    hasTaxColumns &&
      html`<tr>
        ${taxColumns.map(
          () =>
            html`<th>%</th>
              <th>Amount</th>`,
        )}
      </tr>`,
  ])

  const body = model.lines.map((line) => {
    const quantity = [
      formatQuantity(line.quantity, format),
      line.unitCode === null ? null : ` ${line.unitCode}`,
    ]
    return html`<tr>
      <td class="lines__index">${line.lineNumber}</td>
      <td class="lines__description${line.isCharge ? ' lines__charge' : ''}">
        ${line.description}${
          line.isCharge ? html` <span class="lines__charge-mark">(charge)</span>` : null
        }
      </td>
      <td class="lines__code">${line.classificationCode ?? ''}</td>
      <td class="figure">${quantity}</td>
      <td class="figure">${formatAmount(line.unitPrice, format)}</td>
      <td class="figure">${formatAmount(line.discount, format)}</td>
      <td class="figure">${formatAmount(line.taxableAmount, format)}</td>
      ${taxColumns.map((column) => {
        const tax = taxOn(line.taxes, column.code)
        return html`<td class="figure">${tax === null ? '' : formatRate(tax.ratePct)}</td>
          <td class="figure">${tax === null ? '' : formatAmount(tax.amount, format)}</td>`
      })}
    </tr>`
  })

  return html`<table class="lines">
    <colgroup>
      ${columns}
    </colgroup>
    <thead>
      ${heading}
    </thead>
    <tbody>
      ${lines(body)}
    </tbody>
  </table>`
}

// ---- The summaries ----------------------------------------------------------

function taxCells(
  taxes: readonly PrintTax[],
  columns: readonly { code: string }[],
  format: InvoicePrintModel['numberFormat'],
): Html {
  return lines(
    columns.map((column) => {
      const tax = taxOn(taxes, column.code)
      return html`<td class="figure">${tax === null ? '' : formatRate(tax.ratePct)}</td>
        <td class="figure">${tax === null ? '' : formatAmount(tax.amount, format)}</td>`
    }),
  )
}

function rateSummary(model: InvoicePrintModel): Html | null {
  if (model.rateSummary.length === 0) return null
  const { numberFormat: format, taxColumns } = model

  return html`<table class="grid block">
    <caption>
      Tax by rate
    </caption>
    <thead>
      <tr>
        <th rowspan="2">Rate</th>
        <th rowspan="2">Taxable value</th>
        ${taxColumns.map((column) => html`<th colspan="2">${column.label}</th>`)}
        <th rowspan="2">Total tax</th>
      </tr>
      <tr>
        ${taxColumns.map(
          () =>
            html`<th>%</th>
              <th>Amount</th>`,
        )}
      </tr>
    </thead>
    <tbody>
      ${lines(
        model.rateSummary.map(
          (slab) =>
            html`<tr>
              <td class="figure">${formatRate(slab.ratePct)}</td>
              <td class="figure">${formatAmount(slab.taxableValue, format)}</td>
              ${taxCells(slab.taxes, taxColumns, format)}
              <td class="figure">${formatAmount(slab.totalTax, format)}</td>
            </tr>`,
        ),
      )}
    </tbody>
  </table>`
}

function hsnSummary(model: InvoicePrintModel): Html | null {
  if (model.hsnSummary.length === 0) return null
  const { numberFormat: format, taxColumns } = model

  return html`<table class="grid block">
    <caption>
      ${model.classificationLabel} summary
    </caption>
    <thead>
      <tr>
        <th rowspan="2">${model.classificationLabel}</th>
        <th rowspan="2">Qty</th>
        <th rowspan="2">Rate</th>
        <th rowspan="2">Taxable value</th>
        ${taxColumns.map((column) => html`<th colspan="2">${column.label}</th>`)}
        <th rowspan="2">Total tax</th>
      </tr>
      <tr>
        ${taxColumns.map(
          () =>
            html`<th>%</th>
              <th>Amount</th>`,
        )}
      </tr>
    </thead>
    <tbody>
      ${lines(
        model.hsnSummary.map(
          (row) =>
            html`<tr>
              <td class="lines__code">${row.classificationCode ?? '—'}</td>
              <td class="figure">
                ${formatQuantity(row.quantity, format)}${
                  row.unitCode === null ? null : ` ${row.unitCode}`
                }
              </td>
              <td class="figure">${formatRate(row.ratePct)}</td>
              <td class="figure">${formatAmount(row.taxableValue, format)}</td>
              ${taxCells(row.taxes, taxColumns, format)}
              <td class="figure">${formatAmount(row.totalTax, format)}</td>
            </tr>`,
        ),
      )}
    </tbody>
  </table>`
}

// ---- The totals -------------------------------------------------------------

function totalsRow(label: Html | string, value: string): Html {
  return html`<tr>
    <th>${label}</th>
    <td class="figure">${value}</td>
  </tr>`
}

function totalsTable(model: InvoicePrintModel): Html {
  const { numberFormat: format, totals } = model

  return html`<table class="totals">
    <tbody>
      ${lines([
        totalsRow('Taxable value', formatAmount(totals.taxableValue, format)),
        /*
         * "Less discount", with the figure exactly as main sent it. CONVENTIONS §1.7's
         * corollary: where a figure is SUBTRACTED to reach a total beside it, the heading
         * carries the sign and the figure keeps the one it arrived with. Negating it here
         * would be arithmetic, and a document that negates in one place and not another
         * ends up contradicting itself.
         */
        isZeroAmount(totals.totalDiscount)
          ? null
          : totalsRow('Less discount', formatAmount(totals.totalDiscount, format)),
        totals.taxes.map((tax) => totalsRow(tax.label, formatAmount(tax.amount, format))),
        isZeroAmount(totals.roundOff)
          ? null
          : lines([
              totalsRow('Net total', formatAmount(totals.netTotal, format)),
              totalsRow('Round off', formatAmount(totals.roundOff, format)),
            ]),
        html`<tr class="totals__grand">
          <th>Grand total (${format.currencyCode})</th>
          <td class="figure">
            ${format.currencySymbol} ${formatAmount(totals.grandTotal, format)}
          </td>
        </tr>`,
      ])}
    </tbody>
  </table>`
}

// ---- The foot ---------------------------------------------------------------

function bankRow(label: string, value: string | null): Html | null {
  if (value === null || value === '') return null
  return html`<tr>
    <th>${label}</th>
    <td>${value}</td>
  </tr>`
}

function bankPanel(bank: PrintBankDetails | undefined): Html | null {
  if (bank === undefined) return null

  const rows = lines([
    bankRow('Account name', bank.accountName),
    bankRow('Bank', bank.bankName),
    bankRow('Branch', bank.branch),
    bankRow('Account no.', bank.accountNumber),
    bank.routingCode === null ? null : bankRow(bank.routingCode.label, bank.routingCode.value),
    bankRow('SWIFT', bank.swiftCode),
    bankRow('UPI', bank.upiId),
  ])

  return html`<section class="panel block">
    <div class="panel__title">Payment</div>
    <table class="bank">
      <tbody>
        ${rows}
      </tbody>
    </table>
    ${image(bank.paymentQr)}
  </section>`
}

function termsPanel(terms: readonly string[] | undefined): Html | null {
  if (terms === undefined || terms.length === 0) return null
  return html`<section class="panel block">
    <div class="panel__title">Terms</div>
    <ol class="panel__list">
      ${lines(terms.map((term) => html`<li>${term}</li>`))}
    </ol>
  </section>`
}

function declarationPanel(declaration: string | undefined): Html | null {
  if (declaration === undefined || declaration === '') return null
  return html`<section class="panel block">
    <div class="panel__title">Declaration</div>
    <div>${declaration}</div>
  </section>`
}

function signatureBlock(signatory: PrintSignatory | undefined): Html {
  return html`<div class="foot__right block">
    <div class="sign__for">${signatory === undefined ? null : signatory.forLine}</div>
    <div class="sign__space">${signatory === undefined ? null : image(signatory.image)}</div>
    <div class="sign__caption">
      ${
        signatory === undefined || signatory.name === null
          ? null
          : html`<div><strong>${signatory.name}</strong></div>`
      }
      ${
        signatory === undefined || signatory.designation === null
          ? null
          : html`<div>${signatory.designation}</div>`
      }
      <div>Authorised signatory</div>
    </div>
  </div>`
}

// ---- The document -----------------------------------------------------------

/**
 * One printed copy of one document.
 *
 * `copy` decides only the marking across the top — the same model renders all three, so
 * two copies of one invoice cannot disagree about a figure.
 */
export function renderInvoiceHtml(
  model: InvoicePrintModel,
  options: InvoiceRenderOptions = {},
): string {
  return wrapInDocument(model, [invoiceBody(model, options)], options)
}

/** One copy's markup, without the document around it. */
function invoiceBody(model: InvoicePrintModel, options: InvoiceRenderOptions): Html {
  const copy = options.copy ?? 'original'
  /* Both blocks are on unless the caller said otherwise — see `InvoiceRenderOptions`. */
  const withWords = options.amountInWords ?? true
  const withHsn = options.hsnSummary ?? true

  return html`<div class="doc">
    ${masthead(model, copy)}
    <div class="parties">
      ${partyBox('Supplier', model.supplier, model.registrationLabel)}
      ${partyBox('Recipient', model.customer, model.registrationLabel)}
    </div>
    ${
      model.placeOfSupply === null
        ? null
        : html`<div class="supply">Place of supply: ${model.placeOfSupply}</div>`
    }
    ${lineTable(model)}
    <div class="summaries">
      <div class="summaries__left">${rateSummary(model)}</div>
      <div class="summaries__right block">${totalsTable(model)}</div>
    </div>
    ${withHsn ? hsnSummary(model) : null}
    ${
      withWords
        ? html`<section class="words block">
            <span class="words__label">Amount in words</span>
            <div class="words__value">${model.totals.grandTotalInWords}</div>
          </section>`
        : null
    }
    <div class="foot">
      <div class="foot__left">
        ${bankPanel(model.bank)} ${termsPanel(model.terms)} ${declarationPanel(model.declaration)}
      </div>
      ${signatureBlock(model.signatory)}
    </div>
    ${
      model.narration === null || model.narration === ''
        ? null
        : html`<div class="narration">
            <span class="narration__label">Note:</span> ${model.narration}
          </div>`
    }
  </div>`
}

/**
 * The document around one or more copies.
 *
 * The two `raw` calls in this module, both on constants declared here. The doctype is
 * markup by definition and the stylesheet is CSS; neither has ever been near a user's
 * keyboard. Everything else on the page went through `html`.
 */
function wrapInDocument(
  model: InvoicePrintModel,
  bodies: readonly Html[],
  options: InvoiceRenderOptions,
): string {
  const definition = definitionOf(model.kind)
  const title = `${definition.label} ${model.number ?? ''}`.trim()

  return toHtmlString(
    html`${raw('<!doctype html>')}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>${title}</title>
          <style>
            ${fontFace(options.headingFont)}${raw(INVOICE_STYLES)}
          </style>
        </head>
        <body>
          ${lines(bodies)}
        </body>
      </html> `,
  )
}

/**
 * The `@font-face` for the heading font, when the caller supplied one.
 *
 * The one place in this module where a value that did not come from `html` reaches the
 * page, and it is guarded rather than trusted: the source must be a `data:` URI for a
 * font and the family must be plain letters, so nothing here can close the declaration
 * and start a new one. A value that fails either check is dropped, and the page falls
 * back to the machine's serif — see `InvoiceRenderOptions.headingFont`.
 */
function fontFace(font: PrintFontFace | undefined): Html | null {
  if (font === undefined) return null
  if (!/^[A-Za-z0-9 ]{1,64}$/.test(font.family)) return null
  if (!/^data:font\/woff2;base64,[A-Za-z0-9+/=]+$/.test(font.source)) return null
  return raw(
    `@font-face{font-family:'${font.family}';src:url(${font.source}) format('woff2');` +
      `font-weight:600;font-style:normal;font-display:block;}` +
      `h1,h2,h3,.masthead__title,.copy-mark{font-family:'${font.family}',Georgia,` +
      `'Times New Roman',serif;}`,
  )
}

/**
 * Every copy of one document, in the order the rule lists them.
 *
 * Offered because "print all three" is what a goods invoice actually needs, and doing it
 * by hand at three call sites is three chances to render the original twice.
 */
export function renderInvoiceCopies(
  model: InvoicePrintModel,
  copies: readonly InvoiceCopy[],
): readonly { copy: InvoiceCopy; html: string }[] {
  return copies.map((copy) => ({ copy, html: renderInvoiceHtml(model, { copy }) }))
}

/**
 * Every copy in ONE document, each starting a new page.
 *
 * THIS IS WHAT PRINTING ACTUALLY WANTS, and `renderInvoiceCopies` above is not: three
 * separate documents are three print jobs and three PDFs, so a user who asked for all
 * three copies would get three files to save and three trips to the printer dialog. One
 * document is one job, one file, three sheets — which is what "print all three" means to
 * the person holding the paper.
 *
 * The model is built once and rendered N times, so the copies cannot disagree about a
 * figure; `.doc + .doc` in the stylesheet is what puts each after the last.
 *
 * @throws Error when `copies` is empty. A document of no pages is a caller's mistake, and
 *         the printing service refuses an empty list long before this.
 */
export function renderInvoiceRun(
  model: InvoicePrintModel,
  copies: readonly InvoiceCopy[],
  options: Omit<InvoiceRenderOptions, 'copy'> = {},
): string {
  if (copies.length === 0) {
    throw new Error('renderInvoiceRun needs at least one copy to render.')
  }
  const bodies = copies.map((copy) => invoiceBody(model, { ...options, copy }))
  return wrapInDocument(model, bodies, options)
}

/** Re-exported so a caller can offer a heading without importing the kind table twice. */
export function headingFor(model: InvoicePrintModel): string {
  return definitionOf(model.kind).label
}
