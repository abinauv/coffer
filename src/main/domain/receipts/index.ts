/*
 * The receipt domain. Import from here, not from the individual files.
 *
 * Pure by construction and by lint rule, the same as `domain/documents` beside it: no
 * Node built-in, no `electron`, nothing from `db/`, `ipc/` or `regimes/`. What is in here
 * is what a receipt is and what it settles, which is the same in every country that sends
 * invoices and gets paid for them.
 *
 * Start at types.ts — the three rules at the top of it are the contract, and rule 2 is
 * the one that decides the shape of everything above this layer.
 */

export {
  RECEIPT_KINDS,
  RECEIPT_STATUSES,
  acceptsAllocations,
  allocatedTotal,
  isCancellable,
  isLiveReceipt,
  receiptDefinitionOf,
  receiptTreatmentOf,
  settledBy,
  settledByIn,
  settledDirection,
  settles,
  settlesSide,
  type MoneyDirection,
  type PostableReceipt,
  type ReceiptAllocation,
  type ReceiptKind,
  type ReceiptKindDefinition,
  type ReceiptTreatment,
  type ReceiptStatus,
} from './types'

export {
  paymentRule,
  receiptPostingRuleFor,
  receiptRule,
  refundReceivedRule,
  refundRule,
} from './posting'
