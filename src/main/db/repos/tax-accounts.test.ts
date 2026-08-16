import { describe, expect, it } from 'vitest'
import type { TaxComponentDefinition } from '@main/regimes/types'
import { INPUT_TAX_PARENT, OUTPUT_TAX_PARENT, taxAccountsFor } from './tax-accounts'

const BOTH: TaxComponentDefinition[] = [
  { code: 'CGST', label: 'Central GST', levy: 'both' },
  { code: 'SGST', label: 'State GST', levy: 'both' },
]

function codes(accounts: { code: string }[]): string[] {
  return accounts.map((account) => account.code)
}

describe('taxAccountsFor', () => {
  it('makes two accounts per component', () => {
    expect(taxAccountsFor(BOTH)).toHaveLength(4)
  })

  /*
   * The rule this module exists to enforce. Tax charged on a sale is owed to the
   * government; tax paid on a purchase is reclaimable from it. Netting them into one
   * account would hide both figures behind their difference, and every return asks for
   * each separately.
   */
  it('puts output tax on the liability side and input tax on the asset side', () => {
    const accounts = taxAccountsFor(BOTH)

    const output = accounts.filter((account) => account.role?.startsWith('tax-output-'))
    const input = accounts.filter((account) => account.role?.startsWith('tax-input-'))

    expect(output.map((account) => account.type)).toEqual(['liability', 'liability'])
    expect(input.map((account) => account.type)).toEqual(['asset', 'asset'])
  })

  it('hangs each family under its own group', () => {
    const accounts = taxAccountsFor(BOTH)

    for (const account of accounts) {
      const expected = account.type === 'liability' ? OUTPUT_TAX_PARENT : INPUT_TAX_PARENT
      expect(account.parentCode).toBe(expected)
    }
  })

  it('never makes a group', () => {
    expect(taxAccountsFor(BOTH).every((account) => !account.isGroup)).toBe(true)
  })

  // ---- Roles ---------------------------------------------------------------

  it('maps a role built from the component code, lowercased', () => {
    const roles = taxAccountsFor(BOTH).map((account) => account.role)

    expect(roles).toContain('tax-output-cgst')
    expect(roles).toContain('tax-input-cgst')
    expect(roles).toContain('tax-output-sgst')
    expect(roles).toContain('tax-input-sgst')
  })

  it('gives every account a role, because nothing looks these up by code', () => {
    expect(taxAccountsFor(BOTH).every((account) => account.role !== undefined)).toBe(true)
  })

  it('gives every account a distinct role', () => {
    const roles = taxAccountsFor(BOTH).map((account) => account.role)
    expect(new Set(roles).size).toBe(roles.length)
  })

  // ---- Codes ---------------------------------------------------------------

  it('numbers each family from its own parent', () => {
    const accounts = taxAccountsFor(BOTH)

    expect(codes(accounts.filter((a) => a.type === 'asset'))).toEqual(['1510', '1520'])
    expect(codes(accounts.filter((a) => a.type === 'liability'))).toEqual(['2210', '2220'])
  })

  it('gives every account a distinct code', () => {
    const many = taxAccountsFor([
      ...BOTH,
      { code: 'UTGST', label: 'Union Territory GST', levy: 'both' },
      { code: 'IGST', label: 'Integrated GST', levy: 'both' },
    ])
    expect(new Set(codes(many)).size).toBe(many.length)
  })

  it('leaves room between the codes for one the user adds', () => {
    const [first, second] = codes(taxAccountsFor(BOTH).filter((a) => a.type === 'asset'))
    expect(Number(second) - Number(first)).toBeGreaterThan(1)
  })

  // ---- What each side is for ----------------------------------------------

  it('makes only a liability for an output-only component', () => {
    const accounts = taxAccountsFor([{ code: 'TAX', label: 'Sales Tax', levy: 'output' }])

    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.type).toBe('liability')
    expect(accounts[0]?.role).toBe('tax-output-tax')
  })

  it('makes only an asset for an input-only component', () => {
    const accounts = taxAccountsFor([{ code: 'TAX', label: 'Purchase Tax', levy: 'input' }])

    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.type).toBe('asset')
    expect(accounts[0]?.role).toBe('tax-input-tax')
  })

  // ---- Naming --------------------------------------------------------------

  it("uses the regime's own label rather than renaming it", () => {
    /* A component the regime calls 'Central GST' must not become something its user has
     * never seen on a return. */
    const names = taxAccountsFor(BOTH).map((account) => account.name)

    expect(names).toContain('Central GST Payable')
    expect(names).toContain('Central GST Recoverable')
  })

  it('says on each account what it is for', () => {
    const accounts = taxAccountsFor(BOTH)
    expect(accounts.every((account) => (account.description ?? '') !== '')).toBe(true)
  })

  // ---- Independence from any one regime -----------------------------------

  it('knows nothing about GST', () => {
    /* Read the source for CGST and you will not find it. A regime that levies one flat
     * tax gets exactly two accounts, named after what it calls that tax. */
    const accounts = taxAccountsFor([{ code: 'VAT', label: 'Value Added Tax', levy: 'both' }])

    expect(accounts.map((account) => account.name)).toEqual([
      'Value Added Tax Recoverable',
      'Value Added Tax Payable',
    ])
    expect(accounts.map((account) => account.role)).toEqual(['tax-input-vat', 'tax-output-vat'])
  })

  it('makes nothing for a regime that levies nothing', () => {
    expect(taxAccountsFor([])).toEqual([])
  })

  it('takes different parents when a template puts the groups elsewhere', () => {
    const accounts = taxAccountsFor(BOTH, { outputParentCode: '2500', inputParentCode: '1700' })

    expect(accounts.filter((a) => a.type === 'liability')[0]?.parentCode).toBe('2500')
    expect(accounts.filter((a) => a.type === 'asset')[0]?.parentCode).toBe('1700')
    expect(codes(accounts.filter((a) => a.type === 'asset'))).toEqual(['1710', '1720'])
  })

  it('groups the assets together and the liabilities together', () => {
    /* Interleaved by component, a chart reads as CGST-payable, CGST-recoverable,
     * SGST-payable … which puts a liability next to an asset on every other row. */
    const types = taxAccountsFor(BOTH).map((account) => account.type)
    expect(types).toEqual(['asset', 'asset', 'liability', 'liability'])
  })
})
