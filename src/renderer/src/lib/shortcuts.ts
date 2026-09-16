/*
 * The key map, in one place.
 *
 * Design system §04: two maps over one registry, and "the shortcut shown is the shortcut
 * that fires". Every binding in the product is one of the constants below, so a screen
 * cannot invent a second meaning for Ctrl S, and a test can read the whole map at once
 * (shortcuts.test.ts checks that no two of them are the same chord).
 *
 * The Modern map is the default and the only one built. Tally keys are post-launch (D3);
 * nothing here assumes a second map exists, and nothing here prevents one.
 */

import type { Shortcut } from './keys'

export const SHORTCUTS = {
  /** The palette. The one key that is always available. */
  palette: { key: 'k', ctrlOrCmd: true },
  /** A new document or voucher of the kind on screen. */
  create: { key: 'n', ctrlOrCmd: true },
  /** Save what is on screen. Never posts anything to the books. */
  save: { key: 's', ctrlOrCmd: true },
  /** Accept the document: issue it, or record the voucher. A deliberate second key. */
  accept: { key: 'Enter', ctrlOrCmd: true },
  /** Put the cursor in the search box of the register or list on screen. */
  search: { key: 'f', ctrlOrCmd: true },
  /** Close the books and choose another company. */
  switchCompany: { key: 'o', ctrlOrCmd: true, shift: true },
  /** Close the books and stop at the unlock screen for the company that was open. */
  lock: { key: 'l', ctrlOrCmd: true },
  nextSection: { key: ']', ctrlOrCmd: true },
  previousSection: { key: '[', ctrlOrCmd: true },
  /** Back, the key every browser and file manager already uses. */
  back: { key: 'ArrowLeft', alt: true },
  toggleRail: { key: 'b', ctrlOrCmd: true },
  /** Copy the line the cursor is in. Editors only. */
  duplicateLine: { key: 'd', ctrlOrCmd: true },
  /** One level back: out of a field, then out of the document. */
  stepBack: { key: 'Escape' },
} as const satisfies Record<string, Shortcut>

export type ShortcutName = keyof typeof SHORTCUTS
