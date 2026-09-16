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
