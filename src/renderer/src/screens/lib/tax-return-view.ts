/*
 * What the Tax returns screen says, kept out of the component so it reads as sentences.
 *
 * NO WORD IN THIS FILE NAMES A COUNTRY, A FORM OR A TAX (CONVENTIONS §1.6). Forms, table
 * labels, the notice and every figure come from main; what is decided here is which
 * periods to offer, which to start on, and how to talk about what main found doubtful.
 */

import type { AccountingPeriod, TaxReturnIssue } from '@shared/dto'

/** One period the picker offers. */
export interface PeriodOption {
  /** `from|to`, which is unique and is what a `<select>` needs. */
  value: string
  label: string
  from: string
  to: string
}

/**
 * The periods worth offering: every one that has started, newest first.
 *
 * A period that has not started has no documents yet, and offering next March's return in
 * September is offering an empty table. The fiscal year goes in the label when the books
 * span more than one, so two Aprils cannot be confused.
 */
export function periodOptions(periods: readonly AccountingPeriod[], today: string): PeriodOption[] {
  const years = new Set(periods.map((period) => period.fiscalYearLabel))
  return periods
    .filter((period) => period.startDate <= today)
    .sort((a, b) => (a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0))
    .map((period) => ({
      value: `${period.startDate}|${period.endDate}`,
      label: years.size > 1 ? `${period.label} (${period.fiscalYearLabel})` : period.label,
      from: period.startDate,
      to: period.endDate,
    }))
}

/**
 * Which period to open on: the latest that has finished, since that is the one a return
 * is being prepared for. The month in progress when nothing has finished yet — a company
 * set up this month still gets a table rather than an empty picker.
 */
export function defaultPeriod(
  options: readonly PeriodOption[],
  today: string,
): PeriodOption | null {
  return options.find((option) => option.to < today) ?? options[0] ?? null
}

/** The period a link asked for, when it is one the picker offers. */
export function requestedPeriod(
  options: readonly PeriodOption[],
  from: string | undefined,
  to: string | undefined,
): PeriodOption | null {
  if (from === undefined || to === undefined) return null
  return options.find((option) => option.from === from && option.to === to) ?? null
}

export interface IssueGroups {
  errors: TaxReturnIssue[]
  warnings: TaxReturnIssue[]
}

/** Errors first: they are what stops a return being filed as it stands. */
export function groupIssues(issues: readonly TaxReturnIssue[]): IssueGroups {
  return {
    errors: issues.filter((issue) => issue.severity === 'error'),
    warnings: issues.filter((issue) => issue.severity === 'warning'),
  }
}

/**
 * One sentence about what main found.
 *
 * IT NEVER SAYS THE RETURN IS READY. The most it says is that nothing was found to
 * question — the shape of a provisional return is unchecked whatever its issues are, and
 * the notice above the table says so separately.
 */
export function issueSummary(issues: readonly TaxReturnIssue[]): string {
  const { errors, warnings } = groupIssues(issues)
  const assumed = (count: number): string =>
    `${counted(count, 'thing')} ${count === 1 ? 'was' : 'were'} assumed rather than read from the books`

  if (errors.length > 0) {
    const stops = `${counted(errors.length, 'thing')} ${errors.length === 1 ? 'stops' : 'stop'} this being filed as it stands`
    return warnings.length === 0
      ? `${capitalised(stops)}.`
      : `${capitalised(stops)}, and ${assumed(warnings.length)}.`
  }
  if (warnings.length > 0) return `Nothing stops this being filed, but ${assumed(warnings.length)}.`
  return 'Nothing in these documents was found to question.'
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

function counted(count: number, noun: string): string {
  return `${WORDS[count] ?? String(count)} ${noun}${count === 1 ? '' : 's'}`
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** What the Overview calls a return nobody has opened. */
export function dueTitle(formLabel: string, periodLabel: string): string {
  return `${formLabel} for ${periodLabel} has not been looked at`
}

export function dueNote(documentCount: number): string {
  const documents = documentCount === 1 ? 'One document is' : `${documentCount} documents are`
  return `${documents} dated then. The return is prepared from them — look it over before you file.`
}
