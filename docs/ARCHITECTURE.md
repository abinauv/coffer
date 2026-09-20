# Coffer — Architecture & Stack

> The technical reference for the repo. If you are implementing a phase, read this
> and [`CONVENTIONS.md`](./CONVENTIONS.md) before writing code.

---

## 1. What Coffer is

A local-first, double-entry ERP for small businesses. Sales, purchases, inventory,
a real general ledger, financial statements, and India GST compliance — running
entirely on the user's own machine.

The books for one company live in **an encrypted SQLite file the user owns**, with a
one-action backup they can copy to a pen drive. There is no server, no account, no
subscription, and no network dependency for any core function.

## 2. Non-negotiables

These define the product. A change here is a change of product, not of implementation.

|                            |                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **No server**              | Nothing in the core requires a running service. Optional cloud features (GSP filing) must be additive and degrade cleanly to offline. |
| **One company, one place** | A company is a SQLCipher database plus its key vault. Backup produces a single archive holding both — see §6.3.                       |
| **Encrypted at rest**      | The database is never written unencrypted. The key derives from the user's passphrase.                                                |
| **Derived balances only**  | No table stores a balance that the journal could disagree with.                                                                       |
| **Offline compliance**     | Return artefacts (JSON, Excel) are produced locally. API filing is an optional adapter, never a requirement.                          |

## 3. Stack

Versions are what `package.json` pins today. Pin exact versions there; upgrade
deliberately, not incidentally.

| Layer         | Choice                                       | Version | Why                                                                                                                                                                                               |
| ------------- | -------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell         | Electron                                     | 43.x    | Chromium's print-to-PDF is the PDF engine; one codebase, three platforms.                                                                                                                         |
| Build         | electron-vite                                | 5.x     | Main/preload/renderer builds with HMR, from one config.                                                                                                                                           |
| Language      | TypeScript                                   | 5.9.3   | TypeScript 7 (the native compiler) is released and much faster, but `typescript-eslint` still caps at `<6.1.0`. Revisit when the lint toolchain catches up — the codebase should need no changes. |
| UI            | React                                        | 19.x    |                                                                                                                                                                                                   |
| Bundler       | Vite                                         | 7.3.x   | Not 8 — `electron-vite` 5 peers on `^5 \|\| ^6 \|\| ^7`. Upgrading Vite means waiting for electron-vite.                                                                                          |
| Tests         | Vitest                                       | 4.x     |                                                                                                                                                                                                   |
| Database      | SQLite via `better-sqlite3-multiple-ciphers` | 13.x    | Synchronous, embedded, and SQLCipher-capable in one module.                                                                                                                                       |
| Query builder | Kysely                                       | 0.29.x  | Types derive from the schema; no runtime ORM weight.                                                                                                                                              |
| Money         | `decimal.js`                                 | 10.x    | Arbitrary precision. See §7.                                                                                                                                                                      |
| Hashing       | `@node-rs/argon2`                            | 2.x     | Argon2id for the passphrase.                                                                                                                                                                      |
| Crypto        | `libsodium-wrappers`                         | 0.8.x   | Sealed-box recovery.                                                                                                                                                                              |
| Packaging     | electron-builder                             | 26.x    | NSIS, dmg, AppImage + deb.                                                                                                                                                                        |

**Deliberately absent:** no ORM, no state-management library in main, no CSS framework
in the renderer beyond tokens, no cloud SDKs, no telemetry.

## 4. Process model

