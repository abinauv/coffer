/*
 * Main process entry point.
 *
 * Owns the database, the filesystem, crypto and rendering to PDF. All business logic
 * lives on this side of the IPC boundary — the renderer is untrusted for correctness
 * and never computes money. See docs/ARCHITECTURE.md §4.
 *
 * Assembly order matters and is enforced below: handlers are installed, and the API
 * surface is proved complete, BEFORE any window exists. A window that loads first would
 * turn a missing handler into a mystery at click time instead of a crash at boot.
 */

import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import log from 'electron-log'
import { BRAND } from '../branding'
import { companies, isCompanyError } from './companies'
import { isRepoError } from './db/repos/errors'
import { assertApiSurfaceComplete } from './ipc'
import { installIpcHandlers } from './ipc/electron'
import { createCompanyProfileService } from './company-profile/service'
import { createDocumentsService } from './documents/service'
import { createLedgerService } from './ledger/service'
import { createPartiesService } from './parties/service'

let mainWindow: BrowserWindow | null = null

/* The title bar is drawn by the renderer, but the window buttons are drawn by the OS.
 * These must match --titlebar-height and the --chrome / --ink-muted tokens in
 * src/renderer/src/styles. */
const TITLEBAR_HEIGHT = 38
const TITLEBAR_OVERLAY = { color: '#eceae4', symbolColor: '#47505f', height: TITLEBAR_HEIGHT }

function installHandlers(): void {
  /* Every Electron call the IPC layer needs is adapted in ./ipc/electron.ts — dialogs,
   * shell, app metadata, the log scope, the reveal roots. The only thing production
   * has to supply is the company service and the mapper for its error codes. */
  const ledger = createLedgerService(companies)

  const registry = installIpcHandlers({
    companies,
    ledger,
    parties: createPartiesService(companies),
    companyProfile: createCompanyProfileService(companies),
    documents: createDocumentsService(companies),
    /* One object, two contract groups: the read-only methods are on the same service,
     * so both point at it. See the note beside them in src/main/ledger/service.ts. */
    reports: ledger,
    /* CompanyError codes are what the company screens branch on, and nothing under
     * src/main/ipc may import that module. Deliberately narrow: the companies module
     * also exports a broader `describeError` that claims DbError too, and DbError
     * messages interpolate file paths that must not reach the renderer.
     *
     * `RepoError` is mapped for the same reason and with the same care: its codes are
     * the ledger's vocabulary — PERIOD_CLOSED, UNBALANCED_ENTRY, ACCOUNT_IS_GROUP — and
     * its messages are written as sentences for a user, never with a path in them. */
    errorMappers: [
      (cause) => (isCompanyError(cause) ? { code: cause.code, message: cause.message } : null),
      (cause) => (isRepoError(cause) ? { code: cause.code, message: cause.message } : null),
    ],
  })

  assertApiSurfaceComplete(registry)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: BRAND.name,
    /* The renderer draws the title bar; the OS still draws the window buttons over it. */
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 11 } }
      : { titleBarOverlay: TITLEBAR_OVERLAY }),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.js'),
      /* Non-negotiable. The renderer gets no Node access and no direct database or
       * filesystem reach; everything crosses through the typed IPC contract.
       * The preload is built as CommonJS so it can load in here — see
       * electron.vite.config.ts. */
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  /* External links open in the user's browser, never in an app window. */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  app.setAppUserModelId(BRAND.appId)

  installHandlers()

  /* A corrupt registry explains itself here and nowhere else — `list()` reports an
   * empty set, which on its own looks like a first run. */
  void companies.registryStatus().then((status) => {
    if (status.problem) log.warn(`Company registry: ${status.problem}`)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/* Closing zeroes key material and releases the database handle. Doing it here rather
 * than on window close means a quit during an open company still leaves a clean file. */
app.on('before-quit', () => {
  void companies.close().catch((cause: unknown) => log.error('Failed to close company', cause))
})
