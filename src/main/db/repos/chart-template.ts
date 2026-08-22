/*
 * The starting chart of accounts.
 *
 * A new company opens to a usable set of books rather than an empty list. Somebody
 * running a one-person business is not going to design a chart of accounts before
 * raising their first invoice, and an empty chart makes the first invoice impossible.
 *
 * REGIME-NEUTRAL, DELIBERATELY. There is no CGST account here, and no GST anywhere.
 * `Duties and Taxes` is a group, and the per-component accounts under it are added when
 * the company's tax regime is known — one account per component, mapped to the role
 * name `taxRoleName()` builds. Naming them here would put a country's tax vocabulary
 * into the general ledger, which is the seam ARCHITECTURE §6.2 exists to protect.
 *
 * The codes follow the convention Indian practice shares with most of the world —
 * 1000s assets, 2000s liabilities, 3000s equity, 4000s income, 5000s and 6000s expenses
 * — because a user who has seen a chart of accounts before should recognise this one,
 * and one who has not should find that the numbers group things sensibly.
 *
 * NONE OF THIS IS FIXED. Every account here can be renamed, renumbered, archived or
 * removed. It is a starting point, not a schema; the roles are what the software
 * actually depends on, and they can be pointed anywhere.
 */

import type { AccountRole, AccountType } from '@main/domain/ledger'
import type { TaxAccountRole } from './accounts'

export interface TemplateAccount {
  code: string
  name: string
  type: AccountType
  /** Parent's code. Null at the root. The parent must appear earlier in the list. */
  parentCode: string | null
  isGroup: boolean
  /**
   * The semantic slot this account fills, where it fills one.
   *
   * `TaxAccountRole` as well as `AccountRole` because a tax component's role is built
   * from the regime's own component code and cannot be a member of a fixed union — see
   * `taxRoleName`. The template itself never sets one; the rows come from
   * `taxAccountsFor`, which the template knows nothing about.
   */
  role?: AccountRole | TaxAccountRole
  description?: string
}

export interface ChartTemplate {
  id: string
  label: string
  description: string
  accounts: readonly TemplateAccount[]
}

const group = (
  code: string,
  name: string,
  type: AccountType,
  parentCode: string | null = null,
): TemplateAccount => ({ code, name, type, parentCode, isGroup: true })

const leaf = (
  code: string,
  name: string,
  type: AccountType,
  parentCode: string,
  role?: AccountRole,
  description?: string,
): TemplateAccount => ({ code, name, type, parentCode, isGroup: false, role, description })

/**
 * A general small-business chart. Groups first at each level, then their children —
 * `seedChart` relies on a parent appearing before anything that names it.
 */
