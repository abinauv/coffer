/*
 * The `regime` group's service — the open company's tax regime, turned into data.
 *
 * TWO DIRECTORIES ONE LETTER APART, AND THE DIFFERENCE IS THE WHOLE POINT.
 * `src/main/regimes/` (plural) is the adapters: the `TaxRegime` interface, the registry,
 * and India's implementation of it. This one (singular) is a service like `parties/` and
 * `documents/` — it answers the one contract method in the `regime` group, and the only
 * thing it does is describe the regime the open company was set up under.
 *
 * WHY THE MAPPING LIVES HERE AND NOT IN `regimes/`. `describeRegime` is a pure function
 * over the adapter interface, and putting it beside that interface is the obvious move.
 * It would also be the first thing in `regimes/` to import `@shared/dto`. That module
 * imports `@shared/scalars` and nothing else, on purpose: an adapter someone writes for
 * a second country should have to satisfy `TaxRegime` and know nothing about Coffer's
 * DTOs, its IPC envelope or its screens. So the translation happens on this side of the
 * boundary, where translating between a domain shape and a DTO is already the job.
 *
 * NOTHING EXECUTABLE CROSSES. Every method on `TaxRegime` — `computeTax`,
 * `placeOfSupply`, `validateRegistrationNumber` — is dropped here and none is replaced
 * by an IPC method. The renderer ends up with the lists it needs to draw a picker and no
 * way at all to work out a tax, which is CONVENTIONS §1.6 stated as a data flow rather
 * than as a rule people remember.
 */

import type { RegimeDescription } from '@shared/dto'

import { OpenBooks, type OpenCompanyHandle } from '../books/open-books'
import type { TaxRegime } from '../regimes'

/**
 * A regime as the renderer sees it.
 *
 * Every array is rebuilt rather than passed through. The regime's own lists are
 * `readonly` to a TypeScript caller and plain arrays at runtime, and this hands its
 * result to the IPC layer — a structured clone would protect the regime in production,
 * but a test that calls the service directly gets the live array and could push to it.
 * Copying costs a few hundred bytes once per company open.
 *
 * A field added to `TaxRegime` does not appear here until somebody adds it, which is the
 * right default: the renderer gets what the contract says it gets, not whatever the
 * adapter happens to expose.
 */
export function describeRegime(regime: TaxRegime): RegimeDescription {
  return {
    id: regime.id,
    label: regime.label,

    numberFormat: {
      groupSizes: [...regime.numberFormat.groupSizes],
      decimalSeparator: regime.numberFormat.decimalSeparator,
      groupSeparator: regime.numberFormat.groupSeparator,
      currencyCode: regime.numberFormat.currencyCode,
      currencySymbol: regime.numberFormat.currencySymbol,
    },

    jurisdictions: regime.jurisdictions().map((jurisdiction) => ({
      code: jurisdiction.code,
      name: jurisdiction.name,
    })),

    taxRates: regime.taxRates().map((rate) => ({
      ratePct: rate.ratePct,
      label: rate.label,
      note: rate.note,
    })),

    taxComponents: regime.taxComponents().map((component) => ({
      code: component.code,
      label: component.label,
      levy: component.levy,
    })),

    registrationLabel: regime.registrationLabel,

    classification: {
      code: regime.classification.code,
      label: regime.classification.label,
      validLengths: [...regime.classification.validLengths],
    },
  }
}

export class RegimeService {
  private readonly books: OpenBooks

  constructor(companies: OpenCompanyHandle) {
    this.books = new OpenBooks(companies)
  }

  /**
   * The open company's regime.
   *
   * Needs an open company for the same reason every other service does, and for one more:
   * the regime is a property of the BOOKS, read from the file rather than taken from the
   * build's default. A company created under a regime this build no longer has fails here
   * with `COMPANY_REGIME_UNKNOWN` rather than silently being described as an Indian one.
   *
   * @throws CompanyError `NO_COMPANY_OPEN`, `COMPANY_REGIME_UNKNOWN`
   */
  async describe(): Promise<RegimeDescription> {
    return describeRegime(this.books.regime())
  }
}

export function createRegimeService(companies: OpenCompanyHandle): RegimeService {
  return new RegimeService(companies)
}
