/*
 * India GST, assembled.
 *
 * Everything above this file is a piece of the regime; this is the one place they become
 * a `TaxRegime`. The object holds no logic of its own — if a method here does anything
 * more than delegate, the rule it is doing has escaped the module that owns it.
 *
 * Note what is *not* here: no fiscal-year arithmetic, no Apr-to-Mar constant. The rule
 * comes from `domain/time`, which already knows how to derive a year, its periods and
 * its label from a start month. The regime's job is to say which rule India uses.
 */

import { aprilToMarch } from '@main/domain/time'
import type { TaxRegime } from '@main/regimes/types'
import { amountInWords } from './amount-in-words'
import { indiaClassification } from './classification'
import { taxComponents } from './components'
import { validateDocumentNumber } from './document-number'
import { INDIA_FILINGS } from './filings'
import { validateGstin } from './gstin'
import { jurisdictionName, jurisdictions } from './jurisdictions'
import { INDIA_NUMBER_FORMAT } from './number-format'
import { placeOfSupply } from './place-of-supply'
import { computeTax } from './tax'

export const inGstRegime: TaxRegime = {
  id: 'in',
  label: 'India — GST',

  computeTax,
  placeOfSupply,
  validateRegistrationNumber: validateGstin,
  validateDocumentNumber,
  jurisdictionName,
  jurisdictions,
  taxComponents,

  classification: indiaClassification,
  fiscalYear: aprilToMarch,
  numberFormat: INDIA_NUMBER_FORMAT,

  /* Takes a `DecimalInput` rather than the contract's `Decimal`, which is wider and so
   * still satisfies it — the regime's own screens can hand it a decimal string. */
  amountInWords,

  filings: INDIA_FILINGS,
}
