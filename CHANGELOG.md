# Changelog

All notable changes to Coffer are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries that change how money, tax or ledger postings are calculated are marked
**[accounting]**. Read those carefully before upgrading — they can change figures on
documents you have already issued.

## [Unreleased]

Phase 0: the foundations. There is no ledger and no document yet — this is the file
format, the crypto, the arithmetic and the machinery everything else is built on. No
release has been made, so everything below is new.

### Added

#### Money and time — the arithmetic everything else uses

- **[accounting]** Money primitives (`main/domain/money`). Every monetary value is a
  `decimal.js` `Decimal` in memory and an exact decimal string at every storage and IPC
  boundary. A JS `number` with a fractional part cannot get in.
- **[accounting]** A single rounding policy: `ROUND_HALF_UP`, applied only at named
  points in `ROUNDING_POINTS`, never incidentally. Storage scales are money 2dp,
  quantity 3dp, rate 3dp — a rate carries three places because India's 0.25% slab halves
  into CGST 0.125% and SGST 0.125%, and 0.13% is a rate no tax was ever computed from.
- **[accounting]** Largest-remainder allocation (`allocate`, `allocateByWeights`), so a
  split total sums back to the original exactly and the odd paisa lands deterministically.
- **[accounting]** Golden fixtures for rounding, allocation, percentages and storage
  round-trips. Changing a rounding rule now breaks a test.
- Time primitives (`main/domain/time`): calendar dates as `YYYY-MM-DD`, instants as
  ISO-8601 UTC, and an injectable clock.
- **[accounting]** Fiscal years as a rule rather than a constant. `createFiscalYearRule`
  derives start and end dates, which year a date falls in, and the months and quarters
  inside it, for any start month and any start day from 1 to 28. `aprilToMarch` and
  `januaryToDecember` ship; nothing in `domain/` assumes either.

#### India GST

- The `TaxRegime` interface (`main/regimes/types.ts`) — the internationalisation seam.
  Tax computation, place of supply, registration numbers, classification, fiscal year,
  number format, amount in words and filings all sit behind it.
- A regime registry with `getRegime`, `findRegime` and `availableRegimes`. Nothing
  outside `regimes/` names a concrete regime, and ESLint enforces it across all of
  `src/`.
- **[accounting]** The GST split: CGST + SGST intra-state, UTGST in place of SGST in a
  union territory without a legislature, IGST inter-state and on exports. Never all
  three.
- **[accounting]** Rate applied once at full precision, line tax rounded once, then
  allocated across components. This is what keeps a supply's total tax identical either
  side of a state line — rounding each component separately would make an 18% line worth
  18.00 intra-state and 18.01 inter-state on the same amount. Pinned in fixtures.
- **[accounting]** Freight, packing and insurance are ordinary charge lines. `isCharge`
  says what a line is, not whether it is taxable; a charge that should not be taxed
  carries a rate of 0. No policy is hardcoded inside the tax function.
- **[accounting]** GSTIN validation including the check character, deriving the state
  code from the number.
- 38 Indian jurisdictions by GST state code, carrying whether each levies SGST or UTGST.
  Two retired codes — 25 (Daman and Diu) and 28 (undivided Andhra Pradesh) — validate but
  are not offered in pickers, because they still appear on documents issued before the
  reorganisations.
- HSN/SAC classification with 4-, 6- and 8-digit HSN and 6-digit SAC.
- **[accounting]** Amount in words in the Indian tax-invoice convention, currency word
  leading: `Rupees One Thousand Two Hundred Thirty Four and Fifty Paise Only`.
- Indian number grouping (`1,23,45,678`) as data, not a formatter.
- GSTR-1, GSTR-3B and GSTR-2B declared. Producing the artefacts is a later phase.
- A versioned compliance pack (`2026.04.0`) carrying rate slabs and 35 seed
  classification codes, so rates can be updated without a new binary. The structure of
  the Act — the CGST/SGST/IGST split, the halving of an intra-state rate, the state list
  — is deliberately code rather than data.

