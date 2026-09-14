/*
 * The section bar: the six parts of the business, across the top of the workspace.
 *
 * It answers one question, which part of the business you are in, and leaves "which
 * screen" to the rail. Every section comes from the screen registry; a section with no
 * screen registered is not drawn, rather than drawn empty.
 *
 * Buttons, not links: there is no address to go to, only a route the app holds.
 */

import type { JSX } from 'react'
import type { NavGroupId, NavSection } from '../../lib/screens'

interface SectionBarProps {
  sections: readonly NavSection[]
  currentId: NavGroupId | null
  onSelect: (sectionId: NavGroupId) => void
}

export function SectionBar({ sections, currentId, onSelect }: SectionBarProps): JSX.Element {
  return (
    <nav className="sectionbar" aria-label="Sections">
      <ul className="sectionbar__list">
        {sections.map((section) => {
          const isCurrent = section.id === currentId
          return (
            <li key={section.id} className="sectionbar__entry">
              <button
                type="button"
                className="sectionbar__item focus-inset"
                data-active={isCurrent ? 'true' : 'false'}
                /* `true` rather than `page`: the section is where you are, and the page is
                 * the rail's to name. */
                aria-current={isCurrent ? 'true' : undefined}
                onClick={() => onSelect(section.id)}
              >
                {section.label}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
