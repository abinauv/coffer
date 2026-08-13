/*
 * SHA-256 checksums for release artefacts.
 *
 * Coffer ships unsigned (docs/ARCHITECTURE.md §6.5, SECURITY.md). That makes the
 * checksum file the only integrity signal a download has: it is what lets someone
 * confirm the installer they got is the one CI built. Treat it as a release artefact
 * in its own right, not a nicety.
 *
 *   node scripts/checksums.mjs dist
 *   node scripts/checksums.mjs dist --out dist/SHA256SUMS.txt
 *
 * Output is the format `sha256sum -c` and `shasum -a 256 -c` accept:
 *
 *   <64 hex chars><two spaces><file name>
 */

import process from 'node:process'
import console from 'node:console'
import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'

const DEFAULT_OUTPUT = 'SHA256SUMS.txt'

/* Build by-products that are never attached to a release. Everything else in the
 * directory gets hashed — "every artefact on the release page has a checksum" is only a
 * useful promise if there is no quiet exception to it. */
const IGNORED_NAMES = new Set(['builder-debug.yml', 'builder-effective-config.yaml', '.DS_Store'])

function parseArgs(argv) {
  const positional = []
  let out = null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--out') {
      i += 1
      out = argv[i] ?? null
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length)
    } else {
      positional.push(arg)
    }
  }
  return { directory: positional[0] ?? 'dist', out }
}

/** Every file directly inside `directory` that a user might actually download. */
function artefactsIn(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => !IGNORED_NAMES.has(name))
    .filter((name) => name !== DEFAULT_OUTPUT)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

function sha256(file) {
  const hash = createHash('sha256')
  hash.update(fs.readFileSync(file))
  return hash.digest('hex')
}

function main() {
  const { directory, out } = parseArgs(process.argv.slice(2))

  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    console.error(`[checksums] not a directory: ${directory}`)
    return 1
  }

  const names = artefactsIn(directory)
  if (names.length === 0) {
    console.error(`[checksums] no artefacts found in ${directory}`)
    return 1
  }

  const lines = names.map((name) => `${sha256(path.join(directory, name))}  ${name}`)
  const contents = `${lines.join('\n')}\n`

  const outputPath = out ?? path.join(directory, DEFAULT_OUTPUT)
  fs.writeFileSync(outputPath, contents, 'utf8')

  process.stdout.write(contents)
  console.error(`[checksums] ${names.length} artefact(s) hashed into ${outputPath}`)
  return 0
}

process.exit(main())
