import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/* Import restrictions that enforce the structural rules in docs/CONVENTIONS.md.
 * These are linted rather than left to review because they are the constraints that
 * are cheapest to violate accidentally and most expensive to unwind later. */

/* Every Node built-in. The purity of `domain/` is a load-bearing guarantee
 * (ARCHITECTURE §5), and the first version of this rule named only `fs`, `path` and
 * `electron` — which let `node:crypto`, `child_process`, `http`, `os`, `net` and
 * `worker_threads` straight through. A rule that catches only the imports someone
 * thought of is not a guarantee.
 *
 * An allowlist (`['*', '!decimal.js']`) would be stricter still, but ESLint matches
 * these with gitignore-style patterns, where `*` also matches relative specifiers and
 * no negation form exempts them — verified empirically, not assumed. So: an exhaustive
 * denylist of the I/O surface, which is a closed and slow-moving set. */
const NODE_BUILTINS = [
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]

const PURE_DOMAIN = {
  group: [
    'node:*',
    ...NODE_BUILTINS,
    ...NODE_BUILTINS.map((name) => `${name}/*`),
    'electron',
    'electron/*',
  ],
  message:
    'src/main/domain must stay pure — no I/O and no ambient state. If a domain function ' +
    'needs data, take it as an argument. Adding a package here needs a conscious decision: ' +
    'it must be pure computation, with no clock, randomness or filesystem.',
}

const NO_PERSISTENCE = {
  group: ['**/db/**', '**/services/**', '**/ipc/**'],
  message: 'src/main/domain must not depend on persistence or transport. Invert the dependency.',
}

// Both forms are needed. The deep pattern alone matches a file *inside* a concrete
// regime folder but not the folder import itself — `@main/regimes/in-gst` — which is
// the import someone would actually write. The rule caught nothing until the bare
// form was added.
// (Line comments, not a block: these globs contain the characters that close one.)
const NO_CONCRETE_REGIME = {
  group: ['**/regimes/in-*', '**/regimes/in-*/**'],
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
    /* Everything except `regimes/` itself goes through the registry, never at a concrete
     * regime. Previously this guarded only `domain/` and `renderer/`, which left `db/`,
     * `services/` and `ipc/` free to import `in-gst` directly — and a rule the whole
     * middle of the app can walk around is not a rule. CONVENTIONS §1.6. */
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/main/regimes/**', 'src/main/domain/**'],
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
