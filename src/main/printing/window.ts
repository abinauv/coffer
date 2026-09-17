/*
 * The only file under src/main/printing that touches Electron.
 *
 * ---------------------------------------------------------------------------
 *  THE WINDOW THE PAGE IS RENDERED IN
 * ---------------------------------------------------------------------------
 *
 * A rendered invoice is HTML built from a user's own data: a party's name, a line
 * description, a narration, a registration number. `services/pdf` escapes every one of
 * them and its own tests hold that. This window assumes it did not.
 *
 *   javascript: false      Nothing on the page can run. This is the one that makes the
 *                          rest belt-and-braces: a script that cannot execute cannot
 *                          reach anything, however it got onto the page.
 *   sandbox: true          The renderer process has no Node.
 *   contextIsolation       No preload is set at all, so there is no bridge to isolate
 *                          from — but the flag stays on, because a preload added later
 *                          by somebody who did not read this comment should still land
 *                          in an isolated world.
 *   webSecurity: true      Default, stated. The page is served over a scheme of its own
 *                          with a CSP that permits nothing but its own inline style and
 *                          `data:` images.
 *   offscreen: false       `capturePage` needs a real compositor. Offscreen rendering
 *                          would be tidier and produces blank frames on some Linux
 *                          setups, which is a worse failure than a window nobody sees.
 *
 * It is never shown, never reused between documents, and always destroyed — including
 * when the render throws, which is what the `finally` is for.
 *
 * ---------------------------------------------------------------------------
 *  WHY A PROTOCOL AND NOT A FILE, AND NOT A data: URL
 * ---------------------------------------------------------------------------
 *
 * A temporary file would put an unencrypted invoice on the user's disk, which is the one
 * thing this product promises not to do. A `data:` URL avoids that but has a length limit
 * a forty-line invoice can reach, and the failure is a blank page rather than an error.
 *
 * So the HTML is served from memory over a scheme registered for this purpose, in a
 * session partition of its own that shares no cache, no cookies and no storage with the
 * application. The handler answers exactly one URL, once, for the page it was created
 * for — anything else gets a 404, so a page that somehow tried to fetch its neighbour
 * would get nothing.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, dialog, session } from 'electron'
import { BRAND } from '../../branding'
import { PrintError } from '../services/pdf'
import type { PagePrinter, PreviewImage, PrintableFont } from './page-printer'

/**
 * The scheme the page is served over.
 *
 * Registered as privileged at startup — see `printSchemePrivileges`, which src/main/index.ts
 * hands to `protocol.registerSchemesAsPrivileged` before the app is ready. Scheme
 * privileges are fixed at that point and cannot be added later.
 */
const PRINT_SCHEME = 'coffer-print'

/** A4 at 96 CSS pixels per inch: 210mm x 297mm. What the preview is captured at. */
const A4_WIDTH_PX = 794
const A4_HEIGHT_PX = 1123

/** The heading face, and the family the stylesheet asks for. */
const HEADING_FONT_FILE = 'IBMPlexSerif-SemiBold.woff2'
const HEADING_FONT_FAMILY = 'Coffer Print Serif'

/**
 * Nothing but this page's own inline style and the images it carries.
 *
 * No script (belt to `javascript: false`'s braces), no network of any kind, and no frame
 * — so a page that somehow contained a `<script>` or an `<img src=http…>` would be
 * refused by the browser as well as being unable to run it.
 */
const PRINT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; " +
  "form-action 'none'; base-uri 'none'; frame-ancestors 'none'"

/**
 * Tell Chromium that `coffer-print:` is a normal, secure origin.
 *
 * Must run before the app is ready. Without `standard`, the page has an opaque origin and
 * the CSP below is applied to a document the browser considers to be from nowhere; without
 * `secure`, it is treated as insecure content.
 */
export function printSchemePrivileges(): { scheme: string; privileges: Record<string, boolean> } {
  return {
    scheme: PRINT_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false },
  }
}

export function createElectronPagePrinter(): PagePrinter {
  return {
    async preview(html) {
      return withPage(html, async (window) => {
        const image = await window.webContents.capturePage()
        const size = image.getSize()
        return {
          imageDataUri: image.toDataURL(),
          widthPx: size.width,
          heightPx: size.height,
        } satisfies PreviewImage
      })
    },

    async savePdf(html, suggestedFileName) {
      /*
       * ASKED BEFORE ANYTHING IS RENDERED. A user who cancels should not have waited for
       * three pages to be laid out, and a dialog that appears after a pause reads as the
       * app having done something already.
       */
      const parent = parentWindow()
      const chosen = await (parent === null
        ? dialog.showSaveDialog(SAVE_OPTIONS(suggestedFileName))
        : dialog.showSaveDialog(parent, SAVE_OPTIONS(suggestedFileName)))
      if (chosen.canceled || chosen.filePath === undefined || chosen.filePath === '') return null

      const pdf = await withPage(html, (window) => window.webContents.printToPDF(PDF_OPTIONS))
      await writeFile(chosen.filePath, pdf)
      return chosen.filePath
    },

    async print(html) {
      await withPage(html, (window) => printOne(window))
    },

    headingFont,
  }
}

