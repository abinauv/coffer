/*
 * Refuse to ship an installer whose asar holds more than the application (B1).
 *
 * The bug this exists after: every platform's `files` list in electron-builder.yml held
 * nothing but exclusions, a platform list REPLACES the shared one rather than adding to
 * it, and a list whose first pattern is a negation makes electron-builder prepend `**\/*`.
 * So each installer packed the whole repository — src/ with every test and fixture,
 * docs/, scripts/, coverage/ and dist/ — in a 29.6 MB archive, and packaged cleanly
 * while doing it. That is the shape of packaging bug nobody notices: the app works.
 *
 * WHY A CHECK AND NOT JUST THE FIX. The fix is three lines repeated in three blocks, and
 * the next platform added is the next chance to forget them. `scripts/packaging.test.mjs`
 * reads the config and catches that at commit time; this reads the ARCHIVE THAT WAS
 * ACTUALLY BUILT, which is the only thing that settles what shipped.
 *
 * THE ASAR HEADER IS READ HERE RATHER THAN WITH A LIBRARY. `@electron/asar` is a
 * transitive dependency of electron-builder, not one this project declares, and adding a
 * dependency to read four integers and a JSON string is not a trade worth making. The
 * format is stable and documented: a pickle of four little-endian uint32s, the last of
 * which is the length of the JSON directory that follows.
 */

import { Buffer } from 'node:buffer'
import console from 'node:console'
import fs from 'node:fs'
import path from 'node:path'

/** What an installer is allowed to carry inside app.asar, at the top level. */
const ALLOWED = new Set(['out', 'package.json', 'node_modules'])

/** Where electron-builder puts the archive for each platform. */
function asarPath(context) {
  const { appOutDir, electronPlatformName } = context
  const productName = context.packager?.appInfo?.productFilename ?? 'Coffer'
  const resources =
    electronPlatformName === 'darwin'
      ? path.join(appOutDir, `${productName}.app`, 'Contents', 'Resources')
      : path.join(appOutDir, 'resources')
  return path.join(resources, 'app.asar')
}

/** The asar's directory listing: four uint32s, then JSON of that length. */
export function readAsarTopLevel(file) {
  const handle = fs.openSync(file, 'r')
  try {
    const pickle = Buffer.alloc(16)
    fs.readSync(handle, pickle, 0, 16, 0)
    const jsonSize = pickle.readUInt32LE(12)
    const json = Buffer.alloc(jsonSize)
    fs.readSync(handle, json, 0, jsonSize, 16)
    const tree = JSON.parse(json.toString('utf8'))
    return Object.keys(tree.files ?? {})
  } finally {
    fs.closeSync(handle)
  }
}

export default function verifyPackagedFiles(context) {
  const file = asarPath(context)
  if (!fs.existsSync(file)) {
    /* `asar: false` is a legitimate configuration, and this check has nothing to read
     * under it. Said out loud rather than passed silently. */
    console.warn(`[packaged-files] no app.asar at ${file} — skipping.`)
    return
  }

  const entries = readAsarTopLevel(file)
  const extra = entries.filter((entry) => !ALLOWED.has(entry)).sort()
  const size = fs.statSync(file).size

  if (extra.length > 0) {
    throw new Error(
      `app.asar carries ${String(extra.length)} thing(s) that are not the application:\n` +
        extra.map((entry) => `  - ${entry}`).join('\n') +
        `\n\nOnly ${[...ALLOWED].join(', ')} belong in it. This is B1: check that every ` +
        '`files` list in electron-builder.yml starts with the shared patterns rather than ' +
        'with an exclusion — a list that starts with `!` means "everything, except".',
    )
  }

  console.log(
    `[packaged-files] ok — app.asar carries only ${entries.sort().join(', ')} ` +
      `(${String(Math.round(size / 1024 / 1024))} MB)`,
  )
}
