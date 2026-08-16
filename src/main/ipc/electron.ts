/*
 * The only place in the IPC layer that touches Electron.
 *
 * Everything else here — the registry, the boundary, the validators, the handlers — is
 * plain TypeScript that runs under Vitest with no Electron process. This module is the
 * seam: `ipcMain` becomes an `IpcTransport`, `dialog`/`shell`/`app` become a
 * `SystemEnvironment`, and `electron-log` becomes an `IpcLogger`.
 *
 * Keeping the seam this thin is deliberate. What is hard to test is small enough to
 * read, and what is worth testing does not need Electron to run.
 */

import { access } from 'node:fs/promises'
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import log from 'electron-log/main'
import { BRAND } from '../../branding'
import type { AppInfo, Platform, TitleBarOverlayColors } from '../../shared/dto'
import type { ErrorMapper } from './errors'
import type { SystemEnvironment } from './handlers/system'
import type { CompanyService } from './handlers/companies'
import type { LedgerService } from './handlers/ledger'
import type { ReportService } from './handlers/reports'
import { type IpcDependencies, registerIpcHandlers } from './index'
import type { HandlerRegistry, IpcLogger, IpcTransport } from './registry'

/**
 * Extensions offered when picking a backup archive.
 *
 * The backup service does not exist yet, so the archive's real extension is not settled.
 * When it is, it belongs in `src/branding.ts` beside `companyFileExtension` and this
 * list should read from there — see the batch report.
 */
const BACKUP_ARCHIVE_EXTENSIONS = ['zip']

/**
 * Height of the renderer's title bar, in CSS pixels.
 *
 * Must match `--titlebar-height` in src/renderer/src/styles. The OS draws the window
 * buttons into a band this tall; if the two disagree the buttons sit off-centre.
 */
const TITLEBAR_HEIGHT = 38

/** Adapt `ipcMain` to the registry's transport, dropping the Electron event object. */
export function createIpcMainTransport(): IpcTransport {
  return {
    handle(channel, listener) {
      /* The event carries the sender's identity, which nothing downstream is allowed to
       * see. Coffer has one window and no per-client state (docs/ARCHITECTURE.md §6.3);
       * a handler that could tell callers apart would be the first step towards it. */
      ipcMain.handle(channel, (_event, ...args: unknown[]) => listener(args))
    },
  }
}

export function createElectronLogger(): IpcLogger {
  return log.scope('ipc')
}

/**
 * Narrow Node's platform to the three the contract knows about.
 *
 * Electron ships Windows, macOS and Linux builds and nothing else. A source build on
 * some other Unix is closest to Linux in every behaviour the renderer cares about.
 */
export function toPlatform(platform: NodeJS.Platform): Platform {
  switch (platform) {
    case 'win32':
      return 'win32'
    case 'darwin':
      return 'darwin'
    default:
      return 'linux'
  }
}

/** The window a modal dialog should hang off, if there is one. */
function parentWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

async function showOpenDialog(
  options: Electron.OpenDialogOptions,
): Promise<Electron.OpenDialogReturnValue> {
  const parent = parentWindow()
  return parent === null ? dialog.showOpenDialog(options) : dialog.showOpenDialog(parent, options)
}

function firstPath(result: Electron.OpenDialogReturnValue): string | null {
  if (result.canceled) return null
  return result.filePaths[0] ?? null
}

export function createElectronSystemEnvironment(): SystemEnvironment {
  return {
    appInfo(): AppInfo {
      return {
        name: BRAND.name,
        version: app.getVersion(),
        platform: toPlatform(process.platform),
        isDevelopment: !app.isPackaged,
      }
    },

    async chooseDirectory(): Promise<string | null> {
      return firstPath(
        await showOpenDialog({
          title: 'Choose a folder',
          properties: ['openDirectory', 'createDirectory'],
        }),
      )
    },

    async chooseBackupArchive(): Promise<string | null> {
      return firstPath(
        await showOpenDialog({
          title: `Choose a ${BRAND.name} backup`,
          properties: ['openFile'],
          filters: [
            { name: `${BRAND.name} backup`, extensions: BACKUP_ARCHIVE_EXTENSIONS },
            { name: 'All files', extensions: ['*'] },
          ],
        }),
      )
    },

    async chooseCompanyFile(): Promise<string | null> {
      return firstPath(
        await showOpenDialog({
          title: `Choose a ${BRAND.name} company`,
          properties: ['openFile'],
          filters: [
            { name: `${BRAND.name} company`, extensions: [BRAND.companyFileExtension] },
            { name: 'All files', extensions: ['*'] },
          ],
        }),
      )
    },

    setTitleBarOverlay(colors: TitleBarOverlayColors): void {
      /* Windows and Linux only. macOS draws traffic lights whose colours follow the
       * system appearance, and asking Electron to restyle them there throws. */
      if (process.platform === 'darwin') return
      const window = parentWindow()
      if (window === null) return
      window.setTitleBarOverlay({ ...colors, height: TITLEBAR_HEIGHT })
    },

    async revealPath(path: string): Promise<void> {
      shell.showItemInFolder(path)
    },

    async pathExists(path: string): Promise<boolean> {
      try {
        await access(path)
        return true
      } catch {
        return false
      }
    },
  }
}

export interface ElectronIpcOptions {
  /** The company service from src/main/companies. The one part that has to be supplied. */
  companies: CompanyService
  /** The ledger service from src/main/ledger, reading the open company's books. */
  ledger: LedgerService
  /** The same service, read-only half. See the `reports` group in src/shared/ipc.ts. */
  reports: ReportService
  /** Extra error types to recognise — see `IpcDependencies.errorMappers`. */
  errorMappers?: readonly ErrorMapper[]
}

/** Production wiring: Electron on one side, the assembled IPC layer on the other. */
export function createElectronIpcDependencies(options: ElectronIpcOptions): IpcDependencies {
  return {
    transport: createIpcMainTransport(),
    logger: createElectronLogger(),
    system: createElectronSystemEnvironment(),
    companies: options.companies,
    ledger: options.ledger,
    reports: options.reports,
    ...(options.errorMappers === undefined ? {} : { errorMappers: options.errorMappers }),
    /* The registry of companies lives here, so it is revealable from the moment the app
     * starts. Every other path has to be earned — see ./path-access.ts. */
    revealRoots: [app.getPath('userData')],
  }
}

/**
 * Install every IPC handler. Call once, after `app.whenReady()` and before the first
 * window loads. Throws if the contract is not fully covered.
 */
export function installIpcHandlers(options: ElectronIpcOptions): HandlerRegistry {
  return registerIpcHandlers(createElectronIpcDependencies(options))
}
