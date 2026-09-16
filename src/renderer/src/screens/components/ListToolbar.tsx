/*
 * What a list of masters has above its table: a search box and "Show archived".
 *
 * Parties, items, units, the chart of accounts and the numbering series all had this toolbar
 * written out five times, with a hand-rolled checkbox that sat below the search field's centre
 * line (B17) and a search box that cut off its own placeholder (B12). One component, so the
 * two cannot drift back apart.
 *
 * THE ROW IS CENTRED, NOT BOTTOM-ALIGNED. `.toolbar` lines up bottom edges, which is right for
 * a row of labelled fields and wrong here: the search's label is hidden, and a checkbox beside
 * it lined up on its bottom edge reads as a line below the text.
 */

import type { JSX, ReactNode, Ref } from 'react'
import { CheckboxField } from './CheckboxField'
import { RegisterSearch } from './RegisterSearch'

interface ListToolbarProps {
  /** Says what is searched: "Search by name, code or classification". Absent, no search box. */
  placeholder?: string
  query?: string
  onQueryChange?: (value: string) => void
  includeArchived: boolean
  onIncludeArchivedChange: (value: boolean) => void
  /** So Ctrl F can put the cursor in the search box. See `useSearchShortcut`. */
  inputRef?: Ref<HTMLInputElement>
  /** Anything else the list is filtered by, drawn after the checkbox. */
  children?: ReactNode
}

export function ListToolbar({
  placeholder,
  query = '',
  onQueryChange,
  includeArchived,
  onIncludeArchivedChange,
  inputRef,
  children,
}: ListToolbarProps): JSX.Element {
  return (
    <div className="toolbar list__toolbar">
      {placeholder !== undefined && onQueryChange !== undefined && (
        <RegisterSearch
          placeholder={placeholder}
          value={query}
          onChange={onQueryChange}
          inputRef={inputRef}
        />
      )}
      <CheckboxField isChecked={includeArchived} onChange={onIncludeArchivedChange}>
        Show archived
      </CheckboxField>
      {children}
    </div>
  )
}
