import { describe, expect, it } from 'vitest'
import { D, equals, percentOf, roundMoney, sum } from '@main/domain/money'
import type {
  PlaceOfSupply,
  TaxableLine,
  TaxComponent,
  TaxComputationResult,
  TaxParty,
} from '@main/regimes/types'
import { computeTax, GST_COMPONENT_ORDER } from './tax'
import fixture from './__fixtures__/tax-splits.json'

interface TaxCase {
  name: string
  why: string
  supplier: string
  customer: string
  place: string
  date: string
  lines: TaxableLine[]
  expected: TaxComputationResult
}

const golden = fixture as unknown as {
  parties: Record<string, TaxParty>
  places: Record<string, PlaceOfSupply>
  cases: TaxCase[]
}

function partyNamed(name: string): TaxParty {
  const party = golden.parties[name]
  if (party === undefined) {
    throw new Error(`No fixture party '${name}'.`)
  }
  return party
}

function placeNamed(name: string): PlaceOfSupply {
  const place = golden.places[name]
  if (place === undefined) {
    throw new Error(`No fixture place '${name}'.`)
  }
  return place
}

function runCase(entry: TaxCase): TaxComputationResult {
  return computeTax({
    supplier: partyNamed(entry.supplier),
    customer: partyNamed(entry.customer),
    placeOfSupply: placeNamed(entry.place),
    lines: entry.lines,
    date: entry.date,
  })
}

describe('computeTax — golden cases', () => {
  for (const entry of golden.cases) {
    it(`${entry.name} — ${entry.why}`, () => {
      expect(runCase(entry)).toEqual(entry.expected)
    })
  }

  it('covers the whole set', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(14)
  })
})

describe('the invariants every case has to satisfy', () => {
  const results = golden.cases.map((entry) => ({ entry, result: runCase(entry) }))

  it('a line’s components sum to its total tax, exactly', () => {
    for (const { entry, result } of results) {
      for (const line of result.lines) {
        const componentTotal = sum(line.components.map((component) => component.amount))
        expect(
          equals(componentTotal, line.totalTax),
          `${entry.name}/${line.lineId}: components ${componentTotal.toString()} vs total ${line.totalTax}`,
        ).toBe(true)
      }
    }
  })

  it('the document total is the sum of the line totals', () => {
    for (const { entry, result } of results) {
      const lineTotal = sum(result.lines.map((line) => line.totalTax))
      expect(equals(lineTotal, result.totalTax), entry.name).toBe(true)
    }
  })

  it('the summary sums to the same document total', () => {
    for (const { entry, result } of results) {
      const summaryTotal = sum(result.summary.map((component) => component.amount))
      expect(equals(summaryTotal, result.totalTax), entry.name).toBe(true)
    }
  })

  it('never charges CGST and IGST on the same line', () => {
    for (const { entry, result } of results) {
      for (const line of result.lines) {
        const codes = new Set(line.components.map((component) => component.code))
        expect(
          codes.has('IGST') && (codes.has('CGST') || codes.has('SGST') || codes.has('UTGST')),
          `${entry.name}/${line.lineId}`,
        ).toBe(false)
      }
    }
  })

  it('an intra-state line has exactly two components, an inter-state line exactly one', () => {
    for (const { entry, result } of results) {
      const place = placeNamed(entry.place)
      for (const line of result.lines) {
        if (line.components.length === 0) {
          continue
        }
        expect(line.components.length, `${entry.name}/${line.lineId}`).toBe(
          place.isIntraJurisdiction ? 2 : 1,
        )
      }
    }
  })

  it('emits only component codes this regime declares', () => {
    for (const { result } of results) {
      for (const component of [
        ...result.lines.flatMap((line) => line.components),
        ...result.summary,
      ]) {
        expect(GST_COMPONENT_ORDER).toContain(component.code)
      }
    }
  })

  it('every amount is a 2dp decimal string, never a number', () => {
    for (const { result } of results) {
      const amounts = [
        result.totalTax,
        ...result.lines.flatMap((line) => [
          line.taxableAmount,
          line.totalTax,
          ...line.components.map((component) => component.amount),
        ]),
        ...result.summary.map((component) => component.amount),
      ]
      for (const amount of amounts) {
        expect(typeof amount).toBe('string')
        expect(amount).toMatch(/^-?\d+\.\d{2}$/)
      }
    }
  })
})

const withinTamilNadu = placeNamed('withinTamilNadu')
const toKarnataka = placeNamed('tamilNaduToKarnataka')
const supplier = partyNamed('tamilNaduSupplier')
const customer = partyNamed('tamilNaduCustomer')

function taxOne(
  place: PlaceOfSupply,
  taxableAmount: string,
  ratePct: string,
  isCharge?: boolean,
): TaxComputationResult {
  return computeTax({
    supplier,
    customer,
    placeOfSupply: place,
    lines: [{ lineId: 'L1', taxableAmount, ratePct, classificationCode: null, isCharge }],
    date: '2026-08-14',
  })
}