#### Security

- Argon2id key derivation with two profiles: 256 MiB / t=3 / p=4 for the human-chosen
  passphrase, 64 MiB / t=3 / p=4 for 100-bit random recovery codes.
- A per-company data encryption key: 32 random bytes, wrapped as
  `AES-256-GCM(HKDF(Argon2id(secret)), DEK)`. The DEK never touches disk unwrapped and is
  zeroed the moment SQLCipher has copied it.
- The vault file format, version 1. One DEK wrapped six times over — once by the
  passphrase, once by each of five recovery codes — so changing the passphrase rewrites
  one small key slot and never touches the database.
- Two layers of authentication on the vault: each slot's AES-GCM wrap covers its own
  header as associated data, and an HMAC-SHA256 over the whole canonical document is
  checked after every unlock. The second layer is what stops a spent recovery code being
  resurrected by editing `usedAt` back to `null`.
- Five single-use recovery codes: 20 Crockford Base32 symbols, 100 bits, printed in four
  groups of five. Transcribed `O`, `I` and `L` are repaired on the way back in. Redeeming
  a code destroys its wrapped key material — it works once because the ciphertext is
  gone, not because a flag says so.
- No key escrow, and no maintainer public key baked into the source. `sealed-box.ts` is a
  confidential support channel for vault metadata carrying no key material.
- Advisory passphrase strength scoring. It warns and never blocks — with no escrow,
  refusing a user their own passphrase would leave them no fallback at all.

#### The company file

- SQLCipher-encrypted SQLite via `better-sqlite3-multiple-ciphers`, with the cipher
  pinned explicitly (the driver's default is `chacha20`, which would make files
  unreadable across builds) and the key applied raw, since it is already an Argon2id
  output.
- A wrong key fails at open with `DB_WRONG_KEY`, not on a later query. A brand-new
  database gets its encrypted header materialised immediately, so a mistyped passphrase
  on the second open fails instead of silently starting a parallel set of books.
- `foreign_keys = ON`, `synchronous = FULL` and WAL journalling on every connection.
- A numbered migration runner: one transaction per migration, one row per migration in
  `schema_migrations`, and a refusal to touch a database carrying migrations this build
  does not know — distinguishing "written by a newer Coffer" from "not a Coffer lineage
  at all".
- Migration `0001_app_metadata`: a small key/value table of file-level facts, so a
  database that decrypts can still identify itself.
- Kysely typings layer over the same keyed connection — one file lock, one key
  application, one set of pragmas.
- No `company_id` column anywhere, and none planned. A company is a separate file.

#### Companies

- A company is an encrypted database plus a sidecar vault, the vault path always being
  the database path with `.vault` appended.
- The registry (`companies.json`): an index of file locations holding no keys and no
  figures. It degrades to an empty list with a stated problem rather than throwing, drops
  only the entries it cannot read, and quarantines a corrupt file as
  `companies.json.corrupt-<timestamp>` before its first write.
- Company lifecycle: create, open, recover, close, change passphrase, back up, restore,
  add existing, forget, rename. Operations are serialised, so two IPC calls cannot
  interleave into two handles on one file.
- Create is ordered vault → database → registry and unwinds completely on any failure. A
  vault with no books, or books with no keys, is worse than no company at all.
- Recovery spends the code on disk before returning the key, sets a new passphrase, and
  deliberately leaves the other four codes working.
- `forget` removes a registry row and never touches a file.
- Backup writes one archive holding the database and its vault, with a manifest carrying
  a SHA-256 of each, checkpointing the write-ahead log first. Restore verifies the whole
  archive before writing a byte and refuses to overwrite an existing company.
- A hand-written ZIP reader and writer, about two hundred lines and no dependency, which
  rejects any entry name containing a separator, a drive letter or a leading dot at parse
  time.
