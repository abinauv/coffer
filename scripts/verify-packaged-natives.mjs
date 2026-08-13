/*
 * electron-builder `afterPack` hook: refuse to ship an installer whose native binaries
 * are for the wrong platform.
 *
 * This is not theoretical. @node-rs/argon2 ships its binary in a per-architecture
 * optional dependency and npm only installs the one matching the machine doing the
 * install — so packaging Linux from a Windows checkout produces a Linux app containing
 * argon2.win32-x64-msvc.node, packages cleanly, and then fails at the unlock screen on
 * the user's machine. That is the worst shape a bug can have: silent at build time,
 * fatal at first use, and only visible to someone who is not you.
 *
 * The release workflow avoids it by building every platform on its own runner. This hook
 * is the guard that notices if that ever stops being true.
 *
 * Wired in from electron-builder.yml as `afterPack`.
 */

import console from 'node:console'
import path from 'node:path'
import fs from 'node:fs'

/* electron-builder's Arch enum, by value. Stable across its major versions; an
 * unrecognised value degrades this check to platform-only rather than failing a build. */
const ARCH_NAMES = new Map([
  [0, 'ia32'],
  [1, 'x64'],
  [2, 'armv7l'],
  [3, 'arm64'],
  [4, 'universal'],
])

/** Where electron-builder puts the unpacked asar for each platform. */
function unpackedRoot(context) {
  const { appOutDir, electronPlatformName } = context
  const productName = context.packager?.appInfo?.productFilename ?? 'Coffer'
  const resources =
    electronPlatformName === 'darwin'
      ? path.join(appOutDir, `${productName}.app`, 'Contents', 'Resources')
      : path.join(appOutDir, 'resources')
  return path.join(resources, 'app.asar.unpacked', 'node_modules')
}

function listDirectory(directory) {
  try {
    return fs.readdirSync(directory)
  } catch {
    return []
  }
}

function containsNodeBinary(directory) {
  return listDirectory(directory).some((entry) => entry.endsWith('.node'))
}

/**
 * better-sqlite3-multiple-ciphers keeps its prebuilds in one flat directory named
 * <platform>-<arch>.node, plus linuxmusl-* variants.
 */
function checkSqlcipher(modules, platform, arches) {
  const directory = path.join(modules, 'better-sqlite3-multiple-ciphers', 'prebuilds')
  const present = listDirectory(directory).filter((name) => name.endsWith('.node'))
  if (present.length === 0) {
    return ['better-sqlite3-multiple-ciphers: no prebuilt binary was packaged at all']
  }

  const prefixes = platform === 'linux' ? ['linux', 'linuxmusl'] : [platform]
  const missing = arches.filter(
    (arch) => !prefixes.some((prefix) => present.includes(`${prefix}-${arch}.node`)),
  )
  if (missing.length > 0) {
    return [
      `better-sqlite3-multiple-ciphers: packaged ${present.join(', ')}, but this build ` +
        `needs ${platform} ${missing.join(' and ')}`,
    ]
  }
  return []
}

/**
 * @node-rs/argon2 resolves at runtime to a sibling package named
 * argon2-<platform>-<arch>[-gnu|-musl|-msvc].
 */
function checkArgon2(modules, platform, arches) {
  const scope = path.join(modules, '@node-rs')
  const packages = listDirectory(scope).filter((name) => name.startsWith('argon2-'))
  const withBinary = packages.filter((name) => containsNodeBinary(path.join(scope, name)))

  if (withBinary.length === 0) {
    return ['@node-rs/argon2: no platform binary package was packaged']
  }

  const missing = arches.filter(
    (arch) =>
      !withBinary.some(
        (name) =>
          name === `argon2-${platform}-${arch}` || name.startsWith(`argon2-${platform}-${arch}-`),
      ),
  )
  if (missing.length > 0) {
    return [
      `@node-rs/argon2: packaged ${withBinary.join(', ')}, but this build needs ` +
        `${platform} ${missing.join(' and ')}`,
    ]
  }
  return []
}

export default async function verifyPackagedNatives(context) {
  const platform = context.electronPlatformName
  const archName = ARCH_NAMES.get(context.arch)
  const modules = unpackedRoot(context)

  if (!fs.existsSync(modules)) {
    console.warn(
      `[packaged-natives] no app.asar.unpacked/node_modules under ${modules} — skipping. ` +
        'If asarUnpack changed, this check needs updating.',
    )
    return
  }

  if (archName === undefined) {
    console.warn(
      `[packaged-natives] unrecognised architecture ${context.arch} — checking platform only`,
    )
  }

  const arches = archName === 'universal' ? ['x64', 'arm64'] : archName ? [archName] : []

  const problems = [
    ...checkSqlcipher(modules, platform, arches),
    ...checkArgon2(modules, platform, arches),
  ]

  if (problems.length > 0) {
    throw new Error(
      `Native binaries in this ${platform}-${archName ?? context.arch} build are wrong:\n` +
        problems.map((problem) => `  - ${problem}`).join('\n') +
        '\n\nThis app would install and then fail to open a company database. Build each ' +
        'platform on its own machine (npm installs only the binaries for the host), or run ' +
        '`npm ci` on a matching platform first.',
    )
  }

  console.log(
    `[packaged-natives] ok — ${platform} ${archName ?? context.arch} binaries present for ` +
      'better-sqlite3-multiple-ciphers and @node-rs/argon2',
  )
}
