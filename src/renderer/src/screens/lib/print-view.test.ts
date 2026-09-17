import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PrintPreview } from '@shared/dto'
import { COPY_LABELS, PRINT_COPIES, previewNote, printableCopies } from './print-view'

const preview = (over: Partial<PrintPreview> = {}): PrintPreview => ({
  imageDataUri: 'data:image/png;base64,iVBORw0KGgo=',
  widthPx: 794,
  heightPx: 1123,
  copyCount: 1,
  ...over,
})

describe('the copies', () => {
  it('offers exactly the three the rule names', () => {
    expect(PRINT_COPIES).toEqual(['original', 'duplicate', 'triplicate'])
  })

  /*
   * THE DIALOG'S HINTS ARE WHAT THE SHEET WILL SAY. `COPY_MARKINGS` in
   * src/main/services/pdf/model.ts prints them across the top of each page, and a dialog
   * offering "Duplicate" beside a sheet marked something else would be worse than the
   * round trip this repetition saves. Read out of the source rather than restated.
   */
  it('names each copy the way the printed sheet will', () => {
    const source = readFileSync(resolve('src/main/services/pdf/model.ts'), 'utf8')
    const block = /COPY_MARKINGS[\s\S]*?\{([\s\S]*?)\}/.exec(source)?.[1] ?? ''

    for (const copy of PRINT_COPIES) {
      expect(block).toContain(`${copy}: '${COPY_LABELS[copy].marking}'`)
    }
  })
})

describe('folding the ticked boxes', () => {
  /* Order is the rule's, not the order somebody happened to tick them in. */
  it('puts them back into the rule order', () => {
    expect(printableCopies(['triplicate', 'original'])).toEqual(['original', 'triplicate'])
  })

  it('folds a repeat into one', () => {
    expect(printableCopies(['original', 'original', 'duplicate'])).toEqual([
      'original',
      'duplicate',
    ])
  })

  it('answers nothing for nothing, so the buttons can be disabled from it', () => {
    expect(printableCopies([])).toEqual([])
  })
})

describe('what the note under the preview says', () => {
  /*
   * IT NEVER CALLS THE PREVIEW THE DOCUMENT. The image is page one; a long invoice has
   * more, and saying "this is your invoice" under one sheet would be a promise about
   * pages nobody has seen.
   */
  it('says which page this is', () => {
    expect(previewNote(preview())).toContain('the first page')
    expect(previewNote(preview())).not.toMatch(/this is your|the whole|complete/i)
  })

  it('counts the copies the run will produce', () => {
    expect(previewNote(preview({ copyCount: 1 }))).toContain('One copy')
    expect(previewNote(preview({ copyCount: 3 }))).toContain('three copies, one per sheet')
  })

  it('says what it is waiting for when there is nothing to draw', () => {
    expect(previewNote(null)).toBe('The preview appears once there is something to draw.')
  })
})
