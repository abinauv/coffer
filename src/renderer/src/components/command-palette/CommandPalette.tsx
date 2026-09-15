/*
 * The command palette.
 *
 * A shell, deliberately: it knows how to list, filter, choose and run commands,
 * and it knows nothing about what any of them do. Every entry comes from the
 * registry, so this file does not change when the product grows.
 *
 * Accessibility follows the combobox pattern — the input keeps focus and owns the
 * keyboard, the list is a listbox, and the active row is pointed at with
 * `aria-activedescendant` rather than actually being focused. That is what lets
 * Up and Down move the selection while the user is still typing.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { groupMatches, searchCommands, type Command } from '../../lib/command-registry'
import { useCommands } from '../../store/commands'
import { Dialog, Icon, Kbd } from '../atoms'

export function CommandPalette(): JSX.Element {
  const { commands, isPaletteOpen, setPaletteOpen } = useCommands()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listboxId = 'command-palette-list'

  const matches = useMemo(() => searchCommands(commands, query), [commands, query])
  const groups = useMemo(() => groupMatches(matches), [matches])
  const runnable = useMemo(
    () => matches.filter((match) => match.command.isDisabled !== true),
    [matches],
  )

  /* Reset on every open rather than on close: a palette that reopens showing the
   * last query is a palette that runs the wrong command on a fast return. */
  useEffect(() => {
    if (!isPaletteOpen) return
    setQuery('')
    setActiveIndex(0)
    /* The dialog is shown by an effect in Dialog; focus after it is in the top
     * layer or the browser puts focus on the dialog itself instead. */
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [isPaletteOpen])

  useEffect(() => setActiveIndex(0), [query])

  const active = runnable[Math.min(activeIndex, runnable.length - 1)]?.command

  useEffect(() => {
    if (!active) return
    listRef.current
      ?.querySelector(`[data-command-id="${CSS.escape(active.id)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  function run(command: Command): void {
    setPaletteOpen(false)
    void command.run()
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (runnable.length === 0) return
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault()
      setActiveIndex((index) => (index + 1) % runnable.length)
    } else if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault()
      setActiveIndex((index) => (index - 1 + runnable.length) % runnable.length)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(runnable.length - 1)
    } else if (event.key === 'Enter' && active) {
      event.preventDefault()
      run(active)
    }
  }

  return (
    <Dialog
      isOpen={isPaletteOpen}
      onClose={() => setPaletteOpen(false)}
      size="palette"
      isChrome={false}
      className="palette"
    >
      <div className="palette__search">
        <Icon name="search" size={16} className="palette__search-icon" />
        <input
          ref={inputRef}
          className="palette__input"
          type="text"
          role="combobox"
          value={query}
          placeholder="Type a command…"
          aria-label="Search commands"
          /* Only claim a popup when there is one — `aria-controls` pointing at an
             element that is not in the document is worse than none. */
          aria-expanded={matches.length > 0}
          aria-controls={matches.length > 0 ? listboxId : undefined}
          aria-activedescendant={active === undefined ? undefined : optionId(active.id)}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>

      <div className="palette__results" ref={listRef}>
        {matches.length === 0 ? (
          <p className="palette__empty">
            No command matches <strong>{query}</strong>.
          </p>
        ) : (
          <div role="listbox" id={listboxId} aria-label="Commands">
            {groups.map((group) => (
              /* `group` rather than a bare div: a listbox may own groups of
                 options, but an untyped element between the two breaks the
                 ownership chain and the options stop being announced. */
              <div
                key={group.section}
                role="group"
                aria-label={group.section}
                className="palette__group"
              >
                <div className="palette__group-heading caps-label" aria-hidden="true">
                  {group.section}
                </div>
                {group.matches.map((match) => {
                  const { command } = match
                  const isActive = command.id === active?.id
                  const isDisabled = command.isDisabled === true
                  return (
                    <div
                      key={command.id}
                      id={optionId(command.id)}
                      data-command-id={command.id}
                      role="option"
                      aria-selected={isActive}
                      aria-disabled={isDisabled || undefined}
                      className="palette__item"
                      data-active={isActive ? 'true' : 'false'}
                      data-disabled={isDisabled ? 'true' : 'false'}
                      onPointerMove={() => {
                        if (isDisabled) return
                        const index = runnable.findIndex((entry) => entry.command.id === command.id)
                        if (index >= 0) setActiveIndex(index)
                      }}
                      onClick={() => {
                        if (!isDisabled) run(command)
                      }}
                    >
                      <span className="palette__item-text">
                        <span className="palette__item-title">
                          <Highlighted text={command.title} ranges={match.ranges} />
                        </span>
                        {command.location !== undefined && (
                          <span className="palette__item-location">{command.location}</span>
                        )}
                      </span>
                      {command.hint !== undefined && (
                        <span className="palette__item-hint truncate">{command.hint}</span>
                      )}
                      {command.shortcut !== undefined && <Kbd shortcut={command.shortcut} />}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      <footer className="palette__foot">
        <span>
          <Kbd shortcut={{ key: 'ArrowUp' }} /> <Kbd shortcut={{ key: 'ArrowDown' }} /> to move
        </span>
        <span>
          <Kbd shortcut={{ key: 'Enter' }} /> to run
        </span>
        <span>
          <Kbd shortcut={{ key: 'Escape' }} /> to dismiss
        </span>
      </footer>
    </Dialog>
  )
}

function optionId(commandId: string): string {
  return `palette-option-${commandId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

/** Marks the characters the query matched, so ranking is visible not mysterious. */
function Highlighted({
  text,
  ranges,
}: {
  text: string
  ranges: readonly (readonly [number, number])[]
}): JSX.Element {
  if (ranges.length === 0) return <>{text}</>

  const pieces: JSX.Element[] = []
  let cursor = 0
  ranges.forEach(([start, end], index) => {
    if (start > cursor) pieces.push(<span key={`plain-${index}`}>{text.slice(cursor, start)}</span>)
    pieces.push(
      <mark key={`hit-${index}`} className="palette__match">
        {text.slice(start, end)}
      </mark>,
    )
    cursor = end
  })
  if (cursor < text.length) pieces.push(<span key="tail">{text.slice(cursor)}</span>)
  return <>{pieces}</>
}
