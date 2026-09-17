import { beforeEach, describe, expect, it, vi } from 'vitest'

/* Electron is a native binary with no importable implementation under Vitest, and
 * `electron-log` reaches for the app's paths on load. Both are replaced wholesale; this
 * file is the one module in the IPC layer that needs them at all. */
const electron = vi.hoisted(() => ({
  app: {
    getVersion: vi.fn(() => '1.2.3'),
    getPath: vi.fn(() => 'C:\\Users\\ada\\AppData\\Roaming\\Coffer'),
    isPackaged: true,
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn<() => object | null>(() => null),
    getAllWindows: vi.fn<() => object[]>(() => []),
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
  },
  ipcMain: { handle: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
}))

vi.mock('electron', () => electron)
vi.mock('electron-log/main', () => ({
  default: { scope: () => ({ warn: vi.fn(), error: vi.fn() }) },
}))

const {
  createElectronSystemEnvironment,
  createIpcMainTransport,
  createElectronIpcDependencies,
  toPlatform,
} = await import('./electron')

beforeEach(() => {
  vi.clearAllMocks()
  electron.app.isPackaged = true
  electron.BrowserWindow.getFocusedWindow.mockReturnValue(null)
  electron.BrowserWindow.getAllWindows.mockReturnValue([])
  electron.dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
})

describe('toPlatform', () => {
  it.each([
    ['win32', 'win32'],
    ['darwin', 'darwin'],
    ['linux', 'linux'],
  ] as const)('maps %s through unchanged', (input, expected) => {
    expect(toPlatform(input)).toBe(expected)
  })

  it('treats any other Unix as Linux', () => {
    expect(toPlatform('freebsd')).toBe('linux')
  })
})

describe('createIpcMainTransport', () => {
  it('registers the channel with ipcMain', () => {
    createIpcMainTransport().handle('system:getAppInfo', async () => ({ ok: true, data: null }))

    expect(electron.ipcMain.handle).toHaveBeenCalledWith('system:getAppInfo', expect.any(Function))
  })

  it('hands the handler the arguments only, never the sender', async () => {
    const listener = vi.fn(async () => ({ ok: true as const, data: null }))
    createIpcMainTransport().handle('companies:rename', listener)

    const registered = electron.ipcMain.handle.mock.calls[0]?.[1] as (
      event: unknown,
      ...args: unknown[]
    ) => Promise<unknown>
    await registered({ sender: 'a webContents' }, 'acme', 'Acme Pvt Ltd')

    expect(listener).toHaveBeenCalledExactlyOnceWith(['acme', 'Acme Pvt Ltd'])
  })
})

describe('createElectronSystemEnvironment — appInfo', () => {
  it('reports the app version and the branded name', () => {
    const info = createElectronSystemEnvironment().appInfo()

    expect(info.name).toBe('Coffer')
    expect(info.version).toBe('1.2.3')
  })

  it('is not development when the app is packaged', () => {
    expect(createElectronSystemEnvironment().appInfo().isDevelopment).toBe(false)
  })

  it('is development when it is not', () => {
    electron.app.isPackaged = false

    expect(createElectronSystemEnvironment().appInfo().isDevelopment).toBe(true)
  })
})

describe('createElectronSystemEnvironment — dialogs', () => {
  it('returns null when the user cancels', async () => {
    await expect(createElectronSystemEnvironment().chooseDirectory()).resolves.toBeNull()
  })

  it('returns null when a dialog reports success with no paths', async () => {
    electron.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] })

    await expect(createElectronSystemEnvironment().chooseDirectory()).resolves.toBeNull()
  })

  it('returns the chosen directory', async () => {
    electron.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/books'] })

    await expect(createElectronSystemEnvironment().chooseDirectory()).resolves.toBe('/books')
  })

  it('asks for a directory, not a file', async () => {
    await createElectronSystemEnvironment().chooseDirectory()

    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ properties: ['openDirectory', 'createDirectory'] }),
    )
  })

  it('asks for a single file when picking a backup archive', async () => {
    await createElectronSystemEnvironment().chooseBackupArchive()

    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ properties: ['openFile'] }),
    )
  })

  it('hangs the dialog off a window when there is one', async () => {
    const window = { id: 1 }
    electron.BrowserWindow.getFocusedWindow.mockReturnValue(window)

    await createElectronSystemEnvironment().chooseDirectory()

    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(window, expect.any(Object))
  })

  it('falls back to any open window when none has focus', async () => {
    const window = { id: 2 }
    electron.BrowserWindow.getAllWindows.mockReturnValue([window])

    await createElectronSystemEnvironment().chooseDirectory()

    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(window, expect.any(Object))
  })
})

describe('createElectronSystemEnvironment — the filesystem', () => {
  it('reveals a path through the shell', async () => {
    await createElectronSystemEnvironment().revealPath('/books/acme.coffer')

    expect(electron.shell.showItemInFolder).toHaveBeenCalledWith('/books/acme.coffer')
  })

  it('reports a path that exists', async () => {
    await expect(createElectronSystemEnvironment().pathExists(import.meta.filename)).resolves.toBe(
      true,
    )
  })

  it('reports a path that does not', async () => {
    await expect(
      createElectronSystemEnvironment().pathExists(`${import.meta.filename}.missing`),
    ).resolves.toBe(false)
  })
})

describe('createElectronIpcDependencies', () => {
  it('seeds the reveal allowlist with the application data directory', () => {
    const dependencies = createElectronIpcDependencies({
      companies: {} as never,
      ledger: {} as never,
      parties: {} as never,
      items: {} as never,
      units: {} as never,
      numbering: {} as never,
      companyProfile: {} as never,
      documents: {} as never,
      printing: {} as never,
      receipts: {} as never,
      regime: {} as never,
      reports: {} as never,
      taxReturns: {} as never,
    })

    expect(dependencies.revealRoots).toEqual(['C:\\Users\\ada\\AppData\\Roaming\\Coffer'])
    expect(electron.app.getPath).toHaveBeenCalledWith('userData')
  })

  it('passes the company service straight through', () => {
    const companies = { list: vi.fn() } as never

    expect(
      createElectronIpcDependencies({
        companies,
        ledger: {} as never,
        parties: {} as never,
        items: {} as never,
        units: {} as never,
        numbering: {} as never,
        companyProfile: {} as never,
        documents: {} as never,
        printing: {} as never,
        receipts: {} as never,
        regime: {} as never,
        reports: {} as never,
        taxReturns: {} as never,
      }).companies,
    ).toBe(companies)
  })

  it('passes error mappers through when there are any', () => {
    const errorMappers = [() => null]

    expect(
      createElectronIpcDependencies({
        companies: {} as never,
        ledger: {} as never,
        parties: {} as never,
        items: {} as never,
        units: {} as never,
        numbering: {} as never,
        companyProfile: {} as never,
        documents: {} as never,
        printing: {} as never,
        receipts: {} as never,
        regime: {} as never,
        reports: {} as never,
        taxReturns: {} as never,
        errorMappers,
      }).errorMappers,
    ).toBe(errorMappers)
  })

  it('leaves error mappers absent when there are none', () => {
    expect(
      createElectronIpcDependencies({
        companies: {} as never,
        ledger: {} as never,
        parties: {} as never,
        items: {} as never,
        units: {} as never,
        numbering: {} as never,
        companyProfile: {} as never,
        documents: {} as never,
        printing: {} as never,
        receipts: {} as never,
        regime: {} as never,
        reports: {} as never,
        taxReturns: {} as never,
      }),
    ).not.toHaveProperty('errorMappers')
  })
})
