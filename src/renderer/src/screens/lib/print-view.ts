/*
 * What the print dialog says, kept out of the component so it can be read as sentences.
 *
 * The copy markings are the words the rule uses, in the case it uses them — the same
 * strings `COPY_MARKINGS` in src/main/services/pdf/model.ts prints across the top of each
 * sheet. They are repeated here rather than fetched because they are what the page says,
 * and a dialog offering "Duplicate" beside a sheet marked something else would be worse
 * than a round trip saved. A test holds the two together.
 */

import type { PrintCopy, PrintPreview } from '@shared/dto'

/** The three, in the order the rule lists them. Ticking order does not change it. */
export const PRINT_COPIES: readonly PrintCopy[] = ['original', 'duplicate', 'triplicate']

/** What each copy is called in the dialog, and what it will say on its face. */
export const COPY_LABELS: Readonly<Record<PrintCopy, { label: string; marking: string }>> = {
  original: { label: 'Original', marking: 'ORIGINAL FOR RECIPIENT' },
  duplicate: { label: 'Duplicate', marking: 'DUPLICATE FOR TRANSPORTER' },
  triplicate: { label: 'Triplicate', marking: 'TRIPLICATE FOR SUPPLIER' },
}

/**
 * The copies asked for, in the rule's order and without repeats.
 *
 * The same fold main does, run here so the dialog can enable its buttons from it and so
 * the preview request does not change when somebody ticks the boxes in another order.
 */
export function printableCopies(copies: readonly PrintCopy[]): readonly PrintCopy[] {
  const wanted = new Set(copies)
  return PRINT_COPIES.filter((copy) => wanted.has(copy))
}

/**
 * What to say under the preview.
 *
 * IT NEVER CALLS THE PREVIEW THE DOCUMENT. The image is page one of the first copy, and a
 * long invoice has more; saying "this is your invoice" under one sheet would be a promise
 * about pages nobody has seen. So it says which page this is and how many copies the run
 * will produce, and leaves the rest to the printer.
 */
export function previewNote(preview: PrintPreview | null): string {
  if (preview === null) return 'The preview appears once there is something to draw.'
  const copies =
    preview.copyCount === 1 ? 'One copy' : `${counted(preview.copyCount)} copies, one per sheet`
  return `${copies}. The preview is the first page; a longer document carries on past it.`
}

const WORDS = ['no', 'one', 'two', 'three'] as const

function counted(count: number): string {
  return WORDS[count] ?? String(count)
}
