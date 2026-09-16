/*
 * electron-builder's `afterPack` hook: everything that has to be true of a packaged app
 * before an installer is built from it.
 *
 * One hook, because electron-builder takes one. Each check is its own module with its own
 * reasoning; this file only decides the order and lets the first failure stop the build.
 *
 *   verify-packaged-natives  the native binaries are for the platform being built
 *   verify-packaged-files    the asar holds the application and nothing else (B1)
 */

import verifyPackagedNatives from './verify-packaged-natives.mjs'
import verifyPackagedFiles from './verify-packaged-files.mjs'

export default async function verifyPackagedApp(context) {
  await verifyPackagedNatives(context)
  verifyPackagedFiles(context)
}
