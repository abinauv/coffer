/*
 * What turning HTML into a page needs from the outside world.
 *
 * The seam, and the reason it exists: everything above it — which document, which copies,
 * what goes on them — is decidable without a display, a printer or a filesystem, and is
 * tested that way. Everything below it needs a real Chromium, and lives in ./window.ts,
 * which is the only file under src/main/printing that imports Electron.
 *
 * It is the same shape as `SystemEnvironment` in ../ipc/handlers/system.ts, for the same
 * reason: the hard-to-test part is small enough to read, and the part worth testing does
 * not need an Electron process to run.
 */

/** The size of a preview image, in pixels. */
export interface PreviewImage {
  /** PNG, as a `data:` URI. */
  imageDataUri: string
  widthPx: number
  heightPx: number
}

/**
 * A font the printed page can use, as bytes it carries itself.
 *
 * A `data:` URI rather than a path, because the rendered document must be self-contained:
 * it is handed to `printToPDF` and, later, e-mailed. A stylesheet or a font it has to
 * fetch is one that is missing exactly when it matters (see the header of
 * services/pdf/invoice-styles.ts).
 */
export interface PrintableFont {
  /** The family name the stylesheet will ask for. */
  family: string
  /** `data:font/woff2;base64,…` */
  source: string
}

export interface PagePrinter {
  /**
   * A picture of page one of this document.
   *
   * ONE PAGE. It is a screenshot of the rendered page rather than a rendering of the
   * PDF, so a document that runs to three pages previews its first — the dialog says so.
   */
  preview(html: string): Promise<PreviewImage>

  /**
   * Render the document to one PDF and ask the user where to put it.
   *
   * Answers the path written, or null when the user cancelled. Cancelling is an ordinary
   * outcome and not a failure: nothing was written and nothing is wrong.
   */
  savePdf(html: string, suggestedFileName: string): Promise<string | null>

  /** Hand the document to the operating system's print dialog. */
  print(html: string): Promise<void>

  /**
   * The heading font, if this build can find it.
   *
   * Null rather than a throw: a missing font is a page set in the machine's own serif,
   * which is a worse-looking invoice and a perfectly valid one. Refusing to print over it
   * would be choosing typography over the user's afternoon.
   */
  headingFont(): Promise<PrintableFont | null>
}
