/*
 * Printing a document: the half that decides what goes on the page.
 *
 * ---------------------------------------------------------------------------
 *  WHY THIS IS A SERVICE OF ITS OWN AND NOT A FACE OF `documents`
 * ---------------------------------------------------------------------------
 *
 * `DocumentsService` is where the regime is asked for tax — the one layer allowed to. It
 * writes to the books. Printing writes nothing, computes nothing and asks the regime
 * only how to spell a number, and it needs three things that service does not: the
 * company profile, the party, and a way to turn HTML into a page. Folding it in would
 * put a `BrowserWindow` in reach of the module that issues invoices.
 *
 * It also reads a document that is already taxed. Every figure on the page was decided
 * when the document was drafted and is stored on it, so nothing here recomputes anything
 * — `services/pdf` is pure and has no arithmetic in it beyond folding rows it was given.
 *
 * ---------------------------------------------------------------------------
 *  THE PAGE NEVER REACHES THE RENDERER
 * ---------------------------------------------------------------------------
 *
 * The HTML is built here, handed to the `PagePrinter` here, and dropped here. What goes
 * back over IPC is a PNG of page one, a file path, or nothing at all. An invoice is the
 * one artefact in this product that somebody outside the business reads, and markup that
 * crossed into an untrusted process could come back altered.
 *
 * ---------------------------------------------------------------------------
 *  WHAT IT REFUSES, AND WHY EACH REFUSAL IS BETTER THAN A DEFAULT
 * ---------------------------------------------------------------------------
 *
 *   no copies          A print of nothing is a mistake. Printing the original instead
 *                      would be this layer guessing at intent.
 *   a draft            A draft has no number. An unnumbered invoice that looks like an
 *                      invoice is the one document this product must not hand anybody,
 *                      because it cannot be told from a real one after it is on paper.
 *   no company profile Not refused here — `buildInvoicePrintModel` does it, before the
 *                      printer is touched, and says so in a sentence a user can act on.
 *                      It is also not reachable in practice: a document cannot be created
 *                      without a profile, because computing its tax needs a supplier.
 */

import type {
  PrintCopy,
  PrintDocumentInput,
  PrintInclude,
  PrintPreview,
  SavePdfResult,
} from '@shared/dto'

import { OpenBooks, type OpenCompanyHandle } from '../books/open-books'
import { getCompanyProfile } from '../db/repos/company-profile'
import { getDocument } from '../db/repos/documents'
import { RepoError } from '../db/repos/errors'
import { getParty } from '../db/repos/parties'
import { describeRegime } from '../regime/service'
import {
  type InvoiceCopy,
  PrintError,
  buildInvoicePrintModel,
  renderInvoiceRun,
} from '../services/pdf'
import { D } from '@main/domain/money'
import type { PagePrinter, PrintableFont } from './page-printer'

/** A rendered run: one HTML document holding every copy, and a name for the file. */
interface RenderedRun {
  readonly html: string
  readonly copyCount: number
  /** What to call the file the user is about to save. */
  readonly fileName: string
}

export class PrintingService {
  private readonly books: OpenBooks

  private readonly printer: PagePrinter

  /**
   * The heading font, read once.
   *
   * Reading it is I/O and `services/pdf` may not do any, so it is resolved here and
   * passed in — see `PrintableFont`. Null means it could not be found, and the page
   * falls back to whatever serif the machine has rather than failing to print.
   */
  private fontPromise: Promise<PrintableFont | null> | null = null

  constructor(companies: OpenCompanyHandle, printer: PagePrinter) {
    this.books = new OpenBooks(companies)
    this.printer = printer
  }

  /** A picture of page one. Writes nothing and prints nothing. */
  async renderPrint(input: PrintDocumentInput): Promise<PrintPreview> {
    const run = await this.render(input)
    const image = await this.printer.preview(run.html)
    return { ...image, copyCount: run.copyCount }
  }

  /** Render to PDF and ask where to put it. */
  async savePdf(input: PrintDocumentInput): Promise<SavePdfResult> {
    const run = await this.render(input)
    return { path: await this.printer.savePdf(run.html, run.fileName) }
  }

