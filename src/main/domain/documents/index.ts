/*
 * The document domain. Import from here, not from the individual files.
 *
 * Pure by construction and by lint rule, the same as `domain/ledger` beside it: no Node
 * built-in, no `electron`, nothing from `db/`, `ipc/` or `regimes/`. What is in here is
 * what a trade document is and what it adds up to, which is the same in every country
 * that raises invoices.
 *
 * Start at types.ts — the four rules at the top of it are the contract.
 */

export {
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  definitionOf,
  hasNumber,
  isDeletable,
  isEditable,
  isLive,
  kindsOnSide,
  levyOf,
  postsToLedger,
  type DocumentDirection,
  type DocumentErrorCode,
  type DocumentKind,
  type DocumentKindDefinition,
  type DocumentLine,
  type DocumentLineTax,
  type DocumentStatus,
  type NumberingCounter,
  type NumberingReset,
  type NumberingSeries,
  type RoundingPolicy,
  type SupplyPlace,
  type TaxLevy,
  type TradeDocument,
  type TradeSide,
} from './types'

export {
  counterScopeOf,
  formatDocumentNumber,
  paddedSequence,
  previewOf,
  type NumberingScope,
} from './numbering'

export { documentTotals, lineTax, lineTotal, type DocumentTotals, type Summable } from './totals'
