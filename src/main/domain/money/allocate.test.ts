import { describe, expect, it } from 'vitest'
import { allocate, allocateByWeights } from './allocate'
import { sum } from './arithmetic'
import { D, MoneyError } from './decimal'
import { roundAt, scaleOf, type RoundingPoint } from './scale'
import fixture from './__fixtures__/allocation.json'

interface AllocationCase {
  name: string
  total: string
  parts?: number
  weights?: string[]
  point?: RoundingPoint
  expected: string[]
  why?: string
}

interface RejectedCase {
  total: string
  parts?: number
  weights?: string[]
  point?: RoundingPoint
  why: string
}

const golden = fixture as unknown as { cases: AllocationCase[]; rejected: RejectedCase[] }

function run(entry: AllocationCase | RejectedCase): ReturnType<typeof allocate> {
  const options = entry.point === undefined ? {} : { point: entry.point }
  if (entry.weights !== undefined) {
    return allocateByWeights(entry.total, entry.weights, options)
  }
  if (entry.parts === undefined) {
    throw new Error('fixture case needs either parts or weights')
  }
  return allocate(entry.total, entry.parts, options)
}

describe('allocation — golden cases', () => {
  for (const entry of golden.cases) {
    const point: RoundingPoint = entry.point ?? 'allocationUnit'

    it(`${entry.name}: ${entry.total} -> [${entry.expected.join(', ')}]`, () => {
      const shares = run(entry).map((share) => share.toFixed(scaleOf(point)))
      expect(shares).toEqual(entry.expected)
    })

    it(`${entry.name}: the shares sum back to the total exactly`, () => {
      const shares = run(entry)
      expect(sum(shares).equals(roundAt(point, entry.total))).toBe(true)
    })

    it(`${entry.name}: every share is at the target scale`, () => {
      for (const share of run(entry)) {
        expect(share.decimalPlaces()).toBeLessThanOrEqual(scaleOf(point))
      }
    })
  }
})

describe('allocation — what it refuses', () => {
  for (const entry of golden.rejected) {
    const label =
      entry.parts === undefined
        ? `weights ${JSON.stringify(entry.weights)}`
        : `${String(entry.parts)} parts`
    it(`${label} — ${entry.why}`, () => {
      expect(() => run(entry)).toThrow(MoneyError)
    })
  }
})

describe('allocation — properties that must hold for any input', () => {
  const totals = ['0.01', '0.07', '100.00', '-100.00', '1234.56', '0.00', '999999.99', '-0.03']
  const partCounts = [1, 2, 3, 4, 5, 6, 7, 11, 13, 97]

  it('never loses or invents a unit, for any total and any number of parts', () => {
    for (const total of totals) {
      for (const parts of partCounts) {
        const shares = allocate(total, parts)
        expect(shares).toHaveLength(parts)
        expect(sum(shares).toFixed(2), `${total} / ${String(parts)}`).toBe(D(total).toFixed(2))
      }
    }
  })

  it('gives no two parts shares more than one unit apart when splitting evenly', () => {
    for (const total of totals) {
      for (const parts of partCounts) {
        const shares = allocate(total, parts)
        const values = shares.map((share) => share.toNumber())
        const spread = Math.max(...values) - Math.min(...values)
        expect(spread, `${total} / ${String(parts)}`).toBeLessThanOrEqual(0.010000001)
      }
    }
  })

  it('is deterministic — the same split twice is the same split', () => {
    const first = allocateByWeights('1000.00', ['3', '2', '1'])
    const second = allocateByWeights('1000.00', ['3', '2', '1'])
    expect(first.map((share) => share.toFixed(2))).toEqual(second.map((share) => share.toFixed(2)))
  })

  it('a negative total is the exact mirror of the positive one', () => {
    for (const parts of partCounts) {
      const positive = allocate('100.00', parts).map((share) => share.toFixed(2))
      const negative = allocate('-100.00', parts).map((share) => share.negated().toFixed(2))
      expect(negative, `${String(parts)} parts`).toEqual(positive)
    }
  })

  it('weighting by equal weights is the same as splitting evenly', () => {
    const evenly = allocate('100.00', 3).map((share) => share.toFixed(2))
    const weighted = allocateByWeights('100.00', ['1', '1', '1']).map((share) => share.toFixed(2))
    expect(weighted).toEqual(evenly)
  })

  it('scaling every weight by the same factor changes nothing', () => {
    const plain = allocateByWeights('1000.00', ['3', '2', '1']).map((share) => share.toFixed(2))
    const scaled = allocateByWeights('1000.00', ['300', '200', '100']).map((share) =>
      share.toFixed(2),
    )
    expect(scaled).toEqual(plain)
  })
})

describe('allocate — argument checking', () => {
  it('rejects a fractional or absurd part count', () => {
    expect(() => allocate('100.00', 2.5)).toThrow(MoneyError)
    expect(() => allocate('100.00', Number.NaN)).toThrow(MoneyError)
    expect(() => allocate('100.00', Number.POSITIVE_INFINITY)).toThrow(MoneyError)
  })

  it('rejects a float total', () => {
    expect(() => allocate(100.5, 3)).toThrow(MoneyError)
  })

  it('splits into one part by returning the whole total', () => {
    expect(allocate('100.00', 1).map((share) => share.toFixed(2))).toEqual(['100.00'])
  })
})
