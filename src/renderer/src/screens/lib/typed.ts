/*
 * Has anything been typed into this dialog since it opened?
 *
 * What Escape needs to know before it closes one (design system §04, rule 2). The answer is
 * a comparison against the draft the dialog opened with, so a dialog reopened on another
 * record starts fresh — every one of them is keyed on the record it edits and remounts.
 *
 * NOTHING SENSITIVE GOES THROUGH HERE. It serialises the draft to compare it, which is fine
 * for a party or an item and wrong for a passphrase: the passphrase dialog answers the same
 * question with a plain boolean over its own fields, and never hands the text to anything
 * that keeps a copy.
 */

import { useRef } from 'react'

export function useHasTyped(draft: unknown): boolean {
  const opened = useRef<string | null>(null)
  const current = JSON.stringify(draft)
  opened.current ??= current
  return current !== opened.current
}
