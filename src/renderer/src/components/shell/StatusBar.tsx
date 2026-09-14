/*
 * The status bar: which file is open, and the two facts about it that never change.
 *
 * THE WHOLE PATH, NEVER AN ELLIPSIS. The sidebar this replaces cut the path down to
 * "…ers-Private-Limited.coffer", and the part it cut is the part that says which folder the
 * books are in. A long path wraps onto a second line instead (B15 in the design plan).
 *
 * BOTH CLAIMS ARE TRUE, AND HAVE TO STAY TRUE. The file is SQLCipher (`CIPHER` in
 * src/main/db/connection.ts). The renderer's Content Security Policy forbids every remote
 * origin, and main makes no request of its own: no updater, no telemetry, and the
 * spellchecker, which downloads dictionaries on Linux, is switched off in src/main/index.ts.
 * Adding any of those means changing this sentence.
 */

import type { JSX } from 'react'
import { useCompany } from '../../store/company'

export function StatusBar(): JSX.Element | null {
  const { company } = useCompany()
  if (company === null) return null

  return (
    <footer className="statusbar">
      <span className="statusbar__path">
        <span className="visually-hidden">Company file: </span>
        <span className="selectable">{company.filePath}</span>
      </span>
      <span>encrypted · SQLCipher</span>
      <span className="statusbar__offline">offline — this app never connects</span>
    </footer>
  )
}
