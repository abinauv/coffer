/*
 * The `system` group: what the app is, where the user wants to put things, and showing
 * a file in the file manager.
 *
 * The Electron calls themselves — `dialog`, `shell`, `app` — sit behind
 * `SystemEnvironment` and are implemented in ../electron.ts. That keeps the decisions
 * worth testing (what counts as a valid path, what happens when a dialog is cancelled,
 * which paths may be revealed) in a module that runs under plain Vitest with no
 * Electron process anywhere near it.
 */

import type { AppInfo, TitleBarOverlayColors } from '../../../shared/dto'
import { IpcError } from '../errors'
import type { PathAllowlist } from '../path-access'
import type { GroupHandlers } from '../registry'
import { ok } from '../surface'
import { expectAbsolutePath, expectRecord, expectString, noArgs } from '../validate'

/* The renderer is untrusted, and these values are handed straight to the OS. Anything
 * that is not a plain #rrggbb is rejected rather than passed along. */
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/

function expectHexColour(value: unknown, field: string): string {
  const text = expectString(value, field)
  if (!HEX_COLOUR.test(text)) {
    throw new IpcError('INVALID_ARGUMENT', `${field} must be a colour like #1a2b3c.`)
  }
  return text
}

function expectOverlayColors(value: unknown): TitleBarOverlayColors {
  const record = expectRecord(value, 'colors')
  return {
    color: expectHexColour(record['color'], 'colors.color'),
    symbolColor: expectHexColour(record['symbolColor'], 'colors.symbolColor'),
  }
}

export interface SystemEnvironment {
  appInfo(): AppInfo
  /** Native directory picker. Null when the user cancels. */
  chooseDirectory(): Promise<string | null>
  /** Native picker for a backup archive. Null when the user cancels. */
  chooseBackupArchive(): Promise<string | null>
  /** Native picker for an existing company database. Null when the user cancels. */
  chooseCompanyFile(): Promise<string | null>
  /** Repaint the OS-drawn window buttons. A no-op where the OS owns their colours. */
  setTitleBarOverlay(colors: TitleBarOverlayColors): void
  /** Show the path in Explorer/Finder/the file manager. */
  revealPath(path: string): Promise<void>
  pathExists(path: string): Promise<boolean>
}

export function createSystemHandlers(
  environment: SystemEnvironment,
  allowlist: PathAllowlist,
): GroupHandlers<'system'> {
  return {
    getAppInfo: {
      parseArgs: noArgs,
      handle: () => ok(environment.appInfo()),
    },

    chooseDirectory: {
      parseArgs: noArgs,
      handle: async () => {
        const directory = await environment.chooseDirectory()
        /* The user picked it themselves in a native dialog, so revealing it later is
         * something they already asked for once. */
        if (directory !== null) allowlist.allow(directory)
        return ok(directory)
      },
    },

    chooseBackupArchive: {
      parseArgs: noArgs,
      handle: async () => {
        const archive = await environment.chooseBackupArchive()
        if (archive !== null) allowlist.allow(archive)
        return ok(archive)
      },
    },

    chooseCompanyFile: {
      parseArgs: noArgs,
      handle: async () => {
        const file = await environment.chooseCompanyFile()
        /* Picked in a native dialog, so the user has already asked for it once — and
         * `companies.addExisting` will want to reveal it later. */
        if (file !== null) allowlist.allow(file)
        return ok(file)
      },
    },

    setTitleBarOverlay: {
      parseArgs: (raw): [TitleBarOverlayColors] => [expectOverlayColors(raw[0])],
      handle: (colors) => {
        environment.setTitleBarOverlay(colors)
        return ok(undefined)
      },
    },

    revealInFileManager: {
      parseArgs: (raw): [string] => [expectAbsolutePath(raw[0], 'path')],
      handle: async (path) => {
        if (!allowlist.isAllowed(path)) {
          throw new IpcError(
            'PATH_NOT_ALLOWED',
            'Coffer can only show files it manages. Choose the folder or file first.',
          )
        }
        if (!(await environment.pathExists(path))) {
          throw new IpcError(
            'PATH_NOT_FOUND',
            'That file is no longer where Coffer expected it. It may have been moved, ' +
              'renamed, or deleted.',
          )
        }

        await environment.revealPath(path)
        return ok(undefined)
      },
    },
  }
}
