/*
 * The invoice register's vocabulary and its one arithmetic-free rule.
 *
 * Split out of Invoices.tsx for the reason every `screens/lib` module is: what can be
 * tested as a function should be, so the component test is left asserting what is on the
 * page rather than re-deriving what should be.
 *
 * Nothing here touches money. A document's total arrives formatted from main and the
 * register prints it — see the note at the top of Invoices.tsx about why there is no
 * total for the page.
 */

import type { BadgeTone } from '@renderer/components/atoms'
import type { DocumentStatusDto } from '@shared/dto'

/**
 * The kind this register lists, fixed rather than filtered.
 *
 * `documents` is one table for five kinds and a quotation is issuable today. A register
 * that mixed one into a list of invoices would invite reading it as a sales figure.
 */
export const INVOICE_KIND = 'sales-invoice'

/**
 * Rows drawn per page.
 *
 * The repository caps a page at `MAX_DOCUMENT_PAGE` (500) whatever it is asked for, so a
 * register that did not page would show the first page of a busy year and look complete.
 * 50 is what fits a screen without scrolling past the toolbar.
 */
export const PAGE_SIZE = 50

const STATUS_LABELS: Readonly<Record<DocumentStatusDto, string>> = {
  draft: 'Draft',
  issued: 'Issued',
  cancelled: 'Cancelled',
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status as DocumentStatusDto] ?? status
}

/**
 * The badge a status wears.
 *
 * CANCELLED IS NOT A WARNING, AND NOTHING HERE IS. It is a settled, deliberate state —
 * the document was issued, the entry was reversed, and the number was kept so the series
 * has no hole. Colouring it as a problem would put a red mark against the one action a
 * user takes to correct a mistake properly, and make a register look alarming for having
 * been kept well. So it recedes to neutral, issued reads as the settled normal, and the
 * accent goes on the draft — the only row on the page with something still to do.
 *
 * Typed as `BadgeTone` rather than as a union written out here, so a tone the atom does
 * not have cannot be returned. `periodStatusTone` next door returns `'info'`, which is
 * not one — it has no caller yet, and it will not compile against a `Badge` when it gets
 * one.
 */
export function statusTone(status: string): BadgeTone {
  if (status === 'issued') return 'positive'
  if (status === 'draft') return 'accent'
  return 'neutral'
}

/** The status buttons, in the order a register is scanned. `''` is no filter. */
export function statusFilters(): ReadonlyArray<{ value: DocumentStatusDto | ''; label: string }> {
  return [
    { value: '', label: 'All' },
    { value: 'draft', label: 'Drafts' },
    { value: 'issued', label: 'Issued' },
    { value: 'cancelled', label: 'Cancelled' },
  ]
}
