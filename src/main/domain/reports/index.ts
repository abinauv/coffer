/*
 * The report domain. Import from here, not from the individual files.
 *
 * Pure, like the rest of `domain/`: this is where the shape of a financial statement is
 * decided — which rows appear, how a group totals its children, where the profit sits on
 * a balance sheet — with no database and no formatting anywhere near it.
 *
 * The repository fetches; this decides; the renderer draws. A figure is computed exactly
 * once, here or in `balances.ts`, and never recomputed downstream.
 */

export {
  AGE_BUCKETS,
  ageItems,
  assertBucketsCover,
  bucketIndexIn,
  type AgeBucket,
  type AgeableItem,
  type AgedParty,
  type Ageing,
  type AgeingTotals,
  type PlacedItem,
} from './ageing'

export {
  buildReportTree,
  profitInEquity,
  type BuildOptions,
  type ReportAccount,
  type ReportLine,
  type ReportTree,
} from './tree'

export {
  contraLabel,
  runningLedger,
  type LedgerMovement,
  type LedgerRow,
  type RunningLedger,
} from './running'
