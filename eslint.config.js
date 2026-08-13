import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/* Import restrictions that enforce the structural rules in docs/CONVENTIONS.md.
 * These are linted rather than left to review because they are the constraints that
 * are cheapest to violate accidentally and most expensive to unwind later. */

const PURE_DOMAIN = {
  group: ['electron', 'node:fs', 'node:fs/*', 'fs', 'fs/*', 'node:path', 'path'],
  message: 'src/main/domain must stay pure — no I/O. Take the data as an argument instead.',
}

const NO_PERSISTENCE = {
  group: ['**/db/**', '**/services/**', '**/ipc/**'],
  message: 'src/main/domain must not depend on persistence or transport. Invert the dependency.',
}

const NO_CONCRETE_REGIME = {
  group: ['**/regimes/in-*/**'],
  message:
    'Depend on the TaxRegime interface, not a concrete regime. Tax logic lives only in regimes/.',
}

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'out/**', 'dist/**', 'release/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      /* CONVENTIONS.md §1.4 — `any` is not permitted. Use `unknown` and narrow. */
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    /* CONVENTIONS.md §1.2 and §1.6. Both restrictions are declared in one block:
     * `no-restricted-imports` does not merge across config objects, so a second block
     * targeting these same files would silently replace this rule rather than add to it. */
    files: ['src/main/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [PURE_DOMAIN, NO_PERSISTENCE, NO_CONCRETE_REGIME] },
      ],
    },
  },
  {
    /* The renderer computes no money and knows no tax rules — it displays what main sends. */
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [NO_CONCRETE_REGIME] }],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/__fixtures__/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['*.config.{js,ts}', 'scripts/**/*.{js,mjs,ts}'],
    rules: {
      'no-console': 'off',
    },
  },
)
