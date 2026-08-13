/*
 * Main process entry point.
 *
 * Owns the database, the filesystem, crypto and rendering to PDF. All business logic
 * lives on this side of the IPC boundary — the renderer is untrusted for correctness
 * and never computes money. See docs/ARCHITECTURE.md §4.
 */

import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { BRAND } from '../branding'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: BRAND.name,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      /* Non-negotiable. The renderer gets no Node access and no direct database or
       * filesystem reach; everything crosses through the typed IPC contract. */
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

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

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