- A missing database and a missing vault are reported as what they are, before any
  decryption is attempted — never as "wrong passphrase".

#### Processes and IPC

- Three-process Electron build: main, a sandboxed CommonJS preload, and the renderer.
  `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- `CofferApi` as the single typed contract, with the renderer proxy generated from it —
  `api.companies.list()` reaches `companies:list` with no wiring in between, and no bare
  `ipcRenderer.invoke` exists anywhere.
- A runtime enumeration of the contract, and a startup assertion that every declared
  method has a handler. A missing handler crashes the app at boot rather than at click
  time.
- A `Result` envelope enforced on both sides of the bridge, with stable error codes and
  messages written for users. Internal detail — file paths, stack traces — never crosses.
- A path allowlist governing what "reveal in file manager" may open.
- The renderer shell: title bar, sidebar, screen host, command palette, toasts, theme
  control and design tokens.

#### Build, packaging and CI

- electron-vite with the preload pinned to CommonJS, because a sandboxed `.mjs` preload
  leaves `window.coffer` silently undefined.
- TypeScript `strict` with `noUncheckedIndexedAccess`, across two projects.
- ESLint rules that enforce the structural constraints rather than leaving them to
  review: `domain/` may import no Node built-in, no `electron`, and nothing from `db/`,
  `services/` or `ipc/`; nothing outside `regimes/` may import a concrete regime.
- Vitest, with coverage thresholds enforced on `domain/`, `regimes/` and `security/` at
  90% lines, 90% functions and 85% branches.
- Native-module verification on install and in CI, under plain Node and inside a real
  Electron main process. Nothing is compiled — both native modules ship Node-API
  prebuilds.
- electron-builder targets: NSIS, dmg for x64 and arm64, AppImage and deb. Uninstalling
  never deletes a company database.
- CI on every push and pull request: typecheck, lint and test on one runner, plus a build
  on all three platforms.
- A release workflow producing four artefacts and a `SHA256SUMS.txt` generated from what
  is actually attached. Builds are unsigned by decision — signing credentials are never
  read from a runner — so the checksum file is the only integrity signal and is not
  optional.
- Grouped Dependabot updates, with majors of the load-bearing toolchain ignored because
  each is an architectural decision with a paragraph attached.

#### The ledger contract

No ledger yet — this is the contract Phase 1 is built against, landed on its own so that
work on the chart of accounts, the periods and the posting engine cannot disagree about
what an entry is.

- **[accounting]** The five invariants (`main/domain/ledger/types.ts`): every entry
  balances; the ledger holds only posted entries, with no draft state and no status
  column; a posted entry is immutable and corrections are reversals; no balance is ever
  stored; and a line is a debit or a credit, never both and never neither.
- **[accounting]** `AccountType` and its normal balances, as definitions rather than
  configuration, with the accounting equation pinned as a test.
- Account roles — semantic slots like `accounts-receivable` that posting rules ask for
  instead of naming an account code, so a user may renumber their whole chart of
  accounts without breaking a rule. Tax accounts are deliberately not roles; a regime
  has as many as it has components, and naming them would put GST in `domain/`.
- `PostingRule`, `PostingContext` and `AccountResolver`: a rule is a pure function from
  a document to a draft entry, and everything it needs to consult arrives already
  resolved. A rule that needs something new gets it added to the context, never by
  importing a repository into `domain/`.
- **[accounting]** `checkDraft` reports every structural problem in one pass rather than
  the first, and stays quiet about the balance while a line is malformed — a negative
  amount unbalances the entry too, and leading with "unbalanced" points at the symptom.
- Kysely typings and reserved migrations 0002–0004 for `accounts`, `account_roles`,
  `accounting_periods`, `journal_entries` and `journal_lines`.
- The balanced-entry invariant is enforced three times: in the domain, in the repository
  before commit, and by the database. SQLite has no deferred triggers, so the lines are
  written before their parent entry with a deferred foreign key, which lets a
  `BEFORE INSERT` trigger on the entry see the complete set and refuse it.

#### The chart of accounts

- Migration `0002`: `accounts` and `account_roles`. The tree rules are triggers, not
  just repository checks — a parent must be a group, and a child carries its parent's
  type. Each one, if broken, corrupts reports rather than throwing, so it is enforced
  where nothing can bypass it.
- The accounts repository: create, rename, renumber, move, archive and delete, with
  cycle detection on a move. Depth and normal balance are computed on read and never
  stored; a stored depth is wrong the moment an account is moved.
- **[accounting]** An account's `type` cannot be changed once the account exists. Every
  figure posted to it was classified by that type, so changing it would silently move a
  balance between the balance sheet and the profit and loss with nothing recording it.
- A seedable default chart of accounts — cash, bank, receivables, payables, stock,
  sales, purchases and the usual overheads — written into a new company in one
  transaction, or not at all. It names no tax regime: `Duties and Taxes` is an empty
  group, and the per-component accounts are added when the company's regime is known.
- `buildResolver` loads the chart into the pure `AccountResolver` the domain posts
  against, including archived accounts, so posting to one fails as `ACCOUNT_ARCHIVED`
  rather than as "no such account".
- Tax component accounts are found through role names built from the regime's own
  component code — `tax-output-cgst` — so each component has its own account while the
  vocabulary reaches the database as data and never as a type.

#### Accounting periods

- Migration `0003`: `accounting_periods`. Periods are generated from the regime's
  fiscal-year rule — twelve months or four quarters, contiguous, the last ending on the
  fiscal year's last day, for any start month and any start day from 1 to 28.
- **[accounting]** Periods cannot overlap, enforced by a trigger. Two periods covering
  the same day would make an entry's period a matter of which row was found first, and
  the same figure would appear in two months' returns or in neither.
- **[accounting]** A consequence of that, and the reason there is no granularity setting:
  a set of books uses one period length throughout. `Apr 2026` overlaps `Q1 2026-27`, so
  a company keeping months cannot also keep quarters.
- **[accounting]** A period's span never changes. Only `status` and `closed_at` may be
  updated; a trigger refuses an `UPDATE` naming any other column, including one writing
  the same value back. Moving a boundary would silently move every entry already posted
  either side of it.
- **[accounting]** `closed` reopens, `locked` does not. Locking is final — refused on
  `UPDATE` and on `DELETE`, so that unlocking is not one delete and one insert away.
  There is deliberately no escape hatch: an error found after filing is corrected in the
  current open period, which is what an amended return already expects.
- Periods close in order, and a closed period will not reopen underneath a later locked
  one. Closing March while January is open would leave the year-end close computing
  retained earnings over a half-finished year with nothing reporting it.
- `requirePostablePeriod` separates "the books have no period covering this date" from
  "that period is closed", because the two need different offers in front of a user.
- A fiscal year the books have not used can be removed, which is what makes a company
  created with the wrong rule or the wrong period length recoverable.

#### Documentation

- Architecture, conventions, getting started, the data model, adding a tax regime,
  security for users, a good-first-issues list, and an index tying them together.
- Contributor, security and community documentation; issue and pull-request templates;
  CODEOWNERS.

### Changed

Nothing has been released, so these correct decisions made earlier in Phase 0 rather
than changing behaviour anyone has seen.

- **[accounting]** The rate storage scale is 3dp, not 2dp. Half of India's 0.25% slab is
  0.125%, and at two places an invoice would print CGST at 0.13% — a rate the tax was
  never computed from. No stored rate column exists yet, so nothing is migrated.
- ESLint's purity rule for `domain/` now anchors its patterns to the start of an import
  specifier. Unanchored, the entry for Node's legacy `domain` module also matched
  `@main/domain/money`, so the first cross-module import inside `domain/` was reported
  as a filesystem violation. Both directions are covered by a probe rather than assumed.

[Unreleased]: https://github.com/abinauv/coffer/commits/main