export const SMALL_BUSINESS_CHART: ChartTemplate = {
  id: 'small-business',
  label: 'Small business',
  description:
    'A general chart of accounts for a trading or service business: cash, bank, ' +
    'receivables, payables, stock, sales, purchases and the usual overheads. ' +
    'Rename, renumber or remove anything you do not need.',

  accounts: [
    // ---- Assets ----
    group('1000', 'Current Assets', 'asset'),
    leaf('1100', 'Cash in Hand', 'asset', '1000', 'cash'),
    group('1200', 'Bank Accounts', 'asset', '1000'),
    leaf('1210', 'Bank Account', 'asset', '1200', 'bank', 'Rename this to your bank.'),
    leaf('1300', 'Accounts Receivable', 'asset', '1000', 'accounts-receivable'),
    leaf('1400', 'Stock in Hand', 'asset', '1000', 'stock'),
    group('1500', 'Taxes Recoverable', 'asset', '1000'),
    leaf('1600', 'Advances and Deposits', 'asset', '1000'),
    leaf(
      '1900',
      'Suspense',
      'asset',
      '1000',
      'suspense',
      'Amounts not yet identified. A balance here is something to clear, not to keep.',
    ),

    group('1800', 'Fixed Assets', 'asset'),
    leaf('1810', 'Plant and Machinery', 'asset', '1800'),
    leaf('1820', 'Furniture and Fixtures', 'asset', '1800'),
    leaf('1830', 'Office Equipment', 'asset', '1800'),
    leaf(
      '1890',
      'Accumulated Depreciation',
      'asset',
      '1800',
      undefined,
      'Carries a credit balance, which is why it reduces fixed assets rather than adding to them.',
    ),

    // ---- Liabilities ----
    group('2000', 'Current Liabilities', 'liability'),
    leaf('2100', 'Accounts Payable', 'liability', '2000', 'accounts-payable'),
    group('2200', 'Duties and Taxes', 'liability', '2000'),
    leaf('2300', 'Salaries and Wages Payable', 'liability', '2000'),
    leaf('2400', 'Other Current Liabilities', 'liability', '2000'),

    group('2800', 'Loans', 'liability'),
    leaf('2810', 'Secured Loans', 'liability', '2800'),
    leaf('2820', 'Unsecured Loans', 'liability', '2800'),

    // ---- Equity ----
    group('3000', 'Capital', 'equity'),
    leaf('3100', 'Owner’s Capital', 'equity', '3000'),
    leaf('3200', 'Drawings', 'equity', '3000'),
    leaf(
      '3300',
      'Retained Earnings',
      'equity',
      '3000',
      'retained-earnings',
      'Where each year’s profit or loss lands when the year is closed.',
    ),
    leaf(
      '3400',
      'Opening Balance Equity',
      'equity',
      '3000',
      'opening-balance-equity',
      'The other side of opening balances. It should return to zero once they are all entered.',
    ),

    // ---- Income ----
    group('4000', 'Revenue', 'income'),
    leaf('4100', 'Sales', 'income', '4000', 'sales'),
    leaf('4200', 'Sales Returns', 'income', '4000', 'sales-returns'),
    leaf('4300', 'Discount Received', 'income', '4000', 'discount-received'),
    leaf('4400', 'Other Income', 'income', '4000'),

    // ---- Expenses ----
    group('5000', 'Cost of Sales', 'expense'),
    leaf('5100', 'Purchases', 'expense', '5000', 'purchases'),
    leaf('5200', 'Purchase Returns', 'expense', '5000', 'purchase-returns'),
    leaf('5300', 'Cost of Goods Sold', 'expense', '5000', 'cost-of-goods-sold'),
    leaf(
      '5400',
      'Freight Inward',
      'expense',
      '5000',
      'freight-inward',
      'Carriage a supplier charges on their own bill. It is part of what the goods cost.',
    ),
    leaf('5500', 'Stock Adjustment', 'expense', '5000', 'stock-adjustment'),

    group('6000', 'Operating Expenses', 'expense'),
    leaf('6100', 'Salaries and Wages', 'expense', '6000'),
    leaf('6200', 'Rent', 'expense', '6000'),
    leaf('6300', 'Electricity and Water', 'expense', '6000'),
    leaf('6400', 'Telephone and Internet', 'expense', '6000'),
    leaf('6500', 'Freight Outward', 'expense', '6000', 'freight-outward'),
    leaf('6600', 'Professional Fees', 'expense', '6000'),
    leaf('6700', 'Bank Charges', 'expense', '6000'),
    leaf('6800', 'Repairs and Maintenance', 'expense', '6000'),
    leaf('6850', 'Depreciation', 'expense', '6000'),
    leaf('6900', 'Discount Allowed', 'expense', '6000', 'discount-allowed'),
    leaf(
      '6990',
      'Round Off',
      'expense',
      '6000',
      'round-off',
      'The paisa a rounded invoice total gains or loses. It should stay small.',
    ),
  ],
}

export const CHART_TEMPLATES: readonly ChartTemplate[] = [SMALL_BUSINESS_CHART]

export function chartTemplate(id: string): ChartTemplate | null {
  return CHART_TEMPLATES.find((template) => template.id === id) ?? null
}
