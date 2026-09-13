/*
 * The `numbering` group's boundary.
 *
 * Same subject as ./parties.test.ts: the renderer is untrusted, so what is tested is what
 * happens to malformed input, and that a rejection never echoes the value back.
 *
 * THE KIND IS THE ONE PLACE THIS LAYER IS MORE THAN SHAPE, and it is pinned here to the
 * domain's own table rather than to a list written out in the test. `numberedKindDefinition`
 * throws a plain `Error` for a kind it does not know — a programmer error, from the
 * domain's point of view, which reaches a user as an internal error naming nothing — so
 * the boundary refuses it first and names the field. A copy of the nine kinds in the
 * handler, or in this file, would be a copy nobody keeps in step (CONVENTIONS §1.9), which
 * is why the assertion below is an equality against `NUMBERED_KINDS` itself.
 *
 * `fiscalYearLabel` IS PRESENT-BUT-NULLABLE, which is the distinction with teeth in this
 * file. Null means "this document is in no fiscal year" and is a real answer; absent means
 * a screen forgot, and letting it through as the same null previews a number that collides
 * with last year's.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NUMBERED_KINDS } from '../../domain/documents'
import type { NumberingReset } from '../../../shared/dto'
import { IpcError } from '../errors'
import { createNumberingHandlers, type NumberingService } from './numbering'

let service: NumberingService
let handlers: ReturnType<typeof createNumberingHandlers>

beforeEach(() => {
  service = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
    create: vi.fn(async () => ({}) as never),
    update: vi.fn(async () => ({}) as never),
    archive: vi.fn(async () => ({}) as never),
    delete: vi.fn(async () => undefined),
    preview: vi.fn(async () => ({}) as never),
    seedDefaults: vi.fn(async () => 0),
  }
  handlers = createNumberingHandlers(service)
})

const parse = (method: keyof typeof handlers, ...raw: unknown[]): unknown[] =>
  handlers[method].parseArgs(raw)

const first = (method: keyof typeof handlers, ...raw: unknown[]): Record<string, unknown> =>
  parse(method, ...raw)[0] as Record<string, unknown>

const rejects = (method: keyof typeof handlers, ...raw: unknown[]) => {
  expect(() => parse(method, ...raw)).toThrow(IpcError)
}

const minimal = { kind: 'sales-invoice', label: 'Main' }

describe('the kinds a series may be created for', () => {
  /*
   * Equality against the domain's table, in its order, rather than nine strings written
   * here. The handler derives its list from the two kind tables in src/shared and the
   * domain composes `NUMBERED_KINDS` from the same two — so this is what proves the two
   * derivations agree, and it fails the day one of them stops being total.
   */
  it('accepts exactly what the domain says can be numbered', () => {
    const kinds = NUMBERED_KINDS.map((definition) => definition.kind)

    expect(kinds.map((kind) => first('create', { ...minimal, kind })['kind'])).toEqual(kinds)
    expect(kinds).toHaveLength(9)
  })

  /* The two 0015 added. They are the reason `seedDefaults` exists, so a contract that
   * could not name them would leave the repair with nothing to repair. */
  it('accepts the refund kinds by name', () => {
    expect(first('create', { ...minimal, kind: 'refund' })['kind']).toBe('refund')
    expect(first('create', { ...minimal, kind: 'refund-received' })['kind']).toBe('refund-received')
  })

  it('refuses a kind that is not one', () => {
    rejects('create', { ...minimal, kind: 'delivery-note' })
    rejects('create', { ...minimal, kind: 'journal' })
    rejects('create', { ...minimal, kind: '' })
    rejects('create', { ...minimal, kind: 7 })
    rejects('list', { kind: 'delivery-note' })
  })

  /* The refusal names the field and lists what was allowed, which is a fixed part of the
   * contract rather than anything the user typed. */
  it('says which field was wrong', () => {
    expect(() => parse('create', { ...minimal, kind: 'delivery-note' })).toThrow(/'kind'/)
  })
})

describe('list', () => {
  it('treats a missing argument as no filter', () => {
    expect(parse('list')).toEqual([{}])
    expect(parse('list', null)).toEqual([{}])
  })

  it('narrows the filters it is given', () => {
    expect(parse('list', { includeArchived: true, kind: 'receipt' })).toEqual([
      { includeArchived: true, kind: 'receipt' },
    ])
    rejects('list', { includeArchived: 'yes' })
  })
})

