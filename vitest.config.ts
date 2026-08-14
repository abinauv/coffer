import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
      '@renderer': resolve('src/renderer/src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
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
