/*
 * The only file under src/main/tax-returns that touches Electron: where a file goes.
 *
 * Kept this small on purpose, like `printing/window.ts`: everything worth testing about
 * an export — which documents, what the file says, what it is called — runs without a
 * dialog, and this is the one call that cannot.
 */

import { writeFile } from 'node:fs/promises'
import { BrowserWindow, dialog, type SaveDialogOptions } from 'electron'
import type { ReturnFileSaver } from './service'

export function createElectronReturnFileSaver(): ReturnFileSaver {
  return {
    async save(suggestedFileName, contents) {
      const options: SaveDialogOptions = {
        title: 'Export the return',
        defaultPath: suggestedFileName,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      }
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      const chosen = await (parent === null
        ? dialog.showSaveDialog(options)
        : dialog.showSaveDialog(parent, options))
      /* A closed dialog is the user's decision, not a failure: nothing is written. */
      if (chosen.canceled || chosen.filePath === undefined || chosen.filePath === '') return null
      await writeFile(chosen.filePath, contents, 'utf8')
      return chosen.filePath
    },
  }
}
