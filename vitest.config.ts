import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/*
 * Two projects, because the code under test runs in two different places.
 *
 * `src/main` and `src/preload` are Node. `src/renderer` is a browser — it has a
 * document, a `localStorage`, a `matchMedia` and a `<dialog>` that can `showModal()`.
 * Running renderer tests under the Node environment meant components could not be
 * rendered at all, so the two screens shipped at the 1.1 gate had no test that they
 * render. The logic beneath them was covered as pure functions in `screens/lib`, which
 * is a different claim.
 *
 * The split is by directory rather than by file extension. `*.test.tsx` would be a
 * tempting discriminator — JSX forces the extension, so a component test is necessarily
 * `.tsx` — but the converse does not hold, and a `.ts` test that reaches for `document`
 * would fail with `document is not defined` for reasons that have nothing to do with
 * what it was testing. A renderer test runs in a browser environment because the
 * renderer runs in a browser.
 *
 * WHY happy-dom AND NOT jsdom: `<dialog>` and `matchMedia`, both of which jsdom 30 is
 * missing and this product depends on. Measured in both before choosing — the table is
 * in src/renderer/src/test/setup.ts.
 */

const alias = {
  '@shared': resolve('src/shared'),
  '@main': resolve('src/main'),
  '@renderer': resolve('src/renderer/src'),
}

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'main',
          environment: 'node',
          include: ['src/{main,preload,shared}/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        /* The automatic JSX runtime, so a test file need not import React. Set here
         * rather than inherited: the root tsconfig.json is a solution file with
         * `files: []`, so esbuild finds no `jsx` setting to read. */
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'renderer',
          environment: 'happy-dom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['src/renderer/src/test/setup.ts'],
          /* Vitest hands every stylesheet import back as an empty string, `?raw` included.
           * tokens.css is let through because styles/tokens.test.ts holds its values to the
           * density floors; no other stylesheet is, so no test depends on CSS applying. */
          css: { include: [/styles[\\/]tokens\.css/] },
        },
      },
    ],
    /* Money, tax and posting rules are verified against golden fixtures. A change in
     * rounding or tax behaviour must fail a test — see docs/CONVENTIONS.md §6. */
    coverage: {
      provider: 'v8',
      /* The three modules where a gap costs the most: the pure logic that every figure
       * passes through, the tax rules, and the crypto protecting the books. */
      include: ['src/main/domain/**', 'src/main/regimes/**', 'src/main/security/**'],
      exclude: ['**/*.test.ts', '**/__fixtures__/**', '**/index.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
})
