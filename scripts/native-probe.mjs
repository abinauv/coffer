/*
 * Native-module probe.
 *
 * Loads the two native modules Coffer depends on and actually exercises them, then
 * prints a machine-readable result line. It is deliberately written to run unchanged
 * in three different runtimes:
 *
 *   node scripts/native-probe.mjs                  plain Node — the install-time check
 *   electron scripts/native-probe.mjs              a real Electron main process
 *   ELECTRON_RUN_AS_NODE=1 electron …/native-probe.mjs   Electron's Node/V8, no display
 *
 * The middle one is the check that matters: a binary that loads under Node but not
 * under Electron is the classic failure this repo has to stay ahead of.
 *
 * The SQLCipher check does not just require the module — it writes a keyed database,
 * proves the bytes on disk are not a plaintext SQLite file, proves the file cannot be
 * read back without the key, and then proves it can with. "Encrypted at rest" is a
 * non-negotiable in docs/ARCHITECTURE.md §2; this is the cheapest place to notice that
 * it silently stopped being true.
 */

import process from 'node:process'
import console from 'node:console'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

/** Prefix of the single machine-readable line this script prints. */
export const RESULT_MARKER = '#native-probe#'

/** Bytes every unencrypted SQLite database starts with. */
const SQLITE_PLAINTEXT_HEADER = 'SQLite format 3\0'

const PROBE_KEY = 'coffer-native-probe-passphrase'
const PROBE_NOTE = 'encrypted at rest'

/** Which runtime is executing this file, in human terms. */
function describeRuntime() {
  const electron = process.versions.electron
  let mode = 'node'
  if (electron && process.type === 'browser') mode = 'electron-main'
  else if (electron) mode = 'electron-as-node'

  return {
    mode,
    platform: `${process.platform}-${process.arch}`,
    node: process.versions.node,
    electron: electron ?? null,
    /* Node-API version is the ABI contract. Both native modules are Node-API addons,
     * which is why the same binary works under Node and under Electron. */
    napi: process.versions.napi ?? null,
    modules: process.versions.modules,
  }
}

/** Remove a database file, tolerating Windows holding the handle for a moment. */
function removeQuietly(file) {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(file + suffix, { force: true })
        break
      } catch {
        /* Windows can report EBUSY briefly after close; a temp file is not worth failing over. */
      }
    }
  }
}

/**
 * Open a keyed database, write to it, and verify the file is genuinely encrypted.
 */
function checkSqlcipher() {
  const name = 'better-sqlite3-multiple-ciphers'
  const file = path.join(os.tmpdir(), `coffer-native-probe-${process.pid}-${Date.now()}.db`)

  let cipher = null
  try {
    const Database = require(name)

    const db = new Database(file)
    try {
      db.pragma(`key = '${PROBE_KEY}'`)
      cipher = db.pragma('cipher', { simple: true }) ?? null
      db.exec('CREATE TABLE probe (note TEXT NOT NULL)')
      db.prepare('INSERT INTO probe (note) VALUES (?)').run(PROBE_NOTE)
    } finally {
      db.close()
    }

    const header = fs.readFileSync(file).subarray(0, 16).toString('latin1')
    if (header === SQLITE_PLAINTEXT_HEADER) {
      return {
        name,
        ok: false,
        detail: 'the database was written as plaintext SQLite — encryption is not active',
      }
    }

    /* Reading it back without the key must fail. */
    let readableWithoutKey = false
    let unkeyed = null
    try {
      unkeyed = new Database(file, { fileMustExist: true })
      unkeyed.prepare('SELECT note FROM probe').get()
      readableWithoutKey = true
    } catch {
      readableWithoutKey = false
    } finally {
      unkeyed?.close()
    }
    if (readableWithoutKey) {
      return { name, ok: false, detail: 'an unkeyed connection could read the database' }
    }

    /* Reading it back with the key must succeed. */
    const keyed = new Database(file, { fileMustExist: true })
    let note
    try {
      keyed.pragma(`key = '${PROBE_KEY}'`)
      note = keyed.prepare('SELECT note FROM probe').get()?.note
    } finally {
      keyed.close()
    }
    if (note !== PROBE_NOTE) {
      return { name, ok: false, detail: `keyed read returned ${JSON.stringify(note)}` }
    }

    return {
      name,
      ok: true,
      detail: `keyed round-trip via ${cipher ?? 'the default cipher'}, file is not plaintext`,
    }
  } catch (error) {
    return { name, ok: false, detail: describeError(error) }
  } finally {
    removeQuietly(file)
  }
}

/** Hash and verify a passphrase — the Argon2id path used to unlock a company. */
function checkArgon2() {
  const name = '@node-rs/argon2'
  try {
    const argon2 = require(name)
    const digest = argon2.hashSync('coffer-native-probe-passphrase')
    const accepts = argon2.verifySync(digest, 'coffer-native-probe-passphrase')
    const rejects = !argon2.verifySync(digest, 'a different passphrase')
    if (!accepts || !rejects) {
      return { name, ok: false, detail: 'verify did not behave correctly' }
    }
    const params = digest.split('$')[3] ?? 'unknown parameters'
    return { name, ok: true, detail: `argon2id hash and verify (${params})` }
  } catch (error) {
    return { name, ok: false, detail: describeError(error) }
  }
}

function describeError(error) {
  if (error instanceof Error) return error.message.split('\n')[0]
  return String(error)
}

/** Run every check. Returns a plain object safe to JSON round-trip. */
export function probe() {
  const checks = [checkSqlcipher(), checkArgon2()]
  return { runtime: describeRuntime(), checks, ok: checks.every((check) => check.ok) }
}

function isEntryPoint() {
  const entry = process.argv[1]
  if (!entry) return false
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))
}

if (isEntryPoint()) {
  const result = probe()
  for (const check of result.checks) {
    console.log(`  ${check.ok ? 'ok  ' : 'FAIL'}  ${check.name} — ${check.detail}`)
  }
  console.log(RESULT_MARKER + JSON.stringify(result))
  /* Electron's main process will not exit on its own — it has no windows to close. */
  process.exit(result.ok ? 0 : 1)
}