describe('create', () => {
  it('narrows a series', () => {
    expect(
      first('create', {
        ...minimal,
        prefix: 'INV',
        suffix: '',
        separator: '/',
        includeFiscalYear: true,
        width: 4,
        resetOn: 'fiscal-year',
        isDefault: true,
      }),
    ).toEqual({
      kind: 'sales-invoice',
      label: 'Main',
      prefix: 'INV',
      suffix: '',
      separator: '/',
      includeFiscalYear: true,
      width: 4,
      resetOn: 'fiscal-year',
      isDefault: true,
    })
  })

  it('needs a kind and a label', () => {
    rejects('create', { kind: 'sales-invoice' })
    rejects('create', { label: 'Main' })
    rejects('create', { ...minimal, label: '' })
    rejects('create', { ...minimal, label: 'x'.repeat(101) })
  })

  it('refuses anything that is not an object', () => {
    rejects('create', 'sales-invoice')
    rejects('create', [minimal])
    rejects('create', undefined)
  })

  /*
   * A space is a legitimate separator and a prefix ending in one is somebody's existing
   * format. Trimming here would quietly change the number a business has been printing
   * for years, which is the one thing this whole table being data exists to prevent.
   */
  it('does not trim a prefix or a separator', () => {
    const parsed = first('create', { ...minimal, prefix: 'INV ', separator: ' ' })
    expect(parsed['prefix']).toBe('INV ')
    expect(parsed['separator']).toBe(' ')
  })

  /* Zero is padding off, which is a real series. Twelve is the ceiling 0007 CHECKs. */
  it('bounds the width to what 0007 allows', () => {
    expect(first('create', { ...minimal, width: 0 })['width']).toBe(0)
    expect(first('create', { ...minimal, width: 12 })['width']).toBe(12)
    rejects('create', { ...minimal, width: 13 })
    rejects('create', { ...minimal, width: -1 })
    rejects('create', { ...minimal, width: 4.5 })
    rejects('create', { ...minimal, width: '4' })
  })

  it('does not default the width, the reset or the default flag', () => {
    const parsed = first('create', minimal)
    expect(parsed['width']).toBeUndefined()
    expect(parsed['resetOn']).toBeUndefined()
    expect(parsed['isDefault']).toBeUndefined()
  })

  it('accepts exactly the resets the contract declares', () => {
    const resets: NumberingReset[] = ['fiscal-year', 'never']
    for (const resetOn of resets) {
      expect(first('create', { ...minimal, resetOn })['resetOn']).toBe(resetOn)
    }
    rejects('create', { ...minimal, resetOn: 'monthly' })
  })
})

describe('update', () => {
  it('needs an id', () => {
    rejects('update', { label: 'Main' })
    rejects('update', { id: '' })
    rejects('update', { id: 42 })
  })

  /*
   * A settings screen posts the whole record back, so the shape fields are all parsed.
   * Whether changing one is allowed at all is `SERIES_IN_USE`, a sentence naming the
   * series — collapsing it here would say "malformed" to somebody whose input was merely
   * too late.
   */
  it('takes the shape fields and leaves the refusal to the repository', () => {
    expect(first('update', { id: 's1', prefix: 'INV2', width: 6, resetOn: 'never' })).toEqual({
      id: 's1',
      label: undefined,
      prefix: 'INV2',
      suffix: undefined,
      separator: undefined,
      includeFiscalYear: undefined,
      width: 6,
      resetOn: 'never',
      isDefault: undefined,
      isArchived: undefined,
    })
  })

  /* There is no `kind` on an update, and there never will be: moving a series would
   * renumber what it has already issued. A caller that sends one has it dropped rather
   * than obeyed. */
  it('drops a kind rather than moving the series', () => {
    expect(first('update', { id: 's1', kind: 'quotation' })['kind']).toBeUndefined()
  })

  it('refuses to clear the label', () => {
    rejects('update', { id: 's1', label: null })
    rejects('update', { id: 's1', label: '' })
  })
})

