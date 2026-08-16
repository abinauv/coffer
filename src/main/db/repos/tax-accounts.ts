/*
 * The tax accounts a regime needs, built from what that regime says it levies.
 *
 * The last piece of the chart of accounts, deferred since batch 1.1A because
 * `TaxRegime` could not yet enumerate its components. It can now (`taxComponents()`),
 * and this is the only place the two meet.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE KNOWS WHAT GST IS
 *
 * Read the file for `CGST` and you will not find it. A component arrives as a `code` and
 * a `label`; the account name, the code and the role are derived from those. That is
 * what lets a second regime ship without touching `db/` — and what keeps the ESLint rule
 * forbidding a concrete regime import outside `regimes/` true rather than aspirational.
 *
 * ---------------------------------------------------------------------------
 * TWO ACCOUNTS PER COMPONENT, ON OPPOSITE SIDES OF THE BALANCE SHEET
 *
 * Tax charged on a sale is owed to the government — a liability, under `Duties and
 * Taxes`. Tax paid on a purchase is reclaimable from it — an asset, under `Taxes
 * Recoverable`. They are set off when a return is filed, by the return, and never
 * continuously in the ledger.
 *
 * One netted account would hide both figures behind their difference, and every return
 * asks for them separately. A ledger that had already netted them cannot answer, and the
 * figure it could produce would be a number the return has no box for.
 */

import type { TaxComponentDefinition } from '@main/regimes/types'
import { taxRoleName } from './accounts'
import type { TemplateAccount } from './chart-template'

/** Where the two families of tax account hang. Both groups exist in the template. */
export const OUTPUT_TAX_PARENT = '2200'
export const INPUT_TAX_PARENT = '1500'

/**
 * Codes are allocated in the order the regime lists its components.
 *
 * Ten apart, so a regime with a component this template did not anticipate — or a user
 * who wants one of their own between two of these — has room without renumbering
 * anything. Nothing depends on the codes: every lookup goes through the role, which is
 * the whole reason roles exist.
 */
const CODE_STEP = 10

export interface TaxAccountOptions {
  /** Overrides the group the output accounts hang under. */
  outputParentCode?: string
  /** Overrides the group the input accounts hang under. */
  inputParentCode?: string
}

/**
 * Two accounts per component, as template rows ready for `seedChart`.
 *
 * Returns them in the order the regime gave, output accounts before input ones, so a
 * user reading their chart sees the liabilities together and the assets together rather
 * than interleaved by component.
 */
export function taxAccountsFor(
  components: readonly TaxComponentDefinition[],
  options: TaxAccountOptions = {},
): TemplateAccount[] {
  const outputParent = options.outputParentCode ?? OUTPUT_TAX_PARENT
  const inputParent = options.inputParentCode ?? INPUT_TAX_PARENT

  const output: TemplateAccount[] = []
  const input: TemplateAccount[] = []

  components.forEach((component, index) => {
    const offset = (index + 1) * CODE_STEP

    if (component.levy === 'output' || component.levy === 'both') {
      output.push({
        code: `${Number(outputParent) + offset}`,
        /* The regime's own label, so a component it calls 'Central GST' is not renamed
         * here into something its user has never seen on a return. */
        name: `${component.label} Payable`,
        type: 'liability',
        parentCode: outputParent,
        isGroup: false,
        role: taxRoleName(component.code, 'output'),
        description: `${component.code} charged on sales. Owed to the tax authority until the return is filed.`,
      })
    }

    if (component.levy === 'input' || component.levy === 'both') {
      input.push({
        code: `${Number(inputParent) + offset}`,
        name: `${component.label} Recoverable`,
        type: 'asset',
        parentCode: inputParent,
        isGroup: false,
        role: taxRoleName(component.code, 'input'),
        description: `${component.code} paid on purchases. Reclaimable against ${component.code} charged on sales.`,
      })
    }
  })

  return [...input, ...output]
}