// ---- The window -------------------------------------------------------------

/**
 * Render one page and hand the window to `use`, then destroy it.
 *
 * The window is destroyed whatever happens, including when `use` throws. A leaked hidden
 * window holds a renderer process for the life of the application, and printing is the
 * kind of thing somebody does forty times in an afternoon.
 */
async function withPage<T>(html: string, use: (window: BrowserWindow) => Promise<T>): Promise<T> {
  const partition = `${PRINT_SCHEME}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const pageSession = session.fromPartition(partition, { cache: false })
  const url = `${PRINT_SCHEME}://page/index.html`

  pageSession.protocol.handle(PRINT_SCHEME, (request) =>
    request.url === url
      ? new Response(html, {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': PRINT_CSP,
          },
        })
      : new Response('', { status: 404 }),
  )

  const window = new BrowserWindow({
    show: false,
    width: A4_WIDTH_PX,
    height: A4_HEIGHT_PX,
    webPreferences: {
      session: pageSession,
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      /* The page is a document, not an application: nothing may open a window or leave
       * the one URL it was given, whatever it contains. */
      disableDialogs: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  try {
    await window.loadURL(url)
    /* `loadURL` resolves when the document has loaded; the font it carries may not have
     * been laid out yet, and a capture taken then is set in the fallback serif. */
    await settle()
    return await use(window)
  } catch (cause) {
    throw new PrintError(
      'PRINT_FAILED',
      'The page was built but could not be rendered. Try again, and if it happens twice, ' +
        'report it with the document number — the details are in the application log.',
      { cause },
    )
  } finally {
    pageSession.protocol.unhandle(PRINT_SCHEME)
    if (!window.isDestroyed()) window.destroy()
  }
}

/**
 * One frame's grace before the page is measured.
 *
 * `javascript: false` means the usual way of asking the document whether its fonts have
 * loaded is not available, so this waits instead. It is the one piece of timing in the
 * module and it is here rather than hidden in a caller.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 120))
}

/** `webContents.print` is callback-style and reports a cancelled dialog as a failure. */
function printOne(window: BrowserWindow): Promise<void> {
  return new Promise((resolve, reject) => {
    window.webContents.print({ silent: false, printBackground: true }, (success, reason) => {
      /* A user who closed the print dialog has not hit an error. Only a real failure
       * carries a reason, and `cancelled` is the string Electron uses for the other. */
      if (success || reason === 'cancelled' || reason === '') resolve()
      else reject(new Error(reason))
    })
  })
}

function SAVE_OPTIONS(defaultPath: string): Electron.SaveDialogOptions {
  return {
    title: `Save ${BRAND.name} PDF`,
    defaultPath,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  }
}

const PDF_OPTIONS = {
  pageSize: 'A4',
  printBackground: true,
  /* The stylesheet's own `@page` margins lay the document out. A second set here would
   * inset the whole thing again — see the header of services/pdf/invoice-styles.ts. */
  margins: { top: 0, bottom: 0, left: 0, right: 0 },
} as const

function parentWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

// ---- The heading font --------------------------------------------------------

let cachedFont: PrintableFont | null | undefined

/**
 * The bundled Plex Serif face, as bytes the page carries.
 *
 * IT IS THE RENDERER'S OWN COPY, not a second one committed for printing. The build gives
 * it a content-hashed name, so the packaged path is found by prefix; in development the
 * renderer is served by Vite and nothing has been emitted, so the source tree answers
 * instead. Null when neither does — the page then falls back to the machine's serif,
 * which is a worse-looking invoice and a perfectly valid one.
 */
async function headingFont(): Promise<PrintableFont | null> {
  if (cachedFont !== undefined) return cachedFont
  cachedFont = await findFont()
  return cachedFont
}

async function findFont(): Promise<PrintableFont | null> {
  const stem = HEADING_FONT_FILE.replace(/\.woff2$/, '')
  const candidates = [
    /* Built: out/renderer/assets/IBMPlexSerif-SemiBold-<hash>.woff2 */
    async (): Promise<string | null> => {
      const directory = join(import.meta.dirname, '../renderer/assets')
      const entries = await readdir(directory).catch(() => null)
      const match = entries?.find((name) => name.startsWith(stem) && name.endsWith('.woff2'))
      return match === undefined || match === null ? null : join(directory, match)
    },
    /* Development: the source tree, where Vite is serving from. */
    async (): Promise<string | null> =>
      join(process.cwd(), 'src/renderer/src/assets/fonts', HEADING_FONT_FILE),
  ]

  for (const candidate of candidates) {
    const path = await candidate()
    if (path === null) continue
    const bytes = await readFile(path).catch(() => null)
    if (bytes === null) continue
    return {
      family: HEADING_FONT_FAMILY,
      source: `data:font/woff2;base64,${bytes.toString('base64')}`,
    }
  }
  return null
}
