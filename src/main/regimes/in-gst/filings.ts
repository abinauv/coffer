/*
 * The returns this regime knows about.
 *
 * Declarations only. Producing the artefacts is Phase 5; what belongs here is the list a
 * compliance calendar can render and a settings screen can offer, so that a second
 * regime declaring its own returns needs no change anywhere else.
 *
 * `frequency` is the ordinary filing period. GSTR-1 and GSTR-3B move to quarterly for a
 * taxpayer who has opted into QRMP, which is a per-company setting rather than a fact
 * about the return — so it is named in the description and resolved by whatever reads
 * this, not encoded as a second definition here.
 */

import type { FilingDefinition } from '@main/regimes/types'

export const INDIA_FILINGS: readonly FilingDefinition[] = [
  {
    id: 'gstr-1',
    label: 'GSTR-1',
    frequency: 'monthly',
    description:
      'Outward supplies. Every sales invoice, credit note and debit note issued in the period, ' +
      'reported line by line. Quarterly for taxpayers under the QRMP scheme.',
  },
  {
    id: 'gstr-3b',
    label: 'GSTR-3B',
    frequency: 'monthly',
    description:
      'The summary return, and the one that carries the payment: output tax for the period, ' +
      'input tax credit claimed, and the net cash due. Quarterly under QRMP, with tax paid ' +
      'monthly regardless.',
  },
  {
    id: 'gstr-2b',
    label: 'GSTR-2B',
    frequency: 'monthly',
    description:
      'The static statement of input tax credit available for the period, drafted by the portal ' +
      'from what suppliers filed. Nothing is submitted — it is what purchases are reconciled ' +
      'against before credit is claimed in GSTR-3B.',
  },
]