describe('the split never changes what the tax comes to', () => {
  /* The property the whole rounding arrangement exists to protect: a supply's tax is a
   * function of its base and its rate, not of which side of a state line it landed on. */
  const bases = [
    '0.01',
    '0.05',
    '1.00',
    '10.10',
    '99.99',
    '100.05',
    '333.33',
    '999.99',
    '1234.56',
    '12345.67',
    '999999.99',
    '12345678.90',
  ]
  const rates = ['0.25', '1.5', '3', '5', '12', '18', '28', '40']

  it('holds for every base and rate', () => {
    for (const taxableAmount of bases) {
      for (const ratePct of rates) {
        const intra = taxOne(withinTamilNadu, taxableAmount, ratePct)
        const inter = taxOne(toKarnataka, taxableAmount, ratePct)
        expect(intra.totalTax, `${taxableAmount} @ ${ratePct}%`).toBe(inter.totalTax)

        /* And both equal the rate applied once, rounded once. */
        const expected = roundMoney(percentOf(taxableAmount, ratePct)).toFixed(2)
        expect(intra.totalTax, `${taxableAmount} @ ${ratePct}%`).toBe(expected)
      }
    }
  })

  it('and the two halves always add back up', () => {
    for (const taxableAmount of bases) {
      for (const ratePct of rates) {
        const intra = taxOne(withinTamilNadu, taxableAmount, ratePct)
        const line = intra.lines[0]
        expect(line).toBeDefined()
        const components = line?.components ?? []
        expect(sum(components.map((component) => component.amount)).toFixed(2)).toBe(line?.totalTax)
      }
    }
  })
})

describe('isCharge says what a line is, not whether it is taxed', () => {
  it('a charge at 18% is taxed exactly like goods at 18%', () => {
    const goods = taxOne(withinTamilNadu, '500.00', '18', false)
    const charge = taxOne(withinTamilNadu, '500.00', '18', true)
    const unflagged = taxOne(withinTamilNadu, '500.00', '18')
    expect(charge).toEqual(goods)
    expect(charge).toEqual(unflagged)
  })

  it('a charge is untaxed only because the caller set its rate to zero', () => {
    /* The reference project hardcoded "freight is never taxed" inside the tax function.
     * Here the same outcome is reachable, but only as a decision the user made. */
    const untaxed = taxOne(withinTamilNadu, '500.00', '0', true)
    expect(untaxed.totalTax).toBe('0.00')
    expect(untaxed.lines[0]?.components).toEqual([])

    const taxed = taxOne(withinTamilNadu, '500.00', '18', true)
    expect(taxed.totalTax).toBe('90.00')
  })
})

describe('the summary', () => {
  it('groups by code and rate, and orders CGST, SGST, UTGST, IGST', () => {
    const result = computeTax({
      supplier,
      customer,
      placeOfSupply: withinTamilNadu,
      lines: [
        { lineId: 'a', taxableAmount: '100.00', ratePct: '18', classificationCode: null },
        { lineId: 'b', taxableAmount: '100.00', ratePct: '5', classificationCode: null },
        { lineId: 'c', taxableAmount: '100.00', ratePct: '18', classificationCode: null },
        { lineId: 'd', taxableAmount: '100.00', ratePct: '12', classificationCode: null },
      ],
      date: '2026-08-14',
    })

    expect(result.summary.map((component: TaxComponent) => component.label)).toEqual([
      'CGST @ 2.5%',
      'CGST @ 6%',
      'CGST @ 9%',
      'SGST @ 2.5%',
      'SGST @ 6%',
      'SGST @ 9%',
    ])
    expect(result.summary.map((component: TaxComponent) => component.amount)).toEqual([
      '2.50',
      '6.00',
      '18.00',
      '2.50',
      '6.00',
      '18.00',
    ])
    expect(result.totalTax).toBe('53.00')
  })

  it('does not collapse two rates of the same tax into one row', () => {
    const result = computeTax({
      supplier,
      customer,
      placeOfSupply: toKarnataka,
      lines: [
        { lineId: 'a', taxableAmount: '1000.00', ratePct: '18', classificationCode: null },
        { lineId: 'b', taxableAmount: '1000.00', ratePct: '5', classificationCode: null },
      ],
      date: '2026-08-14',
    })
    expect(result.summary).toHaveLength(2)
    expect(result.summary.every((component) => component.code === 'IGST')).toBe(true)
  })
})

describe('inputs it refuses', () => {
  it('rejects a taxable amount carrying more than paise', () => {
    /* A third decimal in a money field means something upstream wrote at the wrong
     * scale. Rounding it here would hide that until the totals stopped reconciling. */
    expect(() => taxOne(withinTamilNadu, '100.005', '18')).toThrow()
  })

  it('rejects a rate that is not an exact decimal', () => {
    expect(() => taxOne(withinTamilNadu, '100.00', '18%')).toThrow()
  })

  it('rejects a document date that is not a date', () => {
    expect(() =>
      computeTax({
        supplier,
        customer,
        placeOfSupply: withinTamilNadu,
        lines: [],
        date: '14-08-2026',
      }),
    ).toThrow()
  })
})

describe('what the caller gets back', () => {
  it('returns lines in the order they were given, keyed by the caller’s own ids', () => {
    const result = computeTax({
      supplier,
      customer,
      placeOfSupply: withinTamilNadu,
      lines: [
        { lineId: 'zebra', taxableAmount: '10.00', ratePct: '18', classificationCode: null },
        { lineId: 'apple', taxableAmount: '20.00', ratePct: '18', classificationCode: null },
      ],
      date: '2026-08-14',
    })
    expect(result.lines.map((line) => line.lineId)).toEqual(['zebra', 'apple'])
  })

  it('normalises the taxable amount it echoes back to money scale', () => {
    const result = taxOne(withinTamilNadu, '10', '18')
    expect(result.lines[0]?.taxableAmount).toBe('10.00')
  })

  it('agrees with the sum of a hand-computed pair of halves at a whole-paisa rate', () => {
    /* Where the arithmetic is exact, allocation must not perturb it. */
    const result = taxOne(withinTamilNadu, '1000.00', '18')
    const half = percentOf('1000.00', '9')
    expect(result.lines[0]?.components.map((component) => component.amount)).toEqual([
      half.toFixed(2),
      half.toFixed(2),
    ])
    expect(D(result.totalTax).toFixed(2)).toBe(half.times(2).toFixed(2))
  })
})
