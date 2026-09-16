/*
 * Ctrl F on a register or a list: put the cursor in the search box on screen.
 *
 * The binding is a command like any other, so the palette says the key and the key does
 * what the palette says (design system §04, rule 4). One hook rather than six copies,
 * because six copies is six chances for one of them to bind a different chord.
 *
 * The box is SELECTED, not merely focused: Ctrl F on a search that already says something
 * means "search for something else", and a cursor at the end of the old query means
 * clearing it by hand first.
 */

import { useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import type { Command } from '@renderer/lib/command-registry'
import { SHORTCUTS } from '@renderer/lib/shortcuts'
import { useRegisterCommands } from '@renderer/store/commands'

export function useSearchShortcut(
  /** Unique per screen, as every command id is: `documents.sales-invoice.search`. */
  id: string,
  section: string,
  /** What the palette calls it: "Search these sales invoices". */
  title: string,
): RefObject<HTMLInputElement | null> {
  const box = useRef<HTMLInputElement>(null)

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id,
          title,
          section,
          keywords: ['search', 'find', 'filter'],
          shortcut: SHORTCUTS.search,
          run: () => {
            const element = box.current
            if (element === null) return
            element.focus()
            element.select()
          },
        },
      ],
      [id, section, title],
    ),
  )

  return box
}
