/*
 * Native modules: make sure the right prebuilt binaries are on disk, and that they
 * load. Runs from `postinstall`, so a contributor who clones and installs finds out
 * immediately rather than at the first unlock screen.
 *
 * Both native dependencies are Node-API (ABI-stable) addons that ship prebuilt
 * binaries, which is the whole reason this file is short:
 *
 *   better-sqlite3-multiple-ciphers  Node-API via node-addon-api. The package tarball
 *                                    itself carries prebuilds/<platform>-<arch>.node
 *                                    for win32, darwin and linux (glibc and musl),
 *                                    x64 and arm64.
 *   @node-rs/argon2                  napi-rs. The binary lives in a per-platform
 *                                    optional dependency, e.g.
 *                                    @node-rs/argon2-win32-x64-msvc.
 *
 * Node-API means one binary satisfies both Node and Electron — there is no ABI
 * recompile step and no C++ toolchain requirement for contributors. What can still go
 * wrong is a binary that is simply absent: `npm install --omit=optional`, a partially
 * extracted cache, or a platform with no published prebuild. So the job here is to
 * verify, repair by re-fetching from the registry, and verify again.
 *
 *   node scripts/native-modules.mjs               verify, repair once if broken
 *   node scripts/native-modules.mjs --electron    also load them in a real Electron main process
 *   node scripts/native-modules.mjs --no-repair   verify only
 *
 * Set COFFER_SKIP_NATIVE_CHECK=1 to skip entirely (offline mirrors, sandboxes).
 *
 * If a future dependency ever needs a genuine ABI-specific rebuild, this is the file
 * that grows the step — nothing else should learn about native binaries.
 */

import process from 'node:process'
import console from 'node:console'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { RESULT_MARKER } from './native-probe.mjs'

const require = createRequire(import.meta.url)
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPTS_DIR, '..')
const PROBE = path.join(SCRIPTS_DIR, 'native-probe.mjs')

/* Packages to re-fetch when a binary is missing. `npm install --no-save` puts them
 * back without touching package.json or the lockfile; --ignore-scripts stops this
 * very script from re-entering itself. */
const REPAIRABLE = ['better-sqlite3-multiple-ciphers', '@node-rs/argon2']

const args = new Set(process.argv.slice(2))
const wantElectron = args.has('--electron')
const allowRepair = !args.has('--no-repair')

function log(line = '') {
  console.log(line === '' ? '' : `[native] ${line}`)
}

/** Run a probe in some runtime and parse the result line it prints. */
function runProbe({ command, argv, label, env }) {
  /* Some editors and agent harnesses export ELECTRON_RUN_AS_NODE. Inheriting it would
   * silently downgrade the Electron main-process check to a plain Node one, which is
   * exactly the check we are trying not to be fooled by. Start clean, then opt in. */
  const childEnv = { ...process.env }
  delete childEnv.ELECTRON_RUN_AS_NODE
  Object.assign(childEnv, env)

  const result = spawnSync(command, argv, { cwd: ROOT, encoding: 'utf8', env: childEnv })

  if (result.error) {
    return { label, ok: false, failure: result.error.message }
  }

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith(RESULT_MARKER))
  if (!line) {
    const tail = output.trim().split(/\r?\n/).slice(-6).join('\n')
    return { label, ok: false, failure: tail || `no output (exit ${result.status})` }
  }

  return { label, ...JSON.parse(line.slice(RESULT_MARKER.length)) }
}

function report(result) {
  log(`${result.label}:`)
  if (result.runtime) {
    const { mode, platform, node, electron, napi } = result.runtime
    const electronPart = electron ? `, electron ${electron}` : ''
    log(`  runtime ${mode} on ${platform} (node ${node}${electronPart}, node-api ${napi})`)
  }
  for (const check of result.checks ?? []) {
    log(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.name} — ${check.detail}`)
  }
  if (result.failure) log(`  FAIL ${result.failure}`)
}

/** Re-fetch the packages that carry the prebuilt binaries. */
function repair() {
  log('a native module did not load — re-fetching its prebuilt binary from the registry')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(
    npm,
    ['install', '--no-save', '--ignore-scripts', '--include=optional', ...REPAIRABLE],
    { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' },
  )
  return result.status === 0
}

/**
 * Locate the Electron binary. `require('electron')` exports its absolute path.
 */
function electronBinary() {
  try {
    return require('electron')
  } catch {
    return null
  }
}

function hasCommand(command) {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  return spawnSync(probe, [command], { encoding: 'utf8' }).status === 0
}

/**
 * Load the modules inside Electron itself.
 *
 * On a headless Linux box a real Electron main process needs a display server, so we
 * borrow xvfb when it is there. Without it we fall back to ELECTRON_RUN_AS_NODE, which
 * still exercises Electron's own Node and V8 build — a weaker check, and it says so.
 */
function verifyUnderElectron() {
  const binary = electronBinary()
  if (typeof binary !== 'string') {
    log('electron is not installed; skipping the Electron-ABI check')
    return null
  }

  const headlessLinux = process.platform === 'linux' && !process.env.DISPLAY
  if (headlessLinux && hasCommand('xvfb-run')) {
    return runProbe({
      command: 'xvfb-run',
      argv: ['--auto-servernum', binary, PROBE, '--no-sandbox'],
      label: 'electron main process (under xvfb)',
    })
  }
  if (headlessLinux) {
    log('no display and no xvfb-run — falling back to Electron-as-Node')
    return runProbe({
      command: binary,
      argv: [PROBE],
      label: "electron's node runtime (no display available)",
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
  }

  return runProbe({ command: binary, argv: [PROBE], label: 'electron main process' })
}

function main() {
  if (process.env.COFFER_SKIP_NATIVE_CHECK) {
    log('COFFER_SKIP_NATIVE_CHECK is set — skipping the native module check')
    return 0
  }

  let node = runProbe({ command: process.execPath, argv: [PROBE], label: 'node' })
  if (!node.ok && allowRepair) {
    report(node)
    if (repair()) {
      node = runProbe({ command: process.execPath, argv: [PROBE], label: 'node (after repair)' })
    }
  }
  report(node)

  if (!node.ok) {
    log()
    log('The native modules are not usable. Coffer cannot open an encrypted company')
    log('database in this state. Try, in order:')
    log('  1. npm ci                        (a clean install, optional deps included)')
    log('  2. npm install --include=optional better-sqlite3-multiple-ciphers @node-rs/argon2')
    log('  3. check that a prebuilt binary is published for this platform and architecture')
    return 1
  }

  if (!wantElectron) return 0

  const electron = verifyUnderElectron()
  if (electron === null) return 0
  report(electron)
  return electron.ok ? 0 : 1
}

process.exit(main())