  /** Hand the page to the operating system's print dialog. */
  async print(input: PrintDocumentInput): Promise<void> {
    const run = await this.render(input)
    await this.printer.print(run.html)
  }

  // ---- The page -----------------------------------------------------------

  /**
   * One HTML document holding every copy asked for, from one model.
   *
   * THE MODEL IS BUILT ONCE. `copy` decides only the marking across the top, so three
   * copies of an invoice cannot disagree about a figure — building it per copy would be
   * three chances for the second one to differ from the first.
   *
   * ONE DOCUMENT, NOT THREE. Three documents are three print jobs and three files to
   * save. Each copy starts a new page inside this one, which is what "print all three"
   * means to the person holding the paper.
   */
  private async render(input: PrintDocumentInput): Promise<RenderedRun> {
    const copies = requireCopies(input.copies)
    const db = this.books.db()
    const regime = this.books.regime()

    const document = await getDocument(db, input.id)
    if (document === null) {
      throw new RepoError('DOCUMENT_NOT_FOUND', 'That document is not in these books.', {
        id: input.id,
      })
    }
    if (document.status === 'draft') {
      throw new PrintError(
        'DOCUMENT_NOT_ISSUED',
        'A draft has no number yet, and an unnumbered document that looks like an invoice ' +
          'cannot be told from a real one once it is on paper. Issue it, then print it.',
      )
    }

    const model = buildInvoicePrintModel({
      document,
      company: await getCompanyProfile(db),
      party: await getParty(db, document.partyId),
      regime: describeRegime(regime),
      amountInWords: (amount) => regime.amountInWords(D(amount)),
    })

    const font = await this.font()
    const html = renderInvoiceRun(model, copies, {
      ...includeOptions(input.include),
      ...(font === null ? {} : { headingFont: font }),
    })

    return {
      html,
      copyCount: copies.length,
      fileName: fileNameFor(model.number, document.kind),
    }
  }

  private font(): Promise<PrintableFont | null> {
    this.fontPromise ??= this.printer.headingFont()
    return this.fontPromise
  }
}

/** Constructed the way every other service is. */
export function createPrintingService(
  companies: OpenCompanyHandle,
  printer: PagePrinter,
): PrintingService {
  return new PrintingService(companies, printer)
}

// ---- Small, checkable pieces ------------------------------------------------

function noCopies(): PrintError {
  return new PrintError(
    'NO_COPIES_REQUESTED',
    'Choose at least one copy to print. Nothing was rendered.',
  )
}

/**
 * The copies asked for, deduplicated and put back into the rule's order.
 *
 * Order is not the caller's to choose: the three copies are a sequence in the rule that
 * names them, and a run that printed the triplicate first would be collated wrong by the
 * person at the printer, who is reading the markings and not the order they arrived in.
 */
export function requireCopies(copies: readonly PrintCopy[]): readonly InvoiceCopy[] {
  const wanted = new Set(copies)
  const ordered = COPY_ORDER.filter((copy) => wanted.has(copy))
  if (ordered.length === 0) throw noCopies()
  return ordered
}

const COPY_ORDER: readonly InvoiceCopy[] = ['original', 'duplicate', 'triplicate']

/**
 * The include flags, as the template's options.
 *
 * Both are omitted rather than passed as `true`, so that the template's own defaults stay
 * the single answer to "what does an invoice carry unless somebody said otherwise".
 */
function includeOptions(include: PrintInclude): { amountInWords?: false; hsnSummary?: false } {
  return {
    ...(include.amountInWords ? {} : { amountInWords: false as const }),
    ...(include.hsnSummary ? {} : { hsnSummary: false as const }),
  }
}

/**
 * What to call the saved file.
 *
 * The number first, because that is what somebody searching a downloads folder types. It
 * is reduced to characters every filesystem accepts — a series prefix is free text and a
 * user may well have chosen `SALES/2026-27/`.
 */
export function fileNameFor(number: string | null, kind: string): string {
  const stem = (number ?? kind)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return `${stem === '' ? 'document' : stem}.pdf`
}
