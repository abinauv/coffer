/*
 * The packaging configuration, read as text (B1).
 *
 * WHAT THIS CATCHES THAT A BUILD DOES NOT. Every platform's `files` list held nothing but
 * exclusions, and electron-builder answers a list that begins with a negation by
 * prepending `**\/*` — so each installer packed the whole repository and built cleanly
 * while doing it. The afterPack hook now fails a build that does that, but a build is a
 * slow, platform-specific thing to run; this runs in `npm run verify` on every commit.
 *
 * YAML IS PARSED HERE BY HAND, deliberately. The repository has no YAML parser among its
 * dependencies and does not need one for four lists: the reader below understands exactly
 * the shape this file is written in — two-space indentation, `key:` then `- item` — and
 * throws on anything it does not recognise rather than guessing.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const config = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')

/** The three patterns every `files` list has to start with. */
const BASE = ['out/**/*', 'package.json', '!**/*.map']

/**
 * Every `files:` list in the file, with the indentation it was written at.
 *
 * Indentation is how a platform block is told from the shared one: the top-level list is
 * at column 0, and `win:`, `mac:` and `linux:` hold theirs at two spaces.
 */
function fileLists() {
  const lines = config.split('\n')
  const lists = []

  lines.forEach((line, index) => {
    const match = /^(\s*)files:\s*$/.exec(line)
    if (match === null) return
    const indent = (match[1] ?? '').length
    const items = []

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = lines[cursor] ?? ''
      if (next.trim() === '' || next.trimStart().startsWith('#')) continue
      const item = new RegExp(`^\\s{${String(indent + 2)}}- (.+)$`).exec(next)
      if (item === null) break
      items.push((item[1] ?? '').replace(/^'(.*)'$/, '$1'))
    }

    lists.push({ indent, items })
  })

  return lists
}

test('every files list starts with the shared patterns', () => {
  const lists = fileLists()
  /* The shared one, plus win, mac and linux. A platform added without a `files` list of
   * its own inherits the shared one and is fine; one added WITH a list has to be here. */
  assert.equal(lists.length, 4, 'expected one shared files list and one per platform')

  for (const list of lists) {
    assert.deepEqual(
      list.items.slice(0, BASE.length),
      BASE,
      `a files list starts with ${JSON.stringify(list.items.slice(0, BASE.length))}. ` +
        'A platform list REPLACES the shared one, and a list beginning with an exclusion ' +
        'means "everything in the repository, except" — which is B1.',
    )
  }
})

test('no files list begins with an exclusion', () => {
  for (const list of fileLists()) {
    assert.ok(
      !(list.items[0] ?? '').startsWith('!'),
      `a files list begins with ${String(list.items[0])}: electron-builder prepends **/* to it`,
    )
  }
})

test('the platform lists add only exclusions to the shared ones', () => {
  for (const list of fileLists()) {
    for (const extra of list.items.slice(BASE.length)) {
      assert.ok(
        extra.startsWith('!'),
        `a platform files list adds ${extra}, which is not an exclusion. Anything that ` +
          'has to be packaged belongs in the shared list, where every platform gets it.',
      )
    }
  }
})

test('the packaged-app hook is the one wired into afterPack', () => {
  assert.match(config, /^afterPack: \.\/scripts\/verify-packaged-app\.mjs$/m)
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'verify-packaged-app.mjs')))
})

/*
 * THE INSTALLER ARTWORK, READ AS BYTES.
 *
 * electron-builder picks these four up by name from build/, and a wrong one fails late: a
 * BMP NSIS cannot load stops the Windows installer compiling on the release runner, and a
 * disk-image background of the wrong size gives a Mac window of the wrong size. Neither is
 * built by `npm run verify`, so the headers are checked here. They are rendered by
 * `npm run brand:assets`, which writes them in exactly this form.
 */

function bmpHeader(file) {
  const bytes = fs.readFileSync(path.join(root, 'build', file))
  return {
    magic: bytes.toString('ascii', 0, 2),
    size: bytes.readUInt32LE(2),
    length: bytes.length,
    width: bytes.readInt32LE(18),
    height: bytes.readInt32LE(22),
    bitsPerPixel: bytes.readUInt16LE(28),
    compression: bytes.readUInt32LE(30),
  }
}

function pngSize(file) {
  const bytes = fs.readFileSync(path.join(root, 'build', file))
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG', `${file} is not a PNG`)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

test('the Windows installer images are uncompressed 24-bit BMPs of the sizes NSIS draws', () => {
  for (const [file, width, height] of [
    ['installerSidebar.bmp', 164, 314],
    ['installerHeader.bmp', 150, 57],
  ]) {
    const header = bmpHeader(file)
    assert.equal(header.magic, 'BM', `${file} is not a BMP`)
    assert.equal(header.size, header.length, `${file} says it is a different size than it is`)
    /* Positive height: bottom-up rows, which is what every BMP reader accepts. */
    assert.deepEqual(
      { width: header.width, height: header.height },
      { width, height },
      `${file} is not ${String(width)} × ${String(height)}`,
    )
    assert.equal(header.bitsPerPixel, 24, `${file} is not 24-bit`)
    assert.equal(header.compression, 0, `${file} is compressed`)
  }
})

test('the disk-image background and its Retina pair are 540 × 380 and twice that', () => {
  assert.deepEqual(pngSize('background.png'), { width: 540, height: 380 })
  assert.deepEqual(pngSize('background@2x.png'), { width: 1080, height: 760 })
})
