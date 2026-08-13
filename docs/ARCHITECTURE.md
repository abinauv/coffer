# Coffer — Architecture & Stack

> The technical reference for the repo. If you are implementing a phase, read this
> and [`CONVENTIONS.md`](./CONVENTIONS.md) before writing code.

---

## 1. What Coffer is

A local-first, double-entry ERP for small businesses. Sales, purchases, inventory,
a real general ledger, financial statements, and India GST compliance — running
entirely on the user's own machine.

The books for one company live in **one encrypted SQLite file** the user owns and
can copy to a pen drive. There is no server, no account, no subscription, and no
network dependency for any core function.

## 2. Non-negotiables

These define the product. A change here is a change of product, not of implementation.

|                           |                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **No server**             | Nothing in the core requires a running service. Optional cloud features (GSP filing) must be additive and degrade cleanly to offline. |
| **One file per company**  | A company is a single SQLCipher database. Backup is a file copy.                                                                      |
| **Encrypted at rest**     | The database is never written unencrypted. The key derives from the user's passphrase.                                                |
| **Derived balances only** | No table stores a balance that the journal could disagree with.                                                                       |
| **Offline compliance**    | Return artefacts (JSON, Excel) are produced locally. API filing is an optional adapter, never a requirement.                          |

## 3. Stack

Versions are the current release as of the Phase 0 build. Pin exact versions in
`package.json`; upgrade deliberately, not incidentally.

| Layer         | Choice                                       | Version | Why                                                                                                                                                                                               |
| ------------- | -------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell         | Electron                                     | 43.x    | Chromium's print-to-PDF is the PDF engine; one codebase, three platforms.                                                                                                                         |
| Build         | electron-vite                                | 5.x     | Main/preload/renderer builds with HMR, already proven on the reference project.                                                                                                                   |
| Language      | TypeScript                                   | 5.9.3   | TypeScript 7 (the native compiler) is released and much faster, but `typescript-eslint` still caps at `<6.1.0`. Revisit when the lint toolchain catches up — the codebase should need no changes. |
| UI            | React                                        | 19.x    |                                                                                                                                                                                                   |
| Bundler       | Vite                                         | 7.3.x   | Not 8 — `electron-vite` 5 peers on `^5 \|\| ^6 \|\| ^7`. Upgrading Vite means waiting for electron-vite.                                                                                          |
| Tests         | Vitest                                       | 4.x     |                                                                                                                                                                                                   |
| Database      | SQLite via `better-sqlite3-multiple-ciphers` | 13.x    | Synchronous, embedded, and SQLCipher-capable in one module.                                                                                                                                       |
| Query builder | Kysely                                       | 0.29.x  | Types derive from the schema; no runtime ORM weight.                                                                                                                                              |
| Money         | `decimal.js`                                 | 10.x    | Arbitrary precision. See §7.                                                                                                                                                                      |
| Hashing       | `@node-rs/argon2`                            | 2.x     | Argon2id for the passphrase.                                                                                                                                                                      |
| Crypto        | `libsodium-wrappers`                         | 0.7.x   | Sealed-box recovery.                                                                                                                                                                              |
| Excel         | ExcelJS                                      | 4.x     |                                                                                                                                                                                                   |
| Packaging     | electron-builder                             | 26.x    | NSIS, dmg, AppImage + deb.                                                                                                                                                                        |

**Deliberately absent:** no ORM, no state-management library in main, no CSS framework
in the renderer beyond tokens, no cloud SDKs, no telemetry.

## 4. Process model

```
┌─────────────────────────────────────────────────────────┐
│ main                  privileged. owns the database,    │
│                       filesystem, crypto, PDF, Excel.   │
│                       All business logic lives here.    │
└───────────────────────────┬─────────────────────────────┘
                            │  typed IPC — group:method
┌───────────────────────────┴─────────────────────────────┐
│ preload                   contextBridge only.           │
│                           No node access in renderer.   │
└───────────────────────────┬─────────────────────────────┘
┌───────────────────────────┴─────────────────────────────┐
│ renderer              React. Presentation and input     │
│                       validation only. Never computes   │
│                       money, tax, or balances.          │
└─────────────────────────────────────────────────────────┘
```

The renderer is untrusted for correctness. Every total it displays was computed in
main and sent over. This is why the invoice editor debounces a `totals` call rather
than adding numbers in the browser.

## 5. Module layout

```
src/
├── main/
│   ├── app/            bootstrap, window lifecycle, menu, auto-update
│   ├── companies/      company registry, create/open/close/backup
│   ├── db/
│   │   ├── connection.ts      SQLCipher open + key application
│   │   ├── migrate.ts         numbered migration runner
│   │   ├── migrations/        0001_… never edited after merge
│   │   ├── schema.ts          Kysely table typings
│   │   └── repos/             one module per aggregate
│   ├── domain/         PURE. No I/O, no db, no electron imports.
│   │   ├── money/             decimal helpers, rounding policy
│   │   ├── ledger/            posting engine, balance invariants
│   │   ├── documents/         document → journal entry rules
│   │   ├── inventory/         valuation strategies
│   │   └── time/              fiscal years, periods
│   ├── regimes/        the internationalisation seam — see §6
│   │   ├── types.ts           TaxRegime interface
│   │   └── in-gst/            India GST implementation
│   ├── security/       argon2, vault, DEK, recovery codes, sealed box
│   ├── services/       pdf, excel, backup, mailer, importers
│   └── ipc/            handlers, registered by channel name
├── preload/
├── renderer/src/
│   ├── components/     atoms, shell
│   ├── screens/        one folder per screen
│   ├── store/
│   └── styles/         design tokens
└── shared/             types + the IPC contract. Imported by all three.
```

