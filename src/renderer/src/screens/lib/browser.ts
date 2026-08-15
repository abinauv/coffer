/*
 * The three things the recovery sheet needs from the platform: copy, save, print.
 *
 * Deliberately thin. Everything decided lives in ./recovery-sheet.ts, which is tested;
 * this file is the part that touches the DOM and cannot be, so it holds no rules — only
 * the calls, each with the fallback that stops a failure from being silent. A user who
 * believes they saved their codes and did not is the worst outcome this screen has.
 *
 * There is no `system.writeTextFile` in the IPC contract, so saving goes through the
 * browser's own download path (an anchor with `download`), which Electron turns into a
 * native save dialog. Noted in the batch report as a gap worth closing.
 */

/**
 * Copies text, and says whether it worked.
 *
 * `navigator.clipboard` is the modern path and is not always available; the selection
 * fallback is ugly and works everywhere. The textarea is off-screen, read-only to the
 * user, and removed immediately — the codes are never left in the document.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* Fall through to the selection path rather than reporting failure early. */
  }

  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', 'true')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    area.style.pointerEvents = 'none'
    document.body.append(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  } catch {
    return false
  }
}

/**
 * Offers text to the user as a file to save.
 *
 * Returns false when the anchor could not even be created — not when the user cancels the
 * save dialog, which the page never learns about. The copy around the button is written
 * with that in mind: it says what was offered, never that a file was written.
 */
export function offerTextDownload(fileName: string, text: string): boolean {
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.style.display = 'none'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    /* Revoked on the next turn: revoking synchronously can beat the download starting. */
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
    return true
  } catch {
    return false
  }
}

/**
 * Prints the page.
 *
 * The print stylesheet in screens.css hides everything except the sheet itself, so this
 * prints a recovery sheet rather than a screenshot of the application. Opening a second
 * window to print from is not an option: main denies `window.open` and sends the URL to
 * the user's browser instead (src/main/index.ts).
 */
export function printPage(): boolean {
  try {
    window.print()
    return true
  } catch {
    return false
  }
}
