/*
 * Which paths the renderer is allowed to point the operating system at.
 *
 * `system.revealInFileManager` hands a path straight to the OS file manager. Without a
 * restriction that is a general-purpose "open a window on any directory of my choosing"
 * primitive, exposed to the least trusted layer in the app — a renderer bug, or a
 * malicious script that reaches it, could pop Explorer open on someone's SSH keys.
 *
 * The rule instead: Coffer reveals only paths it already put in front of the user.
 *
 *   - the application data directory, seeded at startup;
 *   - any directory or file the user themselves picked in a native dialog this session,
 *     because that picker required a real human click on a real path;
 *   - the database, vault and backup-archive paths that flowed out through the
 *     `companies` handlers, because the user already sees them on screen.
 *
 * Nothing here persists. A restart starts from the seeded roots again.
 */

import { resolve, sep } from 'node:path'

export interface PathAllowlist {
  /** Grant this path, and anything beneath it if it is a directory. */
  allow(path: string): void
  /** True when `path` is one of the granted paths, or lives inside one. */
  isAllowed(path: string): boolean
}

/* Windows and macOS both have case-insensitive filesystems by default, so a comparison
 * that respects case would be trivially bypassed there. Linux is case-sensitive and a
 * case-folding comparison would be wrong. */
const IS_CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

/**
 * `resolve` collapses `..`, `.` and mixed separators before anything is compared, so a
 * traversal attempt is normalised into the path it actually names and then judged on
 * its merits.
 */
function normalise(path: string): string {
  const absolute = resolve(path)
  return IS_CASE_INSENSITIVE ? absolute.toLowerCase() : absolute
}

export function createPathAllowlist(seed: readonly string[] = []): PathAllowlist {
  const granted = new Set<string>()

  const allow = (path: string): void => {
    if (path.length === 0) return
    granted.add(normalise(path))
  }

  for (const path of seed) allow(path)

  return {
    allow,
    isAllowed(path: string): boolean {
      if (path.length === 0) return false
      const target = normalise(path)
      for (const entry of granted) {
        if (target === entry) return true
        const prefix = entry.endsWith(sep) ? entry : entry + sep
        if (target.startsWith(prefix)) return true
      }
      return false
    },
  }
}