**`domain/` is pure.** It imports nothing from `db`, `electron`, or `node:fs`. This is
what makes the money and ledger logic testable against golden fixtures, and it is the
single most important structural rule in the codebase.

## 6. The six load-bearing decisions

### 6.1 Ledger first

`journal_entries` + `journal_lines` exist before any document screen. Every document —
invoice, bill, payment, stock movement — is a **source document** that posts a balanced
entry referencing it via `source_type` / `source_id`.

```
accounts          code, name, type, parent_id, is_group
journal_entries   entry_no, date, period_id, narration, source_type, source_id
journal_lines     entry_id, account_id, debit, credit, party_id, line_no
fiscal_periods    fy_label, start_date, end_date, status
```

The invariant — `SUM(debit) = SUM(credit)` per entry — is enforced in the posting
engine, asserted in tests, and checked by a database trigger. A document that cannot
post does not save.

Nothing else stores a balance. Outstanding, stock value, and party balances are all
derived. This is slower and it is correct; add indexes and materialised views if
profiling demands it, never a denormalised balance column.

### 6.2 Tax behind a regime adapter

GST must not appear in `domain/` or in any screen. `regimes/types.ts` defines:

```ts
interface TaxRegime {
  computeTax(basis: TaxBasis): TaxBreakdown
  placeOfSupply(supplier: Party, customer: Party): PlaceOfSupply
  validateRegistrationNumber(value: string): ValidationResult
  classificationScheme: ClassificationScheme // HSN/SAC, or NAICS, or none
  fiscalYear: FiscalYearRule // Apr–Mar, or Jan–Dec
  numberFormat: NumberFormatRule // lakh/crore, or thousands
  amountInWords(value: Decimal): string
  filings: FilingDefinition[]
}
```

`regimes/in-gst/` is the first implementation. A second regime should require no change
outside its own folder.

> The reference project hardcodes `computeGst()` and calls it from screens. Do not
> reproduce that. It also hardcodes _"freight is never taxed"_, which was one client's
> policy — freight and packing are configurable charge lines here.

### 6.3 One encrypted database per company

A registry at the OS app-data path lists companies (`id`, `display_name`, `file_path`,
`last_opened_at`). Each company database holds its own DEK, wrapped by a key derived
from that company's passphrase.

No `company_id` column exists anywhere. A missing `WHERE` clause therefore cannot leak
one client's data into another's report, and one corrupt file costs one company.

### 6.4 Perpetual inventory, moving average

Every stock movement writes to the stock ledger **and** posts to the general ledger, so
inventory value on the balance sheet always reconciles with the stock register.

v1 ships moving weighted average. FIFO and batch/expiry are a later strategy behind the
same `ValuationStrategy` interface — needed for pharma and food, nobody else.

### 6.5 Three platforms from the start

Windows (NSIS), macOS (dmg, x64 + arm64), Linux (AppImage + deb). Both native modules
need prebuilds for all three in CI.

**Builds are unsigned for now.** Windows shows a SmartScreen warning and macOS
quarantines the download; the README must tell users how to proceed, and the docs site
must publish SHA-256 checksums for every artefact so the download is at least
verifiable. Revisit certificates when the project has traction.

### 6.6 Compliance as a versioned pack

GST rates, HSN/SAC lists, return schemas and validation rules ship as a data pack with
its own version, loadable without a new binary. Rules change on government timelines,
not release timelines — and an offline tool that silently runs stale rules loses the
trust that is the entire reason someone chose it.

## 7. Money

Every monetary value is a `decimal.js` `Decimal` in memory and a **decimal string** in
the database. Never a float, never a JS `number`, at any layer including JSON crossing
IPC.

- Rounding: `ROUND_HALF_UP`, applied at defined points only — never incidentally.
- Storage scale: money 2dp, quantity 3dp, rate 2dp.
- Tests use golden fixtures. Changing a rounding rule must break a test.

## 8. Security

|              |                                                                                   |
| ------------ | --------------------------------------------------------------------------------- |
| Passphrase   | Argon2id via `@node-rs/argon2`                                                    |
| Database     | SQLCipher; opened only after unlock                                               |
| Key handling | A DEK wrapped by the passphrase-derived key; the DEK never touches disk unwrapped |
| Recovery     | Five single-use recovery codes, generated at setup                                |
| Secrets      | SMTP app passwords go to OS secure storage, never the database                    |
| Renderer     | `contextIsolation: true`, `nodeIntegration: false`, no remote module              |
| Audit        | Append-only activity log for business actions                                     |

## 9. Testing

| Level          | Tool                      | Covers                                                                   |
| -------------- | ------------------------- | ------------------------------------------------------------------------ |
| Unit           | Vitest                    | `domain/` and `regimes/` — pure, fast, the bulk of the suite             |
| Golden fixture | Vitest                    | Money math, tax splits, amount-in-words, posting rules                   |
| Repository     | Vitest + in-memory SQLite | Migrations and repos                                                     |
| Integration    | Vitest                    | Document → journal posting, end to end in main                           |
| E2E            | Playwright                | Critical paths only: unlock, create company, issue invoice, close period |

The accounting-equation test is not optional and is never skipped.

## 10. Licence

AGPL-3.0-or-later. Contributions under DCO — every commit signed off with
`git commit -s`. This keeps a closed-source cloud fork off the table and preserves the
option of a future dual licence.
