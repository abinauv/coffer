/*
 * The command registry.
 *
 * Every keyboard-reachable action in Coffer registers here, and the palette, the
 * global shortcut listener and (later) the menu all read from this one list. A
 * screen contributes its commands while it is mounted and takes them away when it
 * unmounts, so what the palette offers is always what is actually available.
 *
 * Registration is by token, not by id: React invokes effects twice in StrictMode,
 * so the same command can legitimately be registered before its predecessor has
 * been torn down. Keying on the registration itself makes that a no-op rather than
 * a duplicate, and `list()` collapses any id collision to the newest entry.
 *
 * Pure and DOM-free. Commands carry a `run` callback; nothing here calls it.
 */

import type { Shortcut } from './keys'

export interface Command {
  /** Stable and unique, e.g. 'view.toggle-sidebar'. Used to run it by name. */
  id: string
  /** Imperative, sentence case, no trailing period. 'Open company…' */
  title: string
  /** Group heading in the palette. Commands sort within their section. */
  section: string
  /** Extra words that should find this command. Never shown. */
  keywords?: readonly string[]
  /** A short right-aligned note: the current value, the target, a caveat. */
  hint?: string
  shortcut?: Shortcut
  /** Listed but not runnable, e.g. an action the current state forbids. */
  isDisabled?: boolean
  run: () => void | Promise<void>
}

export interface CommandRegistry {
  /** Adds commands and returns the function that removes exactly these again. */
  register(commands: readonly Command[]): () => void
  /** Every registered command, newest registration of an id winning. */
  list(): readonly Command[]
  find(id: string): Command | undefined
  subscribe(listener: () => void): () => void
}

export function createCommandRegistry(): CommandRegistry {
  const registrations = new Map<symbol, readonly Command[]>()
  const listeners = new Set<() => void>()
  /* useSyncExternalStore compares snapshots by identity and will loop forever if
   * getSnapshot returns a fresh array each call. Rebuild only on mutation. */
  let snapshot: readonly Command[] = []

  function rebuild(): void {
    const byId = new Map<string, Command>()
    for (const commands of registrations.values()) {
      for (const command of commands) byId.set(command.id, command)
    }
    snapshot = [...byId.values()]
    for (const listener of listeners) listener()
  }

  return {
    register(commands) {
      const token = Symbol('command-registration')
      registrations.set(token, [...commands])
      rebuild()
      return () => {
        if (registrations.delete(token)) rebuild()
      }
    },
    list: () => snapshot,
    find: (id) => snapshot.find((command) => command.id === id),
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

// ---- Searching ------------------------------------------------------------

export interface CommandMatch {
  command: Command
  score: number
  /** Half-open [start, end) ranges into `command.title` to highlight. */
  ranges: readonly (readonly [number, number])[]
}

/* Weights chosen so that a title match always outranks a keyword match of the
 * same quality, and a run of adjacent characters always outranks the same
 * characters scattered — typing "invl" should find "Invoice list", not the
 * command that merely happens to contain those four letters. */
const SCORE_PREFIX = 1000
const SCORE_WORD_START = 600
const SCORE_CONTAINS = 300
const SCORE_ADJACENT = 40
const SCORE_PER_CHARACTER = 8
const KEYWORD_WEIGHT = 0.55

/**
 * Ranks commands against a query. An empty query returns everything in
 * registration order; otherwise only commands that match at all, best first,
 * ties broken by registration order so the list never reshuffles arbitrarily.
 */
export function searchCommands(
  commands: readonly Command[],
  query: string,
): readonly CommandMatch[] {
  const trimmed = query.trim()
  if (trimmed === '') {
    return commands.map((command) => ({ command, score: 0, ranges: [] }))
  }

  const matches: { match: CommandMatch; index: number }[] = []
  commands.forEach((command, index) => {
    const title = scoreText(command.title, trimmed)
    let score = title?.score ?? 0
    for (const keyword of command.keywords ?? []) {
      const hit = scoreText(keyword, trimmed)
      if (hit) score = Math.max(score, hit.score * KEYWORD_WEIGHT)
    }
    const section = scoreText(command.section, trimmed)
    if (section) score = Math.max(score, section.score * KEYWORD_WEIGHT)

    if (score <= 0) return
    matches.push({
      match: { command, score, ranges: title?.ranges ?? [] },
      index,
    })
  })

  matches.sort((a, b) => b.match.score - a.match.score || a.index - b.index)
  return matches.map((entry) => entry.match)
}

interface TextScore {
  score: number
  ranges: readonly (readonly [number, number])[]
}

/** Scores one string against the query, or null when the query is not in it. */
export function scoreText(text: string, query: string): TextScore | null {
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()

  const contiguous = haystack.indexOf(needle)
  if (contiguous >= 0) {
    const ranges = [[contiguous, contiguous + needle.length] as const]
    if (contiguous === 0) {
      return { score: SCORE_PREFIX + needle.length * SCORE_PER_CHARACTER, ranges }
    }
    const isWordStart = isBoundary(haystack.charAt(contiguous - 1))
    const base = isWordStart ? SCORE_WORD_START : SCORE_CONTAINS
    return { score: base + needle.length * SCORE_PER_CHARACTER, ranges }
  }

  return scoreSubsequence(haystack, needle)
}

/** Characters of the query in order but not adjacent: "invl" in "invoice list". */
function scoreSubsequence(haystack: string, needle: string): TextScore | null {
  const ranges: [number, number][] = []
  let score = 0
  let cursor = 0
  let previousIndex = -2

  for (const character of needle) {
    const found = haystack.indexOf(character, cursor)
    if (found < 0) return null

    if (found === previousIndex + 1) {
      score += SCORE_ADJACENT
      const last = ranges[ranges.length - 1]
      if (last) last[1] = found + 1
      else ranges.push([found, found + 1])
    } else {
      if (found === 0 || isBoundary(haystack.charAt(found - 1))) score += SCORE_WORD_START / 4
      ranges.push([found, found + 1])
    }
    score += SCORE_PER_CHARACTER
    previousIndex = found
    cursor = found + 1
  }

  return { score, ranges }
}

function isBoundary(character: string): boolean {
  return character === '' || /[\s\-_/.:·—]/.test(character)
}

/** Groups matches by section, preserving rank within and across sections. */
export function groupMatches(
  matches: readonly CommandMatch[],
): readonly { section: string; matches: readonly CommandMatch[] }[] {
  const sections: { section: string; matches: CommandMatch[] }[] = []
  for (const match of matches) {
    const existing = sections.find((group) => group.section === match.command.section)
    if (existing) existing.matches.push(match)
    else sections.push({ section: match.command.section, matches: [match] })
  }
  return sections
}
