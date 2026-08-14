import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/* Three builds from one config: main (node), preload (sandboxed bridge), renderer (web).
 * `externalizeDepsPlugin` keeps native modules out of the bundle — better-sqlite3 and
 * argon2 are loaded at runtime from node_modules, not bundled. */

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        /* CommonJS, not ESM, and this is not a preference.
         *
         * A sandboxed preload is not a real ES module context: Electron loads it with a
         * restricted CommonJS-ish loader, so an `.mjs` preload dies on `Cannot use
         * import statement outside a module`, `contextBridge` never runs, and
         * `window.coffer` is silently undefined — the renderer looks broken with no
         * error pointing here. Verified both ways: CJS works with `sandbox: true`.
         *
         * The fix is NOT to disable the sandbox. See src/main/index.ts. */
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer/src'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
    },
  },
})