```
┌─────────────────────────────────────────────────────────┐
│ main                  privileged. owns the database,    │
│                       filesystem, crypto, rendering.    │
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

Entries marked **`planned`** do not exist on disk. Everything else does.

```
src/
├── branding.ts         product name, ids, paths, URLs. The only place they appear.
├── main/
│   ├── index.ts        bootstrap, window lifecycle, quit
│   ├── app/            planned — the above, split out of index.ts, plus menu
│   │                   and auto-update
│   ├── books/          the open-company seam every service below shares
│   ├── companies/      registry, create/open/recover/close/rename/forget,
│   │                   passphrase change, AND BACKUP — archive.ts and backup.ts
│   ├── db/
│   │   ├── connection.ts      SQLCipher open + key application
│   │   ├── migrate.ts         numbered migration runner
│   │   ├── migrations/        0001_…0022_ — never edited after merge
│   │   ├── schema.ts          Kysely table typings — 20 tables
│   │   └── repos/             one module per aggregate
│   ├── domain/         PURE. No I/O, no db, no electron imports.
│   │   ├── money/             decimal helpers, rounding policy
│   │   ├── time/              fiscal years, periods
│   │   ├── ledger/            posting engine, balance invariants
│   │   ├── documents/         document → journal entry rules
│   │   ├── receipts/          money in and out, and what it settles
│   │   ├── inventory/         valuation strategies, the stock card
│   │   └── reports/           ageing buckets, statement trees, running balances
│   ├── regimes/        the internationalisation seam — see §6
│   │   ├── types.ts           TaxRegime interface
│   │   └── in-gst/            India GST implementation, with returns/ beneath it
│   ├── security/       argon2, vault, DEK, recovery codes, sealed box
│   ├── ledger/         ─┐
│   ├── parties/         │
│   ├── items/           │ one service per IPC group. THE ONLY LAYER THAT MAY
│   ├── units/           │ ASK A REGIME — see §6.2 and src/main/documents.
│   ├── documents/       │
│   ├── receipts/        │ `system` and `reports` have no folder here: the first
│   ├── numbering/       │ is Electron calls behind ipc/electron.ts, the second
│   ├── company-profile/─┘ reads db/repos/reports.ts and writes nothing.
│   ├── regime/         the open company's regime, DESCRIBED for the screens.
│   │                   Singular — regimes/ above is the adapters themselves.
│   ├── services/
│   │   ├── pdf/               invoice print model + HTML template. The
│   │   │                      printToPDF call itself is not written yet.
│   │   ├── importers/         csv/, xml/, zoho/, tally/
│   │   ├── excel/             planned — return workbooks and register exports
│   │   └── mailer/            planned
│   └── ipc/            handlers, registered by channel name
├── preload/
├── renderer/src/
│   ├── components/     atoms, shell, command-palette, toast
│   ├── screens/        welcome/ and workspace/, plus their components/ and lib/
│   ├── store/
│   ├── lib/            routing, theme, toasts, the API proxy, formatting
│   └── styles/         design tokens
└── shared/             types + the IPC contract. Imported by all three.
```

**Two vocabularies live in `shared/` rather than in `domain/`, and it is worth knowing
why.** `shared/documents.ts` holds the kinds of trade document — what each is called, its
side of the trade, its direction, and whether issuing it reaches the ledger. That table
was in `domain/` until the screens needed it, and the renderer cannot import `@main/*`.
The choice was between an IPC channel serving a constant and a second copy in the
renderer, and a second copy is the shape this codebase keeps deleting. What stayed in
`domain/` is what the LEDGER does with a kind: `SourceDocumentType` has `manual` and
`year-end-close` in it, which no user raises, and that union does not belong in a module
the renderer imports. The two halves are joined at compile time — see the file's header.

`shared/receipts.ts` is the same split one layer over: a receipt and a payment differ in
whose money it is, which way it moved and which documents they settle, and the screens
need all three. What stayed in `domain/receipts` is the control account each one moves and
what an entry records it as — an `AccountRole` and a `SourceDocumentType`, neither of
which a screen can use.

**This is the target layout, and most of it is now an inventory.** The distinction is
still worth keeping. Three entries are marked `planned`, and each is telling you
something; two more things about the tree are worth saying out loud because a reader will
otherwise infer the opposite.

**`main/app/` does not exist.** Bootstrap and the window are in `src/main/index.ts`, which
is where they went when there was one of each; there is no application menu and no update
check at all, though `electron-updater` is a declared dependency waiting for one. The
folder is where all of it belongs once there is more than one window and a menu with items
in it. Until then, splitting it would be four files that import each other in a line.

**`services/excel/` and `services/mailer/` do not exist.** ExcelJS was a declared
dependency with no importer anywhere in `src/`, and it was removed before the first
release rather than shipped inside an installer for code nobody calls: the return
builders in `regimes/in-gst/returns/` produce TypeScript values and stop there, because a
workbook whose column layout has never been through a filing cycle is a file somebody
would upload. §6.6 is the reason that is not a small omission. Whatever writes a workbook
first can declare it then.

**Backup is in `companies/`, not in `services/`.** Earlier revisions of this section put
it under `services/`, and that was wrong rather than early: a backup archive holds the
database _and its vault_, so it is written by the layer that knows where both files are
and how they are named — `companies/archive.ts` writes the zip and `companies/backup.ts`
composes the manifest. A `services/backup` would need the registry, the paths and the
checkpoint, which is `companies/` again with an import in front of it. See §6.3.

**`services/` is built and not yet reachable.** `pdf/` and all four importers are pure
library code with no IPC group behind them and no caller outside `services/`; the tree
above says where they are, not what a user can run. `getting-started.md` §7 says the same
thing from the "where does my change go" end.

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
  readonly id: RegimeId // ISO 3166-1 alpha-2, lower case. Persisted.
  readonly label: string

  computeTax(input: TaxComputationInput): TaxComputationResult
  placeOfSupply(supplier: TaxParty, customer: TaxParty): PlaceOfSupply
  validateRegistrationNumber(value: string): ValidationResult
  jurisdictionName(code: string): string | null
  jurisdictions(): ReadonlyArray<{ code: string; name: string }>

  readonly classification: ClassificationScheme // HSN/SAC, or NAICS, or none
  readonly fiscalYear: FiscalYearRule // Apr–Mar, or Jan–Dec
  readonly numberFormat: NumberFormatRule // lakh/crore, or thousands. Reaches the
  // screens via regime.describe().

  amountInWords(value: Decimal): string

  readonly filings: ReadonlyArray<FilingDefinition>
}
```

`regimes/in-gst/` is the first implementation, reached through the registry in
`regimes/index.ts` — nothing outside `regimes/` names a concrete regime, and eslint
enforces that. A second regime should require no change outside its own folder. See
[`adding-a-tax-regime.md`](./adding-a-tax-regime.md).

**Where the regime is actually asked.** One place: `src/main/documents/service.ts`. A
screen sends what the user typed and that service asks `computeTax`, with the company
profile as the supplier and the party as the customer, before handing the result to the
repository. The DTO pair in `shared/dto.ts` is what keeps it there —
`CreateDocumentInput` carries no tax and `CreateTaxedDocumentInput` requires it, so a
screen wired to the repository would have to invent the figures.

> Never call a `computeGst()` from a screen, and never hardcode a rule such as _"freight is
> never taxed"_ — that is one business's policy, not a rule. Freight and packing are
> ordinary charge lines here, taxed at whatever rate the line carries.

### 6.3 One encrypted database per company

A registry at the OS app-data path — `companies.json`, not a table — lists companies
(`id`, `displayName`, `filePath`, `vaultPath`, `createdAt`, `lastOpenedAt`). Each company
has its own DEK, wrapped by a key derived from that company's passphrase.

No `company_id` column exists anywhere. A missing `WHERE` clause therefore cannot leak
one client's data into another's report, and one corrupt file costs one company.

**On disk, a company is two files**, named from the company's display name:

```
Accounts/
  Acme-Traders.coffer          the SQLCipher database
  Acme-Traders.coffer.vault    wrapped DEK, salts, KDF parameters, recovery slots
```

A wrapped key cannot live inside the database it decrypts — something has to be readable
before the database can be opened. So the vault is a sidecar, and the consequence has to
be handled honestly rather than papered over:

- **Backup is a first-class action, not a file copy.** It produces one archive
  containing both files. This is the path the UI steers users toward, and the only one
  documented as "your backup".
- **Opening a database with no vault beside it fails with a specific message** — keys
  missing, restore from a backup that includes them — never a generic decryption error.
- The database remains a plain SQLCipher file, so the "take your data elsewhere"
  promise in the README still holds: any SQLCipher-capable tool can open it given the key.

### 6.3.1 No key escrow

There is no maintainer-held key and no recovery path we control. If a user loses their
passphrase and all five recovery codes, their books are gone.

This is a deliberate product decision, and `SECURITY.md` states it plainly to users. An
escrow slot would make that statement false, and in an open-source product nobody can
verify a maintainer is not holding a master key — the only credible claim is one the
code makes impossible to break.

`sealed-box.ts` is therefore a confidential **support** channel only: it seals vault
metadata carrying no key material. It deliberately bakes in no maintainer public key,
because a placeholder key in source is a key that ships by accident.

The mitigations are five independent recovery codes, and a passphrase-strength warning
at company creation (§8) that is loud but never blocking — with no escrow, refusing a
user their own passphrase leaves them no fallback at all.

### 6.4 Perpetual inventory, moving average

Every stock movement writes to the stock ledger **and** posts to the general ledger, so
inventory value on the balance sheet always reconciles with the stock register.

Both halves are now built: migration `0019` is the register and `0022` is the entry each
movement posts as, with a trigger refusing a movement that moved money and named none.
`db/repos/stock-reconciliation.test.ts` is the sentence above as a test, asserting the
figures on both sides as at every date rather than only that the two agree — an
invariant that holds by construction cannot see a movement that failed to post at all,
because both sides would then be short by the same amount.

The stock ledger stores **no running balance**. A back-dated receipt re-averages the pool
and therefore changes what every issue after it cost, so a stored balance cannot be
frozen the way a due date can; the card is folded from the movements every time it is
asked for. The consequence is recorded rather than hidden: recording a back-dated
movement changes the cost of a sale that has already posted, and the answer is a
valuation adjustment dated at the movement it restates — a second entry, never an edit to
the first.

v1 ships moving weighted average. FIFO and batch/expiry are a later strategy behind the
same `ValuationStrategy` interface — needed for pharma and food, nobody else. The
interface was written against all three so that the two that do not exist yet cannot
force it to be rewritten: `layers`, `slices` and the `identifiesLayers` / `tracksBatches`
capability flags are there for them, and moving average is the one-layer case.

### 6.5 Three platforms from the start

Windows (NSIS), macOS (dmg, x64 + arm64), Linux (AppImage + deb). Both native modules
need prebuilds for all three in CI.

**Builds are unsigned for now.** Windows shows a SmartScreen warning and macOS
quarantines the download; the README says exactly which buttons to press on each, and
every release publishes SHA-256 checksums for every artefact so the download is at least
verifiable. On Windows 11, Smart App Control is the case with no button to press: it
refuses an unsigned installer it has no reputation for, which is why unsigned is a
limitation on who can install Coffer rather than only on what the OS can vouch for
(SECURITY.md, "Known gaps"). `.github/workflows/release.yml` generates `SHA256SUMS.txt` from the artefacts
actually attached, via `scripts/checksums.mjs`, attests SLSA build provenance for each of
those files with `actions/attest` before publishing, and puts both verification commands
in the release notes. The checksum says a file arrived intact; the attestation says it was
built by that workflow from the tag, which a checksum on the same page cannot. `CSC_IDENTITY_AUTO_DISCOVERY: false` is set on the build matrix so a
signing identity sitting in a runner keychain cannot be picked up by accident — unsigned
is a decision, and an accidentally-signed artefact is one nobody could reproduce locally.
Revisit certificates when the project has traction.

### 6.6 Compliance as a versioned pack

GST rates, HSN/SAC lists, return schemas and validation rules ship as a data pack with
its own version, loadable without a new binary. Rules change on government timelines,
not release timelines — and an offline tool that silently runs stale rules loses the
trust that is the entire reason someone chose it.

**The same rule applies to a shape nobody has checked, and it is why the return builders
say so on their own output.** `regimes/in-gst/returns/` turns a period's documents into
GSTR-1 and GSTR-3B, and the arithmetic is pinned to the paisa against hand-worked
fixtures. The _shape_ — field names, nesting, which figure belongs in which box — was
written from the published description of the returns and has never been validated
against GSTN's own JSON schema or been through a filing cycle. So every artefact carries
a `SCHEMA_UNVERIFIED` issue and a notice in its own body, and a screen cannot render one
as a finished return without repeating it. Three things would clear it, in order: the
published schema checked into the pack with a validator run over the output, one real
filing cycle with the portal's validation report kept beside it, and the document named
against each per-rule decision.

## 7. Money

Every monetary value is a `decimal.js` `Decimal` in memory and a **decimal string** in
the database. Never a float, never a JS `number`, at any layer including JSON crossing
IPC.

- Rounding: `ROUND_HALF_UP`, applied at defined points only — never incidentally.
- Storage scale: money 2dp, quantity 3dp, rate 3dp. The third place on a rate is not
  decoration: India's 0.25% slab halves into CGST 0.125% and SGST 0.125%, and at 2dp an
  invoice would print 0.13% — a rate the tax was never computed from.
- Tests use golden fixtures. Changing a rounding rule must break a test.

## 8. Security

|              |                                                                                                                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passphrase   | Argon2id via `@node-rs/argon2`                                                                                                                                                                                                      |
| Database     | SQLCipher; opened only after unlock                                                                                                                                                                                                 |
| Key handling | A DEK wrapped by the passphrase-derived key; the DEK never touches disk unwrapped                                                                                                                                                   |
| Recovery     | Five single-use recovery codes, generated at setup. No escrow — see §6.3.1                                                                                                                                                          |
| Passphrase   | Strength shown live; a weak one is warned about explicitly but never blocked. `SECURITY.md` treats allowing weak _without warning_ as a vulnerability — refusing outright is not the remedy, since nobody can reset it for the user |
| Secrets      | SMTP app passwords will go to OS secure storage, never the database. There is no mailer yet and nothing calls `safeStorage`                                                                                                         |
| Renderer     | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no remote module                                                                                                                                               |
| Audit        | The ledger is the audit trail: entries and stock movements are append-only, enforced by triggers, and a correction is a reversal. A separate activity log for non-posting actions does not exist                                    |

## 9. Testing

| Level          | Tool                      | Covers                                                                                                                     |
| -------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Unit           | Vitest                    | `domain/` and `regimes/` — pure, fast, the bulk of the suite                                                               |
| Golden fixture | Vitest                    | Money math, tax splits, amount-in-words, posting rules                                                                     |
| Repository     | Vitest + in-memory SQLite | Migrations and repos                                                                                                       |
| Integration    | Vitest                    | Document → journal posting, and stock register against balance sheet                                                       |
| Screen         | Vitest + happy-dom        | Every screen, through the real API proxy — see `CONVENTIONS.md` §6                                                         |
| Mutation       | `npm run mutate`          | Recorded campaigns under `scripts/mutations/`, each with a control and a canary                                            |
| E2E            | Playwright                | **Not yet.** No Playwright dependency and no spec — planned for unlock, create a company, issue an invoice, close a period |

The accounting-equation test is not optional and is never skipped. Neither is
`db/repos/stock-reconciliation.test.ts`, which is §6.4's promise written as figures.

**A passing test is not evidence until it has failed.** Coverage thresholds are enforced
on `domain/`, `regimes/` and `security/` only, and they measure whether a line ran rather
than whether anything would have noticed it changing. `CONVENTIONS.md` §6 is the harness
and the ten ways it has silently reported a run that never started.

## 10. Licence

AGPL-3.0-or-later. Contributions under DCO — every commit signed off with
`git commit -s`. This keeps a closed-source cloud fork off the table and preserves the
option of a future dual licence.
