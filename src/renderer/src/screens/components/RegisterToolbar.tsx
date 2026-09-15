/*
 * What the document and voucher registers share above and instead of their table: the
 * search box and status filters, and the two ways a register can be empty.
 *
 * The two registers filter by different statuses and search different columns and are
 * otherwise the same row. The filters are toggle buttons in a named group, so a screen
 * reader hears which one is on rather than inferring it from which button is drawn filled.
 */

import type { JSX } from 'react'
import { Button } from '@renderer/components/atoms'
import { EmptyState } from './EmptyState'
import { RegisterSearch } from './RegisterSearch'

interface RegisterToolbarProps<S extends string> {
  placeholder: string
  search: string
  onSearchChange: (value: string) => void
  onSearchSubmit: () => void
  filters: ReadonlyArray<{ value: S | ''; label: string }>
  status: S | ''
  onStatusChange: (value: S | '') => void
}

export function RegisterToolbar<S extends string>({
  placeholder,
  search,
  onSearchChange,
  onSearchSubmit,
  filters,
  status,
  onStatusChange,
}: RegisterToolbarProps<S>): JSX.Element {
  return (
    <div className="toolbar register__toolbar">
      <RegisterSearch
        placeholder={placeholder}
        value={search}
        onChange={onSearchChange}
        onSubmit={onSearchSubmit}
      />
      <div className="register__filters" role="group" aria-label="Status">
        {filters.map((filter) => (
          <Button
            key={filter.value}
            variant={status === filter.value ? 'primary' : 'ghost'}
            size="sm"
            aria-pressed={status === filter.value}
            onClick={() => onStatusChange(filter.value)}
          >
            {filter.label}
          </Button>
        ))}
      </div>
    </div>
  )
}

interface RegisterEmptyProps {
  /** Lower case and plural, as a sentence names them: "sales invoices". */
  plural: string
  isFiltered: boolean
  /** What an unfiltered empty register says it needs. */
  sentence: string
  /** The button that starts the first one: "New sales invoice". Absent, no button. */
  newLabel?: string
  onNew?: () => void
  onClear: () => void
  /** What a filtered empty register says. A register's own sentence unless given. */
  filteredSentence?: string
  /** The button that clears the filter. "Clear the search and filter" unless given. */
  clearLabel?: string
}

/**
 * A register with no rows, which is two different states.
 *
 * Empty on a user's first day, it names what is missing and offers the one action that
 * fills it. Empty because of a filter, it says so and offers to clear the filter — a
 * first-day sentence about parties and business details would send somebody off to fix a
 * problem they do not have.
 */
export function RegisterEmpty({
  plural,
  isFiltered,
  sentence,
  newLabel,
  onNew,
  onClear,
  filteredSentence,
  clearLabel = 'Clear the search and filter',
}: RegisterEmptyProps): JSX.Element {
  return isFiltered ? (
    <EmptyState
      title="Nothing matches that"
      titleAs="h2"
      action={<Button onClick={onClear}>{clearLabel}</Button>}
    >
      <p>{filteredSentence ?? `No ${plural} match the search and status chosen.`}</p>
    </EmptyState>
  ) : (
    <EmptyState
      title={`No ${plural} yet`}
      titleAs="h2"
      action={
        newLabel === undefined || onNew === undefined ? undefined : (
          <Button variant="primary" icon="plus" onClick={onNew}>
            {newLabel}
          </Button>
        )
      }
    >
      <p>{sentence}</p>
    </EmptyState>
  )
}
