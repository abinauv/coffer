/*
 * The `regime` group's boundary.
 *
 * One method that takes nothing, so there is exactly one rule to prove: arguments the
 * renderer sends are DROPPED rather than forwarded. `parseArgs` is handed whatever came
 * across the wire, and a handler that let it through would give an untrusted process a
 * say in a call that is supposed to have no inputs — today that is harmless because
 * `describe()` ignores its parameters, and it stops being harmless the first time
 * somebody adds one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RegimeDescription } from '../../../shared/dto'
import { createRegimeHandlers, type RegimeService } from './regime'

const DESCRIPTION: RegimeDescription = {
  id: 'in',
  label: 'India — GST',
  registrationLabel: 'GSTIN / UIN',
  numberFormat: {
    groupSizes: [3, 2],
    decimalSeparator: '.',
    groupSeparator: ',',
    currencyCode: 'INR',
    currencySymbol: '₹',
  },
  jurisdictions: [{ code: '33', name: 'Tamil Nadu' }],
  taxRates: [{ ratePct: '18', label: '18%', note: 'The main slab.' }],
  taxComponents: [{ code: 'CGST', label: 'Central GST', levy: 'both' }],
  classification: { code: 'HSN', label: 'HSN / SAC', validLengths: [4, 6, 8] },
}

let service: RegimeService
let handlers: ReturnType<typeof createRegimeHandlers>

beforeEach(() => {
  service = { describe: vi.fn(async () => DESCRIPTION) }
  handlers = createRegimeHandlers(service)
})

describe('describe', () => {
  it('takes no arguments and ignores any that arrive', () => {
    expect(handlers.describe.parseArgs([])).toEqual([])
    expect(handlers.describe.parseArgs(['in', { spoof: true }])).toEqual([])
  })

  it('wraps what the service answers', async () => {
    await expect(handlers.describe.handle()).resolves.toEqual({ ok: true, data: DESCRIPTION })
    expect(service.describe).toHaveBeenCalledTimes(1)
    expect(service.describe).toHaveBeenCalledWith()
  })

  /*
   * There is no `describe(regimeId)`, and this is what says so. A screen may not ask
   * about a regime other than the one its books were opened under — the alternative is a
   * rate picker built from one country's schedules over an invoice taxed by another's.
   */
  it('never asks the service about a regime the caller named', async () => {
    await handlers.describe.handle(...(handlers.describe.parseArgs(['pt']) as []))

    expect(service.describe).toHaveBeenCalledWith()
  })
})