describe('preview', () => {
  it('narrows a preview', () => {
    expect(parse('preview', { seriesId: 's1', fiscalYearLabel: '2026-27' })).toEqual([
      { seriesId: 's1', fiscalYearLabel: '2026-27' },
    ])
  })

  /*
   * Null is a real answer — a series that neither prints the year nor resets on it is in
   * no fiscal year — and the repository is what refuses it for a series that does need
   * one, with `FISCAL_YEAR_REQUIRED` and a sentence saying which series.
   */
  it('takes a null year as a real answer', () => {
    expect(
      first('preview', { seriesId: 's1', fiscalYearLabel: null })['fiscalYearLabel'],
    ).toBeNull()
  })

  /*
   * ABSENT IS NOT NULL, and this is the assertion that separates them. A screen that
   * forgot the year must be refused rather than quietly previewed as "no year", which
   * would show a number that collides with last year's — exactly what including the year
   * exists to prevent.
   */
  it('refuses a year that was never sent', () => {
    rejects('preview', { seriesId: 's1' })
    expect(() => parse('preview', { seriesId: 's1' })).toThrow(/'fiscalYearLabel'/)
  })

  it('needs a series id', () => {
    rejects('preview', { fiscalYearLabel: '2026-27' })
    rejects('preview', { seriesId: '', fiscalYearLabel: null })
  })

  /* The shape of a label is the regime's — '2026-27' in India, '2026' where the year is
   * the calendar one — so this layer bounds it and looks no further. */
  it('bounds the year label without judging its shape', () => {
    expect(first('preview', { seriesId: 's1', fiscalYearLabel: '2026' })['fiscalYearLabel']).toBe(
      '2026',
    )
    rejects('preview', { seriesId: 's1', fiscalYearLabel: '' })
    rejects('preview', { seriesId: 's1', fiscalYearLabel: 'x'.repeat(33) })
    rejects('preview', { seriesId: 's1', fiscalYearLabel: 2026 })
  })
})

describe('seedDefaults', () => {
  /* Nothing for a caller to get wrong is the point of a repair: it takes no arguments,
   * and anything the renderer sent is ignored rather than refused. */
  it('takes no arguments and ignores anything sent', () => {
    expect(parse('seedDefaults')).toEqual([])
    expect(parse('seedDefaults', { kind: 'refund' }, 'and more')).toEqual([])
  })

  it('answers how many were created', async () => {
    service.seedDefaults = vi.fn(async () => 2)
    handlers = createNumberingHandlers(service)

    expect(await handlers.seedDefaults.handle()).toEqual({ ok: true, data: 2 })
  })

  /* Zero is the ordinary answer on books that are already complete, and it is a success
   * rather than a failure — a screen saying "nothing to repair" needs the envelope to say
   * `ok`. */
  it('reports creating nothing as a success', async () => {
    expect(await handlers.seedDefaults.handle()).toEqual({ ok: true, data: 0 })
  })
})

describe('archive and delete', () => {
  it('narrows an archive', () => {
    expect(parse('archive', { id: 's1', archived: true })).toEqual([{ id: 's1', archived: true }])
    expect(parse('archive', { id: 's1', archived: false })).toEqual([{ id: 's1', archived: false }])
  })

  it('will not guess which way to archive', () => {
    rejects('archive', { id: 's1' })
    rejects('archive', { id: 's1', archived: 'yes' })
  })

  it('takes an id for get and delete', () => {
    expect(parse('get', 's1')).toEqual(['s1'])
    expect(parse('delete', 's1')).toEqual(['s1'])
    rejects('get', '')
    rejects('delete', 42)
  })
})

describe('the envelope', () => {
  it('wraps what the service returns', async () => {
    expect(await handlers.list.handle({})).toEqual({ ok: true, data: [] })
    expect(await handlers.get.handle('s1')).toEqual({ ok: true, data: null })
  })

  it('wraps a delete that returns nothing', async () => {
    expect(await handlers.delete.handle('s1')).toEqual({ ok: true, data: undefined })
    expect(service.delete).toHaveBeenCalledWith('s1')
  })

  it('hands the service exactly what was parsed', async () => {
    await handlers.preview.handle({ seriesId: 's1', fiscalYearLabel: null })
    expect(service.preview).toHaveBeenCalledWith({ seriesId: 's1', fiscalYearLabel: null })
  })
})

describe('nothing malformed reaches the service', () => {
  it('refuses every method by name and calls nothing', () => {
    rejects('list', 'everything')
    rejects('get', null)
    rejects('create', { kind: 'delivery-note', label: 'Main' })
    rejects('update', {})
    rejects('archive', { id: 's1', archived: null })
    rejects('delete', {})
    rejects('preview', { seriesId: 's1' })

    expect(service.list).not.toHaveBeenCalled()
    expect(service.get).not.toHaveBeenCalled()
    expect(service.create).not.toHaveBeenCalled()
    expect(service.update).not.toHaveBeenCalled()
    expect(service.archive).not.toHaveBeenCalled()
    expect(service.delete).not.toHaveBeenCalled()
    expect(service.preview).not.toHaveBeenCalled()
  })

  it('never echoes the value it rejected', () => {
    const label = 'Branch series for Coimbatore and everything around it'.repeat(3)
    expect(() => parse('create', { ...minimal, label })).toThrow(/'label'/)
    expect(() => parse('create', { ...minimal, label })).not.toThrow(/Coimbatore/)
  })
})
