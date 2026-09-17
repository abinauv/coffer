# Changelog

All notable changes to Coffer are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries that change how money, tax or ledger postings are calculated are marked
**[accounting]**. Read those carefully before upgrading — they can change figures on
documents you have already issued.

## [Unreleased]

**The first alpha.** No release has been made, so everything below is new — this is one
section covering the whole of the work so far rather than a diff against something people
are running.

What it comes to, for somebody deciding whether to open it: **you can keep a real set of
books in Coffer.** Create a company, and it arrives with a chart of accounts, a fiscal
year of periods, numbering series for all nine numbered kinds, the common units of measure
and a warehouse. Raise quotations, sales invoices, credit notes, purchase bills and debit
notes; issue them, which numbers them and posts them in one transaction; print them or
save them as a PDF; record receipts, payments and refunds both ways, and say which
documents they settle; set a credit note against the invoice it settles. Read a trial
balance, a balance sheet, a profit and loss, a day book, an account ledger and an aged
report on either side — none of which is stored, all of which are summed from the journal
when asked. Look over GSTR-1 and GSTR-3B for any month. Back the whole thing up into one
archive that holds the database and the keys that open it.

Some things are built and **not reachable from the app**, and they are listed here as what
they are rather than left to be discovered: the stock register, valued at moving weighted
average (`db/repos/stock.ts`); closing a period and a year, opening balances and journal
entries, which the ledger's contract carries and no screen offers; input-tax-credit
eligibility per line; and four import readers for CSV, Tally XML and Zoho Books
(`services/importers/`). GSTR-1 and GSTR-3B are reachable, and carry a `SCHEMA_UNVERIFIED`
notice on every artefact they produce: the arithmetic is pinned to the paisa against
hand-worked fixtures, and the shape has never been validated against GSTN's own schema or
been through a filing cycle.

Builds are unsigned. There is no telemetry, no account and no network call in any core
path.

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
- Two Vitest projects, split by directory: `main`, `preload` and `shared` run under Node,
  and `renderer` runs under a real DOM. A renderer test runs in a browser environment
  because the renderer runs in a browser.
- happy-dom rather than jsdom, chosen by measurement. jsdom 30 exposes an
  `HTMLDialogElement` constructor with no `showModal()` on it and no `window.matchMedia`
  at all — so every modal in the product is unopenable and untestable, while a smoke test
  checking `typeof HTMLDialogElement` still reports success. It is also fifty times
  slower to start.
- A screen-test harness that stubs `window.coffer` through the **real** `createApiProxy`,
  so a stub is found by the channel production would actually call rather than by a
  hand-written object that keeps answering after a method is renamed. A channel nothing
  answers fails the test by name, because `callApi` is built to swallow exactly that and
  would otherwise render it as an ordinary error notice.
- The chart of accounts and the trial balance now have rendering tests — 31 of them,
  every mutation killed. Two conventions came out of the exercise and are written down in
  `docs/CONVENTIONS.md §6`: assert figures by column position rather than by presence,
  since a swapped debit and credit passes either way; and assert screen state by what
  crosses the bridge rather than by what is drawn, since a `<select>` whose chosen option
  has been removed falls back to the first one on its own and reads correctly whether or
  not the state behind it was cleared.
- Native-module verification on install and in CI, under plain Node and inside a real
  Electron main process. Nothing is compiled — both native modules ship Node-API
  prebuilds.
- electron-builder targets: NSIS, dmg for x64 and arm64, AppImage and deb. Uninstalling
  never deletes a company database.
- CI on every push and pull request: typecheck, lint and test on one runner, plus a build
  on all three platforms.
- A release workflow producing four artefacts, a `SHA256SUMS.txt` generated from what is
  actually attached, and a signed build-provenance attestation for every attached file,
  checkable with `gh attestation verify`. Builds are unsigned by decision — signing
  credentials are never read from a runner — so neither check is optional.
- Grouped Dependabot updates, with majors of the load-bearing toolchain ignored because
  each is an architectural decision with a paragraph attached.

#### The ledger contract

The contract the ledger was built against, landed before any of it so that work on the
chart of accounts, the periods and the posting engine could not disagree about what an
entry is.

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
- **[accounting]** A new company's chart now holds those accounts. `TaxRegime` gained
  `taxComponents()`, and `taxAccountsFor` turns each component into two accounts on
  opposite sides of the balance sheet: output tax as a liability under `Duties and
Taxes`, input tax as an asset under `Taxes Recoverable`. Netting them into one would
  hide both figures behind their difference, and GSTR-3B asks for output tax in table
  3.1 and input credit in table 4.
- Nothing in that path knows what GST is. A component arrives as a code and a label, and
  the account's name, code and role are derived — read `db/repos/tax-accounts.ts` for
  `CGST` and you will not find it.
- All four Indian components get accounts, UTGST included, though most companies never
  levy it. The alternative is worse than an unused row: the accounts a company holds
  would depend on where it was sitting when the books were made, and invoicing a customer
  in a union territory for the first time would need a chart migration to post an
  ordinary sale.

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

#### The ledger

- Migration `0004`: `journal_entries` and `journal_lines`. Posting, reversing, drilling
  back to the document an entry came from, the trial balance, opening balances and the
  year-end close.
- **[accounting]** Every entry balances, checked in the domain, in the repository and by
  the database. Lines are written **before** their parent entry so that a `BEFORE INSERT`
  trigger can see a complete entry and refuse an unbalanced one.
- **[accounting]** Three triggers, not the deferred foreign key, are what hold that order
  in place. The key was expected to do it and does not: an entry written before its lines
  commits happily, and that order skips the balance check entirely, because the sum of no
  lines is zero. Measured rather than assumed, and the ledger contract has been corrected.
- **[accounting]** Money is summed in SQL as integer paise, never as `REAL`. Ten rows of
  `'0.10'` summed as `REAL` give 1, but three `'0.07'`s plus `'1234567.89'` plus `'0.01'`
  give `1234568.1099999999`. A `GLOB` CHECK pins every stored amount to exactly two
  decimal places and no sign, which is what makes the integer arithmetic exact.
- **[accounting]** A posted entry is never edited or deleted — triggers refuse both, on
  the entry and on its lines. A correction is a reversing entry, and `reverses_entry_id`
  is `UNIQUE`, so an entry is reversible at most once by constraint.
- **[accounting]** A reversal may name an account archived since the original was posted.
  Archiving is a preference about pickers, not an accounting rule, and an entry that
  cannot be corrected is a worse problem than the one that check would have solved.
- Entry numbers are sequential per fiscal year — `JV-2026-27-0043` — taken from the
  numeric suffix rather than a text sort, so the series keeps counting past 9999.
- **[accounting]** The trial balance ties, over any date range, and never includes a group
  account. No balance is stored anywhere; every one is a sum over lines when asked.
- **[accounting]** Opening balances take one signed amount per account, positive in that
  account's own normal direction, so a user copies their old trial balance once rather
  than translating it into sides. The difference goes to opening balance equity — a
  visible figure to chase rather than a refusal that would send them back to a
  spreadsheet.
- **[accounting]** The year-end close moves income and expense to retained earnings and
  starts the next year at zero. It posts as an ordinary entry, so it balances by the same
  trigger and can be reversed if it was run too early. It locks nothing: locking is a
  decision about a filed return, not about arithmetic.

#### The statements

- **[accounting]** Balance sheet, profit and loss, an account's ledger with a running
  balance, and the day book. Nothing is stored and nothing is cached; every figure is
  summed from `journal_lines` at the moment it is asked for.
- **[accounting]** The balance sheet carries the profit no year-end close has moved yet,
  on the face of the sheet inside equity. Without it the equation does not close:
  regrouping every balanced entry by account type gives
  `assets = liabilities + equity + (income - expenses)`, and the last bracket is that
  line. Cumulative-from-inception needs no special case for it, because a close moves
  each closed year into retained earnings and leaves income and expense at zero.
- **[accounting]** A statement drops a row when nothing was posted to it, never when it
  totals zero. A group holding +2,000 of petty cash and -2,000 of bank nets to nothing
  and still appears with both children under it — four thousand rupees the reader has to
  be able to see. The first version of the rule tested the total, and made real money
  disappear from a sheet that still balanced.
- **[accounting]** An account in credit stays on its own side. An overdrawn bank is a
  negative asset, marked as contra, not reclassified as a liability — moving it would
  misstate both sides and nothing in the ledger says it should move.
- **[accounting]** An account ledger opens with what the account held immediately before
  the range, from a strict `<` comparison. A `<=` would count the first day into the
  opening figure and again as a row, putting the ledger out by exactly that day from its
  first line onward; without an opening balance at all, a month's ledger closes on that
  month's movement wearing the closing balance's name.
- The particulars column names the account on the other side, or says `Split` when the
  entry touched several — the convention every hand-kept ledger uses.
- A loss is called a loss. The figure stays signed, but `Net profit: -15,000.00` asks a
  reader to notice a minus sign in a column of figures, and they will not.
- A read-only `reports` IPC group, separate from `ledger` because nothing in it can
  change a figure — a `reports:` channel in a log is provably not what altered anyone's
  books.
- Four screens: balance sheet, profit and loss, day book and account ledger, each with
  rendering tests. 41 mutations against them, all killed.

#### The document contract

The shapes and rules the document tables were built against, landed first for the same
reason the ledger contract was: types and pure functions only, with the migrations that
would implement them reserved rather than written.

- **[accounting]** A document is a draft until it is issued, and frozen afterwards. An
  issued tax invoice is corrected by a credit note, never by an edit: the customer holds
  a copy and the return may already be filed. This is the ledger's immutability
  invariant seen from the document side.
- **[accounting]** The number is allocated at issue and never released. Rule 46(b)
  requires an invoice series to be consecutive for a financial year, so a draft holds no
  number — one handed out and then abandoned leaves a gap somebody has to explain — and
  cancelling keeps the number rather than freeing it. That is why cancelling and deleting
  are different operations rather than one with a flag.
- **[accounting]** Issuing is one transaction: status, number and journal entry together
  or not at all. There is no "issued but not yet posted" state, because that is a window
  in which the sales register and the trial balance disagree and no query can say which
  one is right.
- **[accounting]** Nothing derivable is stored. A document has no `grand_total` column;
  its figures are a fold over its lines, computed when asked. What _is_ stored is the tax
  the regime returned, per line and per component — that is the regime's answer as of the
  document's own date, and an invoice must reprint years later exactly as it was taxed
  and exactly as it was filed.
- **[accounting]** What is outstanding against a document is a ledger fact, not a
  document field: the movement its entry made on the party's control account, less what
  has been allocated to it. A cancelled invoice's entry is reversed, so its outstanding
  reaches zero without any code making it; and an aged receivables report cannot disagree
  with the balance sheet, because they are the same sum grouped differently.
- One table for every trade document — quotation, sales invoice, credit note, purchase
  bill, debit note. They differ in three fields and are otherwise identical, and five
  tables would mean five copies of the tax summary and a Phase 3 that is a schema change
  rather than a posting rule.
- **[accounting]** The tax summary keeps one row per component _and_ rate. A document
  carrying 18% goods and 5% freight has two CGST figures on it, and a single combined
  `CGST` line is a figure no customer can check and no return has a box for.
- **[accounting]** Rounding is recorded on the document, not read from settings when it
  is opened. Totals are derived every time, possibly years later, and a company setting
  that has changed since would otherwise silently restate an issued invoice.
- Numbering is data: prefix, suffix, separator, width, whether the fiscal year appears,
  and whether the counter resets. Whether the year is _shown_ and whether it _resets_ are
  independent, because businesses ask for both combinations. A sequence that outgrows its
  width gets longer rather than being truncated into a number an earlier document holds.
- `TaxRegime.validateDocumentNumber` — India caps an invoice number at sixteen
  characters and allows only letters, digits, `-` and `/`. `INV/2026-27/0001` is exactly
  sixteen. Breaking the rule fails at the portal weeks later, not at the desk where it
  was typed, by which time every invoice in the month carries it.

#### Parties — customers and vendors (migration `0005`)

- A customer and a vendor are one table with two flags, because in a small business they
  are very often the same firm: you buy transport from someone you sell to, and your
  landlord buys from you. Two tables would mean two records for one company, two
  outstanding balances, two opening figures, and a set-off nobody reconciles.
  `isCustomer` and `isVendor` say what a party _may_ be, not what it has done — a
  customer who has never bought is still a customer — and only a party that is neither is
  refused.
- **[accounting]** A party is not a ledger account. Tally gives every customer its own
  account under Sundry Debtors; Coffer keeps one control account and puts `party_id` on
  the journal line. A chart of accounts holding four hundred customers is not a chart
  anybody can read, and reports drop nothing that has been posted to, so every one of
  those accounts would appear on the balance sheet. A party's balance is a sum over the
  same lines the control account totals, grouped differently — which is why an aged
  receivables report and the balance sheet cannot disagree.
- **[accounting]** A line posting to the account mapped to `accounts-receivable` or
  `accounts-payable` must name a party. This is a database trigger rather than a check in
  code, because money on the balance sheet that is owed by nobody is not an error anyone
  sees — it is a control account that quietly stops agreeing with the party balances
  beneath it, from that day on. The rule reads `account_roles` live, so remapping the
  role moves the rule with it, and it looks the account up by role rather than by type:
  most assets are not receivables, and `Advances to staff` is nobody's unpaid invoice.
- A party is _required_ on a control line and _permitted_ anywhere else. The mirror rule
  was written and then removed: an advance received from a customer sits under a
  liability account that is not the receivables control, and it is unambiguously that
  customer's money.
- **[accounting]** An opening balance is taken one party at a time. A business adopting
  Coffer is owed money by five customers, and a single opening receivable produces no
  aged report, allocates against nothing, and disagrees with every statement from day
  one. The same account may therefore appear twice when the parties differ — and not
  otherwise.
- Names are unique ignoring case, and a registration number is unique when it is present.
  Two customers really can both be called `Sharma Enterprises`, and this forces whoever
  enters the second to say which; two parties carrying one GSTIN are one party entered
  twice. Unregistered parties are common and are not duplicates of each other.
- An archived party takes nothing new, refused in the repository rather than by a
  trigger. A reversal re-inserts the original entry's lines carrying the party they
  already had, so a trigger would make every entry involving a party unreversible the
  moment that party was archived — the same decision archived accounts got, and for the
  same reason: an entry that cannot be corrected is the worse problem.
- A journal line reads back with its party's name, over a left join. An inner one would
  drop every line that has no party, which is most of them.
- The repository does not validate registration numbers. What a valid one looks like is
  the regime's business, and `db/` may not name a concrete regime.

#### Parties, reachable from the app

- The `parties` IPC group — list, get, create, update, archive, delete. Customers and
  vendors are one group because they are one table; `PartyRole` filters a list rather than
  naming a second kind of record. There is no balance on it and will not be: what a party
  owes is a sum over the journal lines carrying their id, and it belongs with the reports
  it will be aged alongside.
- **[accounting]** A journal line and an opening balance now carry the party across the
  IPC boundary. Until this landed the boundary silently dropped it, so a credit sale
  posted through the app was refused by the database for naming nobody — an error with no
  cause the user could see and nothing in the screen to fix.
- **[accounting]** A registration number is checked by the regime the books were created
  under, not by the build's default, and where it encodes a jurisdiction that jurisdiction
  is filled in. A GSTIN's first two digits are the state, the state decides the place of
  supply, and the place of supply decides CGST+SGST against IGST.
- **[accounting]** A registration number and a jurisdiction that disagree are refused
  rather than quietly reconciled. Picking either one silently would be wrong on half the
  invoices raised for that party, and invisible on all of them.
- **[accounting]** `ValidationResult.normalisedValue` — a regime that accepts a number now
  also says what form it should be kept in. GSTIN validation upper-cases and strips
  whitespace before it checks anything, so `33aabcc1234d1zi` is a _valid_ number that
  would have been stored, and printed on a tax invoice, exactly as it was typed.
  Classification codes normalise the same way: `8471.30` is valid and `847130` is what is
  stored, because a code kept with a dot in it would never match the tariff again.
- A blank registration number is the absence of one, not a bad one. A form with an empty
  GSTIN box sends `''`, and putting that to the regime would tell somebody who correctly
  has no registration that their registration is invalid.
- `OpenBooks` (`main/books/`) — one object answering which database is open and which
  regime these books were set up under, composed by every service above the repositories
  rather than copied into each. Two answers to "which company is open" ends with one of
  them stale after a close and reopen.

#### Customers and vendors, on screen

- Two entries in the sidebar — **Customers** under Sales and **Vendors** under Purchases —
  and one screen behind them. Those are the words a business uses; the record underneath
  is the same one, and both screens say so, because somebody who only ever opens Vendors
  would otherwise never learn that the firm they buy transport from is the same record as
  the firm they sell to. An unfiltered **Parties** list is registered without a sidebar
  entry, for when the side is what somebody cannot remember.
- Search covers the name, the registration number and the city — the city because that is
  what tells two firms called `Sharma Enterprises` apart, which is exactly the case the
  unique name index forces somebody to resolve. Filtered in the renderer, so it is instant
  and cannot fall behind what was typed; `parties.list` still takes a `search` argument,
  for the long list an invoice's party picker will be.
- A new record starts on the side the screen was opened from. A party must be a customer,
  a vendor or both, so defaulting to neither would make the first save fail for everybody,
  and defaulting to customer on the Vendors screen would quietly create the wrong thing.
- **No balances on this screen**, for the reason the chart of accounts carries none. This
  is who the parties are; what they owe is a sum over the ledger and belongs with the aged
  report it will be grouped by.
- Archive rather than delete, and the confirmation says what survives — everything already
  posted stays exactly as it is. An edit that takes a party off the list it was made on
  says where they went rather than letting the row vanish like a deletion.
- The registration number is not judged in the renderer. Whether a GSTIN is real is the
  regime's question, its answer is a sentence written for the user, and a second weaker
  check here would either disagree with it or repeat it.

#### What goes on a line, and what a number is (migrations `0006`, `0007`)

- **[accounting]** Items and units of measure. Every column on an item is a **default for
  a document line, never a lookup the line performs later** — a line stores its own
  description, price, unit and tax rate, so repricing an item or renaming it cannot rewrite
  an invoice already issued.
- Custom units are the point. A business measures in bags, bundles or dozens, and being
  forced onto a fixed list is the thing that makes software feel foreign. India's UQC is a
  closed set, but that is a _filing_ concern: a separate `regime_code` maps a company's own
  unit onto it when a return is prepared, so a company invoicing in `BAGS` keeps saying
  `BAGS` on its own paperwork.
- A unit's code is its identity — it is what the user types, what prints, and what an item
  refers to, so there is no surrogate id to join through. Codes are upper case and trimmed,
  enforced by the database rather than by convention: `kg`, ` KG` and `KG ` are all a second
  row that prints as the first one and totals separately from it.
- An item is sold, purchased, or both — a party's two flags in another table, for the same
  reason. A record that is neither cannot reach any picker or any document line.
- **[accounting]** An item's price is money at two places and its tax rate is a rate at
  three, each with the CHECK that makes the integer-paise arithmetic sound. Half of India's
  0.25% slab is 0.125%, and at two places an invoice would print a rate the tax was never
  computed from.
- **[accounting]** Numbering series, and the counters behind them. The number is allocated
  at issue and never released: a draft holds none, because one handed out and abandoned
  leaves a gap somebody has to explain to an officer, and a cancelled document keeps its.
- **[accounting]** Whether the fiscal year is _printed_ and whether the counter _resets_ on
  it are independent, and both combinations are real. A number is refused rather than
  guessed when the series needs a year and none was given — either because the year prints
  and cannot be built without it, or because the counter to draw from is chosen by it and
  guessing would hand out a number twice.
- **[accounting]** At most one default series per document kind, among the series a
  document could actually take. Two defaults means "which series does a new invoice get?"
  is answered by whichever row the query found first.
- **[accounting]** Three triggers guard one fact: a series that has handed out a number
  cannot have that undone. A counter may only move forward, may not be deleted, and a
  series that has issued may not change its prefix, width, separator, year flag or reset
  rule. Reissuing a number is not an error anybody sees — it is a second invoice carrying a
  number an officer will match against the first.
- A counter's scope key is **never NULL**: the empty string stands for a series that never
  resets, and the repository maps that to and from the domain's `null`. A NULL in a unique
  index does not collide, so a nullable scope column would admit two counter rows for one
  series, and two counters hand the same number to two invoices.
- Allocation reads and advances in a single statement inside the issuing transaction, so
  two documents issued at the same moment cannot take the same number. Demonstrated by
  allocating in bulk and asserting the set has no duplicates and no gaps, rather than
  asserted in a comment.
- `repoErrorFrom` now maps every code a trigger raises, checked by a test that **reads the
  migrations** rather than a list somebody remembered to update. The two had silently
  fallen out of step: `0007` raised `SERIES_IN_USE` from three triggers and nothing mapped
  it, and no test failed, because the repository's own check answers first on every path
  except the one the mapping exists for.

#### The sales invoice posting rule

The first `PostingRule` in the codebase, and the point at which `AccountResolver`,
`documentTotals` and `forTaxComponent` stop being contracts. Pure — same document and
same context, same entry, every time — so each test is a document written down beside the
entry it must produce, and a change in accounting treatment cannot happen without one of
them going red.

- **[accounting]** Receivables is debited with the **grand total** — what the customer
  owes, which is what the document says at the bottom. Any other figure makes the
  receivables ledger disagree with the paper the customer is holding.
- **[accounting]** Revenue is credited with the **taxable value**, never the tax. Tax is
  the government's money passing through; a business that credited sales with it would
  overstate turnover by the rate of GST, consistently, so nothing would look wrong.
- **[accounting]** A charge — freight, packing, insurance — recovered from the customer is
  taxable at the same rate as the supply it sits on and is **not turnover**. It posts to
  `freight-outward`, which is an expense account in the shipped chart, so the recovery
  nets against freight actually paid. A business wanting it shown separately names an
  account on the line.
- **[accounting]** The ledger groups tax by **component**; the printed document groups it
  by **component and rate**. An invoice carrying 18% goods and 5% freight prints
  `CGST @ 9%` and `CGST @ 2.5%` as two lines a customer can check, and posts one credit to
  output CGST. The sums across the two groupings are identical, which is the property the
  tests pin.
- **[accounting]** Rounding posts to `round-off` from the document's **own frozen policy**,
  never from a setting read today — reprinting an invoice years later cannot restate it.
  A policy of `none` writes no line at all rather than a zero one.
- Lines sharing an account are gathered into one posting line. The document holds the line
  detail; repeating fifty lines in the ledger makes the day book unreadable and tells a
  reader nothing the invoice does not.
- **[accounting]** A line whose account total comes to nothing produces no posting line,
  and one that comes to a negative becomes a debit rather than a negative credit — a free
  sample and an agreed rebate respectively, both of which invariant 5 would otherwise
  refuse.
- A missing account is fatal and says which one. An invoice with nowhere to put the
  receivable cannot post, and a tax component with no account is refused rather than
  quietly sent to sales — which would overstate turnover and understate a liability in a
  way every report agrees with.
- `PostingError` in `domain/ledger` — the one error class the pure layer owns. `checkDraft`
  beside it returns its problems, because a user who typed a journal wants every bad line
  at once; a posting rule returns an `EntryDraft` and has no half-built entry to hand back.

#### The document itself (migration `0008`)

`documents`, `document_lines`, `document_line_taxes` — one table for all five kinds, and
the draft side of a document's life. Issuing and cancelling are the next section: they are
one transaction spanning the numbering counter, the posting rule and the ledger.

- **[accounting]** Rule 1, as triggers: a document is frozen the moment it leaves draft,
  and so are its lines. A line has no status of its own and never will — a document and
  its lines could then disagree about whether the document was editable, and there is no
  answer to which is right.
- **[accounting]** Rule 2, as one CHECK in both directions: a draft has no number and
  anything else has one. The failure it prevents is not only a numbered draft but an
  **issued document with no number**, which would print blank and file as nothing. A
  cancelled document keeps its number, which is why cancelling and deleting are two
  operations rather than one with a flag.
- **[accounting]** Rule 3, as a CHECK: an issued document has a journal entry. There is no
  representable state in which a document is issued and has not posted, so the window in
  which the sales register and the trial balance disagree is not one anybody has to
  remember to close — it is a row the database will not hold. `entry_id` is UNIQUE, so two
  documents cannot claim the same entry.
- **[accounting]** Rule 4, as an absence: no `grand_total`, no `total_tax`, no
  `outstanding`. Every figure on the foot of a document is folded over its lines on the
  way out, by the same `documentTotals` the posting rule uses — so the printed total and
  the journal entry are one piece of arithmetic run twice rather than two figures kept in
  step. The cost is stated in the repository: listing a register totals every document on
  the page.
- **[accounting]** Line figures may be **negative** — a rebate shown as a line, a returned
  quantity — while the ledger's own columns stay unsigned, because a journal line's side
  _is_ its sign. Measured, not read: `CAST(REPLACE('-200.00', '.', '') AS INTEGER)` is
  -20000, and the shape still refuses `200.0`, `200`, `1e5` and `-.50`, which is what
  makes the cast safe.
- A document's number is unique **within its kind**, not overall. `INV/1` on an invoice
  and on a credit note are two documents in two series, and a business numbering both from
  1 is doing nothing wrong; two sales invoices carrying one number is what an officer
  matches against, and the second is unfileable.
- Lines are **replaced, never patched**. The grid the user is looking at is the document,
  so a per-line protocol would be a second way to say the same thing, with its own
  ordering and identity bugs.
- **[accounting]** A line's stated taxable amount is checked against its own quantity,
  price and discount. The caller computes it because the caller asked the regime; this is
  what stops a bug there putting a figure in the books that the invoice does not show.
- A draft may be created empty and filled in. The rule that matters is that an empty
  document cannot be **issued**, which is about the transition rather than the row.

#### Issuing and cancelling (migrations `0009`, `0010`)

- **[accounting]** `issueDocument` — one transaction spanning the numbering counter, the
  posting rule and the ledger. The number is allocated and advanced in a single statement
  inside it, so two invoices issued at the same instant cannot take the same number.
- **[accounting]** An issued document's **narration** is frozen, and `0009` exists because
  building the issue path turned something `0008` had documented as deliberate into a
  contradiction. Narration is what goes on the journal entry, and a posted entry is
  immutable — so a narration that could still be edited is a document that can be made to
  print something its own day book entry does not say, with nothing recording when the two
  parted company. `series_id` joins it, with less argument needed: the number was already
  frozen and the series that produced it was not.
- **[accounting]** `0010` corrects a CHECK that was stricter than the rule it enforced. A
  quotation is **issued** without **posting** — every kind is issued, only the kinds with a
  source type are also posted — and `0008`'s constraint made a quotation unable to leave
  draft, which meant it could never be numbered. The non-posting kinds are enumerated in
  SQL because a CHECK cannot import a union, and a test asserts the list agrees with
  `postsToLedger` for every kind the domain knows.
- **[accounting]** Cancelling reverses the entry and keeps the number. A cancelled
  document's outstanding therefore reaches zero with no code making it, because the
  reversal is a second entry on the same account.
- A table rebuild in SQLite has a trap the runner now guards: `defer_foreign_keys` is on
  inside the migration transaction and `foreign_key_check` runs before the commit, without
  which `0010` would have silently deleted every document line in the file.

#### Who these books belong to (migration `0011`)

- `company_profile` — the name a tax authority knows, the registration, the jurisdiction,
  the address. At most one row, pinned by `CHECK (id = 'company')`.
- **Identity, not preferences.** The tempting design is a single-row `settings` table that
  grows into the profile plus invoice defaults plus the mail configuration, where every new
  field is a migration that rewrites it. The distinction is not the row count: it is that
  such a table has no subject.
- **It can legitimately be empty**, and no row is seeded. A migration cannot invent a
  company's legal name, so every read answers null until somebody enters one, and books
  with no profile still keep a chart, periods, parties, drafts and a ledger.
- **[accounting]** What it is needed for is tax. `computeTax` takes a supplier and a
  customer and decides CGST+SGST against IGST from whether their jurisdictions match;
  `0005` gave Coffer the customer, and there was nowhere to put the supplier.

#### Receipts, payments, and what they settle (migration `0012`)

- **[accounting]** `receipts` and `receipt_allocations`. A receipt is **posted the moment
  it exists** — `number` and `entry_id` are both NOT NULL, where a document's are both
  nullable. A document has a draft stage because an invoice is built up before it means
  anything; a receipt records money that has already moved. The state `0008` needs a CHECK
  to forbid is one this table cannot represent, and `status` has two values, not three.
- **[accounting]** **An allocation is a matching record and not a posting.** Both the
  invoice's debit and the receipt's credit already carry the party's id, so the control
  account is right the instant the receipt posts, whether or not anybody has said which
  invoice it pays. Which is why an allocation may be rewritten while a posted entry may
  not — and why the row carries no date and no narration, because giving it either would
  invite reporting on it as though money moved when the matching was done.
- **[accounting]** Nothing derivable is stored, again: no `allocated`, no `is_settled`, no
  `paid` status, and nothing added to `documents`. What follows is the identity
  `party control balance = SUM(document outstanding) - SUM(receipt unallocated)`, which is
  what makes it impossible for an aged report and the balance sheet to disagree — provided
  the report shows the money on account rather than dropping it.
- **[accounting]** Four triggers, chosen by one test: does breaking the rule corrupt a
  report silently, or produce something a reader can see? The worst is
  `receipt_allocations_same_party` — an allocation across two parties takes A's outstanding
  down because B paid, and the control account still totals, the trial balance still ties,
  and both statements are quietly wrong from that day on.
- **[accounting]** Cancelling a **receipt** deletes its allocations; cancelling a
  **document** with allocations against it is refused. The asymmetry is the point:
  cancelling a receipt un-does money, and the invoices it was matched to correctly become
  unpaid again, while cancelling a document leaves money that still exists and still
  belongs to the party, and detaching it silently would create on-account money nobody
  decided to create.
- `numbering_series` is rebuilt rather than given a private counter table for receipts.
  `numbering_counters` is the one place in this codebase that can hand the same number to
  two records, and a second copy of it is that failure written twice.
- **There is no `method` column**, and it was considered. The account already says cash or
  bank; what a user needs is the reference — a cheque number, a UTR, a UPI reference — as
  free text, because it is somebody else's format. A closed list in a CHECK is a table
  rebuild on the day somebody's payment app is not on it.
- A missing numbering series was found here as a real bug and not a hypothesis: nothing
  seeded one, `defaultSeriesFor` answered null for every kind, and issuing any document
  from the app failed against a company file while every test passed — because every test
  created its own series first. `setUpBooks` seeds them now.

#### What a note corrects, and when an invoice falls due (`0013`, `0014`)

- **[accounting]** `documents.original_document_id` — the invoice a credit note corrects.
  Nothing in the ledger reads it and nothing could: a note that names its invoice and one
  that does not post identically, because a return adjusts accounts rather than documents.
  It is for GSTR-1 table 9B and for the person reading the paper, and it cannot be
  reconstructed later — two invoices to one customer in one month for one amount are
  ordinary, and nothing in the figures says which one a note undid.
- **[accounting]** It is **optional**, which is the part that looks wrong. One credit note
  against several invoices has been legal since the 2019 amendment to section 34 — the
  post-sale discount a distributor settles at the end of a quarter is exactly that — and a
  NOT NULL column would refuse a document the law permits.
- One `EXISTS` proves the link points at a document that could actually have been corrected
  by this one: same party, issued, same side of the trade facing the other way. A sales
  invoice carrying a link is refused by the same expression with no separate check, and so
  is a self-reference, because a document cannot be two kinds at once.
- **[accounting]** `documents.due_date`, stamped at issue. The derived version needs no
  column — `parties.payment_terms_days` has existed since `0005` — and that is the version
  this migration exists to refuse. Terms are a fact about a party _today_; the date an
  invoice fell due is a fact about _that invoice_. Under the derived version, moving one
  customer from 30 days to 15 silently re-ages every invoice they have ever had, including
  ones in closed periods and on reports already printed, signed and sent to a bank.
- **[accounting]** The rule is a **biconditional** — a due date is present exactly where a
  kind that charges on terms has left draft. A one-way rule leaves the dangerous direction
  legal: an issued invoice with no due date reads to an aged report as a document that is
  never late, so it sits in the newest bucket forever and every total still ties.
- `0014` is the first migration to **backfill** rather than leave a column null, and it
  backfills with the derived value it has just argued against. For documents issued before
  it, the stamp does not exist and cannot be recovered; the party's current terms are the
  best available reconstruction and are exactly right for every file whose terms have not
  changed. What it buys is that the invariant holds for every row, old and new, so the
  report can read the column instead of defending against a null.

#### Refunds, and setting a credit note against an invoice (`0015`, `0016`)

- **[accounting]** Two more voucher kinds: a **refund** is sales-side, moves money out and
  touches receivables; a **refund received** is its purchase-side mirror. Direction
  disagrees with side on half the table now, and the control account follows neither, which
  is what `controlRole` is for.
- **[accounting]** `0015` writes a trigger `0012` considered and declined, and the reversal
  is the interesting half. `0012` argued a wrong pairing was never silent, because with one
  voucher per side it was always cross-account and two control accounts visibly stopped
  agreeing. A refund is on the **same** side as a receipt and moves the **same** control
  account — so a refund allocated to a sales invoice is same party, same side, same
  account, and the only thing wrong is the direction. Nothing looks odd anywhere except an
  aged report saying it does not tie, without being able to say why.
- **[accounting]** `document_offsets` (`0016`) — which invoice a credit note settles. It is
  `receipt_allocations` again **with money at neither end**: an allocation matches two
  movements on one control account that point opposite ways, and that sentence never
  mentioned money. Until this table, an aged report showed the invoice in `Over 90 days`
  and the credit note on account beside it, with nothing that could match them.
- **[accounting]** It is not a column on `documents`, because a note may be set against
  three invoices and an invoice may take credit from two notes — and because one column
  holds no **amount**, which is the whole of what a partial offset is.
- **[accounting]** And it is not `0013`'s link, which already points the right way. That
  records what a note **corrects**, is frozen at issue because a filed return names it, and
  there is one of it. This records what a note **settles**, which is decided afterwards and
  changed as often as the parties agree. A note raised for a short delivery in April may
  perfectly well be set against November's invoice. The two coexist with no rule tying them
  together, deliberately.
- **The set of offsets belongs to the refund end and only to it**, which is why the invoice
  shows them read-only. If either end could replace an overlapping set, the last screen to
  save would silently drop the other's rows.
- Offsetting posts nothing, so it deliberately has **no period check**: saying in July
  which invoice an April credit note settles changes no figure in April, and refusing it
  would be this layer inventing a rule the ledger does not have.

#### Outstanding and ageing

- **[accounting]** What a document has outstanding is its movement on the party's control
  account, in the document's own facing, less what has been allocated to it from vouchers
  and less what has been offset against it from documents. The movement is read off the
  lines that **name the party**, never off a role: a business that repointed that role would
  otherwise find every invoice raised before the change reporting an outstanding of
  nothing, with the report agreeing with itself at zero.
- **[accounting]** There is no `status = 'issued'` filter anywhere in that file and there
  must not be one. A cancelled document's entry is fetched together with the reversal that
  names it, so it comes to zero by arithmetic. A filter is a thing somebody forgets.
- **[accounting]** An aged report is **one control account, decomposed** — not a list of
  unpaid invoices, which is the version that is easy to write and ties to nothing. Its
  items are invoices, credit notes, receipts with money spare, and the opening balance
  somebody typed on the day they adopted Coffer; lines naming no party are grouped under
  "not attributed", never dropped, because dropping them is the one thing that could make
  the foot disagree with the account.
- **[accounting]** A credit never ages. The sign decides the treatment before any date is
  looked at — bucketing credits by date would produce one figure reading as both a problem
  and its own solution.
- **[accounting]** "As at a date" means three things, and each is a separate mistake
  avoided. A movement counts when its **entry** is dated on or before the date, so an
  invoice cancelled in July was outstanding on 30 June. A match counts only when **both
  ends** were in the books by the date — one end alone gives a page showing an invoice
  nobody had yet raised as part paid. And the control balance is summed over the same lines
  with the same filter, by the same function the balance sheet uses.
- **[accounting]** `Not yet due` closes at day 0, and that number is load-bearing: writing
  −1 would move every invoice into the first overdue column on its due date, a day early on
  every statement sent. The bucket table is checked at module load for gaps and overlaps —
  a gap loses a figure in silence, and an overlap is worse, because the figure appears
  twice, the row total is right, and both columns are wrong.
- **[accounting]** Every report carries `ties`, and a test asserts the **items** as well.
  See below: a report that checks itself with a total cannot see an error that appears twice
  with opposite signs.

#### Stock (`0017`, `0018`, `0019`, `0022`)

- **[accounting]** A perpetual stock register: one row per movement, per item, per
  warehouse, valued at moving weighted average. Seven movement kinds — opening, receipt,
  issue, purchase return, sales return, adjustment in, adjustment out — with the direction
  on the kind and never on the sign of a quantity.
- **[accounting]** `items.is_stock_tracked` is **orthogonal to `kind`**, and the whole of
  `0017` is the argument for why. `kind` classifies for filing: goods carry an HSN, a
  service carries a SAC. Plenty of goods are not stocked — a workshop's cleaning materials,
  drill bits and packing tape are goods with an HSN that nobody intends to count — and
  under `kind` alone every one becomes an item that must be received before it can be
  issued. A service may not be stock-tracked, and that is a CHECK rather than a repository
  rule because a CHECK answers both directions at once: the rule nobody writes is the one
  refusing a stock-tracked item turned **into** a service.
- **[accounting]** `warehouses` (`0018`) has a surrogate id where a unit has none. A unit's
  code is its identity because it prints on an invoice line; a warehouse's code is an
  internal handle that nothing prints, so it may be changed. Both code and name are unique
  ignoring case, and the repository compares `COLLATE NOCASE` — a case-sensitive comparison
  against a NOCASE index finds nothing and then trips the index, which is a bug this project
  has already shipped.
- **[accounting]** **No running balance is stored**, and `0019`'s header is the argument.
  The convention against stored balances carves out exactly this shape for a due date —
  stamp it and freeze it — and freezing is not available here: a running balance frozen
  before a back-dated receipt is simply wrong the moment it lands, because the quantity on
  hand really did change. Under moving average a back-dated receipt re-averages the pool, so
  it changes what every issue after it cost.
- **[accounting]** And the argument that ends it: **a stored outward value is a value the
  domain refuses to take back.** An outward movement is valued by the strategy and may not
  carry a cost — `checkMovement` answers `COST_NOT_PERMITTED` — so a row storing what an
  issue cost could not be read back into a `StockMovement` without stripping the figure off
  again. The table stores a movement and nothing a valuation produces.
- **[accounting]** What that costs is stated rather than glossed: every read of a card or of
  stock on hand is a fold over that register's movements, every time. And because an outward
  value is derived at read time, recording a back-dated receipt **changes the cost of a sale
  that has already posted**. The register moves and the ledger cannot, so the answer is a
  valuation adjustment dated at the movement it restates — a second entry, the same shape as
  a reversal, never an edit to the first.
- **[accounting]** Value cannot exist without quantity; quantity can exist without value.
  The asymmetry is deliberate — a free sample taken in at nil and an item written down to
  nothing are both ordinary — and the illegal state is a running total rather than a row, so
  it is refused in the domain where somebody can still fix it. Negative stock is **refused,
  not priced**: valuing it at the last average strands a negative the next receipt silently
  absorbs, and valuing it at nil flatters gross profit until somebody happens to look.
- **[accounting]** `stock_ledger.entry_id` (`0022`) is the other half of the promise that
  inventory on the balance sheet reconciles with the register: every movement writes and
  posts, in one transaction. The trigger states only the half the row can prove — an inward
  movement whose stated cost is not zero must name an entry — because an outward movement's
  value is not in the table to test, and the repository states the other half with the
  strategy's figure in hand. A movement that moved nothing names no entry and is not a hole:
  an entry of two zero lines is refused by the ledger anyway.
- **[accounting]** A sales return comes back at the cost it left at, not today's average.
  The cost of a sale is a fact about the day of the sale, and re-valuing it would let the
  passing of time change the gross profit on a sale already made.
- **[accounting]** `db/repos/stock-reconciliation.test.ts` is the invariant as figures, as
  at every date, item by item and account by account — not merely that the two sides agree.
  An invariant that holds by construction cannot see a movement that failed to post at all,
  because both sides would then be short by the same amount and the comparison would still
  be true.
- A stock movement's kind is not a source document type. One stock-adjustment document
  raises `adjustment-in` for a stock-take surplus and `adjustment-out` for shrinkage; one
  credit note raises a sales return here and something else in the ledger. Two facts, two
  columns, no rule between them.
- The valuation interface was written against the two strategies that do **not** exist yet.
  FIFO and batch are named in the closed union so that a file written by a later build is
  recognisably a later build rather than an unknown string, and `layers`, `slices` and the
  capability flags are there for them. An interface shaped around the method that needs
  least state is an interface the method that needs most will rewrite.

#### How a supply is taxed (`0020`, `0021`)

- **[accounting]** `documents.export_tax_payment` — whether a zero-rated supply left with
  tax paid on it or under an undertaking. **It is not a reporting flag.** A supply that
  leaves the country is inter-state, so the full rate arrives as one integrated component;
  that is right for an export on which tax is paid and refunded, and wrong for one made
  under an undertaking, where no tax is charged at all. The only other way to reach a nil
  figure was to set the line's rate to zero — and a rate with no tax is **zero-rated**, with
  the credit on its inputs refundable, while a rate _of_ zero is **nil-rated**, with that
  credit reversed. Every total on the return adds up either way.
- **[accounting]** `documents.is_reverse_charge` — whether the buyer discharges the tax
  rather than this business. `NOT NULL DEFAULT 0`, and the default is an assertion: forward
  charge is the honest one, because a document wrongly marked reverse charge invents a cash
  liability that no credit may discharge. Not confined by kind — an outward supply under it
  carries a value and no liability, and an inward one makes this business liable for the
  output tax **and** entitled to the input credit.
- **[accounting]** `document_lines.itc_eligibility` (`0021`) — whether credit may be taken,
  and if not, why not. **On the line, because one bill can carry a laptop and a staff car**,
  and because the posting rule needs it there: an ineligible line's tax is not recoverable,
  so it is not an asset and posts to the line's own value account. The two ineligible
  members are kept apart because a return reports blocked and un-availed credit in different
  places and the money is identical.
- **[accounting]** NULL is a fourth state and not one of the three, and `0021` declines to
  backfill for that reason. `eligible` happens to be what the books already assert, but
  writing it into every existing row would make an inference indistinguishable from a
  decision — and would leave the return nothing to raise an issue about.
- `0020` had to rewrite the document freeze and `0021` did not, which is the pair's lesson.
  The document freeze **enumerates** its columns, so a column added afterwards is not frozen
  until the list is rewritten — measured: the update goes straight through. The line freeze
  names no columns at all, because a line is frozen against its parent's status, so a column
  added to `document_lines` is frozen the moment it exists.

#### GST returns, provisionally

- **[accounting]** GSTR-1 — B2B, B2CL, B2CS, CDNR, CDNUR, EXP, HSN and DOC_ISSUE — and
  GSTR-3B, including tables 3.1, 3.2, 4 and the payment table with credit utilisation.
  Built as pure folds over a period's documents: no I/O, no clock, no database.
- **STRUCTURALLY COMPLETE, SCHEMA-UNVERIFIED, and it says so on its own output.** The
  arithmetic is tested to the paisa against fixtures worked by hand. The shape — field
  names, nesting, which figure belongs in which box — was written from the published
  description of the returns and has never been checked against GSTN's own JSON schema nor
  been through a filing cycle. Every artefact carries a `SCHEMA_UNVERIFIED` issue and a
  notice in its own body, so a screen cannot render one as finished without repeating it.
  This is `ARCHITECTURE.md` §6.6 applied to a shape rather than to a rate.
- Fourteen decisions are recorded by name — that the B2CL threshold is strictly greater,
  that UTGST files in the state tax column, that IGST credit is spent before any other and
  its remainder goes to CGST before SGST, that GSTR-1 rounds nowhere and GSTR-3B rounds only
  the cash payable — and a test asserts the list of ids is exactly the list of tests pinning
  them, so it cannot become a page of comments nobody maintains.
- Nine gaps are recorded the same way, ordered by how much is wrong without each. Three more
  were **deleted** when `0020` and `0021` landed, and the deletion is the point: a list of
  what is still owed that carries things already delivered stops being read.
- **[accounting]** A document that does not belong in the period, or is on the wrong side,
  or names a tax component this build does not know, is a **refusal** rather than a dropped
  row. Dropping it would be the failure this project has already shipped once — a filter
  that silently removed data while every total still tied.

#### Printing an invoice — the half that can be tested

- An invoice print model and an HTML template: header, party blocks, lines, the tax summary
  grouped by component and rate, totals, amount in words, and the triplicate set. Rule 48
  wants each copy marked on its face, and a transporter stopped at a check post is expected
  to be carrying the duplicate.
- **The template computes nothing.** No total is summed, no line extended, no sign flipped.
  A test hands it a model whose totals deliberately disagree with its own lines and asserts
  that what prints is the model's total.
- **Escaping is inverted so it cannot be forgotten.** An `html` tagged template escapes
  every interpolated value, and putting markup in requires saying `raw(...)` out loud —
  which happens exactly twice in the template, both on constants declared beside it. A bare
  `escapeHtml` helper would put the decision at every one of the sixty-odd interpolation
  sites, which means the batch that adds one more is the batch that ships a broken party
  name and, the first time one of these is shown in a window, a script-injection route.
  Five characters are escaped rather than three, because values go into attributes and an
  unescaped quote there is the whole injection in one character.
- Dates print the month as a word, so `09 Feb 2027` cannot be read as the 2nd of September,
  and no locale is consulted. The grouping is a required parameter with no default, because
  the default was the lakh/crore grouping and it was silently wrong for everyone outside
  India.
- This was the half that can be pinned against a fixture without an Electron window in the
  room. The other half — the window, `printToPDF` and the print dialog — landed with the
  redesign, below.

#### Reading somebody else's books in

- Four readers, all pure — none opens a file, imports `electron`, reads a clock or writes
  anything. The caller supplies the text and owns the file dialog.
- **CSV**, RFC 4180, for bank statements. Quoting is transport, not meaning: `""` and a bare
  empty field are the same value, because otherwise the meaning of a file would depend on
  which tool wrote it. A **ragged row is reported and never padded** — a short row is either
  a trailing empty column omitted (harmless) or a delimiter inside an unquoted value that
  ate a column boundary (catastrophic, every field after it shifted one place left), and
  padding silently picks the harmless reading for both. A BOM is stripped once, at position
  zero, because Excel writes one, banks export from Excel, and it lands at the front of the
  first heading and nowhere else — which reads exactly like a mapping bug in the first
  column.
- **A date format is an argument, never an inference.** If the importer guesses and is
  wrong, it does not fail: it produces a full year of transactions, every one misdated,
  every total correct and every reconciliation tying at the foot — surfacing months later as
  a return filed against the wrong period. Two-digit years are `20YY` fixed rather than a
  sliding window, because a window that moves with the clock makes the same file import as
  different dates depending on when it is imported.
- **XML**, for Tally exports, and its security is a property of what is not implemented. A
  `<!DOCTYPE` is refused **by name**, with a line and a column, never skipped — that is
  where XXE and billion-laughs both arrive, and skipping one silently invites the caller to
  assume it was handled. Nothing resolves a SYSTEM or PUBLIC identifier, so there is no code
  path that opens a file or a URL. No document can declare an entity, so the only ones that
  expand are the five XML defines, each to one character from a constant. Four caps — depth,
  element count, text length, attributes per element — are on by default, and the scanner is
  iterative so a deep document cannot overflow the stack before a cap is reached.
- Attribute records are backed by `Object.create(null)` and the entity table is a `Map`,
  because an attribute name comes from the file and the file therefore chooses the key.
  Measured: `__proto__` written into a plain object typed `Record<string, string>` silently
  vanishes, and reading it back returns `Object.prototype` — an object where the type says
  string.
- **Tally.** Masters and vouchers, in either file order, one pass. A ledger's role is its
  **parent chain, never its name** — `Kumar & Co` is a customer, a supplier or a rent
  account depending only on where it hangs — and the walk carries a visited set, because a
  group whose parent is itself is a state Tally's own data entry permits and a walker
  without one does not report it, it hangs. Cancelled and optional vouchers are skipped and
  reported, because importing a voided invoice produces totals that are wrong in a way that
  reconciles against the file they came from. An unbalanced voucher is refused with the
  difference named rather than plugged.
- **Zoho Books**, one CSV per entity, eight entities, with the entity named by the caller
  rather than guessed from the filename — a file read as the wrong entity produces a
  plausible batch of nonsense rather than an error.
- **An import is a proposal, not a write.** Nothing in either importer allocates an id or
  touches a database, and **nothing invents an account**: an unresolved name is an error that
  blocks the write, never a silent new account and never a silent trip to Suspense. A party
  named on a transaction _is_ staged, and the distinction is deliberate — inventing an
  account decides where money lands, which is a judgement nobody made; recording a party
  records a name the file already contains.
- Neither reader is reachable from the app yet: there is no import screen and no IPC group.
- Both name their own column and element mappings as a **best-effort default rather than a
  schema**, because neither was written with a sample export to check against. Every field
  is overridable, unclaimed columns are reported, and the headings actually seen are
  recorded on the batch.

#### The app itself

- Screens discovered by a glob rather than a hand-written list, so adding one is a single
  `registerScreens` call and the rail entry, the route and a "Go to…" command all follow.
- **Overview** — four figures from main (owed to you, you owe, cash and bank, the month so
  far), the oldest debts, and what needs attention: overdue documents on either side, drafts
  not yet issued, a backup that is overdue, recovery codes running out, and last month's
  returns not yet looked at. Independent reads, none of which can take the screen down; an
  empty company reads as a beginning rather than as nothing, with a three-step checklist.
- Registers and editors for all five document kinds and all four voucher kinds; customers,
  vendors and the unfiltered party list; items; units; the chart of accounts; numbering
  series; business details; and the six reports.
- **[accounting]** Not one figure on any screen is worked out in the renderer. Where a
  figure would have to be computed to exist, the page does without it: the document editor
  shows the last saved totals marked stale rather than adding up a line as you type, and
  "settle in full" copies main's outstanding rather than summing anything.
- **A register has no page total**, because a sum across rows is the total of a _page_ — a
  number that changes when you press Next and means nothing in either position. And a
  register cannot say a document is overdue, because a document does not know what has been
  paid against it; the aged report can, and does.
- **Nothing can reset a numbering counter**, and the repository has no function to call even
  if a screen wanted one. The rule is said in words on the screen so that its absence reads
  as a decision rather than as a missing feature. `numbering.seedDefaults` is the repair
  path for a company file made before `0012` or `0015`, which would otherwise be unable to
  issue anything.
- Recovery codes are shown once, and the confirmation is not a checkbox: Coffer names one of
  the five and asks for it back. There is no Back, no Skip and no Escape past that screen,
  because the company is already open in main and "later" is not on offer.
- Four unlock failures get four different screens rather than one "wrong passphrase" —
  invalid passphrase, missing database, missing vault, and keys that belong to a different
  file.
- A command palette (Ctrl/Cmd+K) over every screen and every action, where every result
  says where it lives; a title bar correct in four different window-chrome modes; and toasts
  that pause their countdown while you are reaching for the action button.

#### The redesign

- **Paper, Slate and Lapis**, measured for contrast and for colour-blind readers rather than
  asserted, and **IBM Plex** Sans, Serif and Mono bundled as local files under the SIL OFL.
  Nothing loads from the internet, fonts included.
- **The coffered mark** — a square recessed into a square — drawn from one construction for
  the title bar, the app icon, the README banner, the social preview and the installer
  artwork. The installer images carry no text: the installer writes its own words beside
  them.
- **Six sections and a contextual rail** in place of one long sidebar, and a status bar that
  prints the company file's whole path. The rail collapses to icons; Settings chooses
  between the two layouts, and the rail's own button and Ctrl B change the same setting.
- **Components and states from the design system**: four notice tones, and an empty, a
  loading and an error state for every register. Compact density moves four numbers and
  touches no type size.
- **Every existing screen restyled**, from the first run to the reports, with figures
  right-aligned and negatives carrying a sign as well as the negative ink.
- **The Modern key map**: Ctrl K, Ctrl N, Ctrl S, Ctrl F, Ctrl L and Ctrl Shift O; Ctrl Enter
  to issue or record; Ctrl ] and Ctrl [ between sections. Enter advances and never submits,
  and Escape steps back one level and asks before it throws typing away.
- **Screens for four things that had working code and none**: Company → Backups (when the
  last archive was written, where it went, and a reminder); Company → Recovery codes (a
  fresh set, behind the passphrase); printing and PDF, from a hidden window that can run no
  script; and Reports → Tax returns. The importers remain unreachable.
- **Settings**: navigation layout, theme and density, from the title bar with or without a
  company open.
- **The voice**: dates as `17 Sep 2026` whatever locale the operating system reports,
  buttons that name their object, refusals that say what to do next, and no message that
  asks anyone to send their books.

#### The mutation harness

- `npm run mutate` and `scripts/mutations/`: break a rule on purpose, run the tests, put it
  back, and check that something failed. Coverage says a line ran; this says a test would
  have noticed it changing. Every batch so far has found a rule nothing was testing.
- A campaign is a definitions file rather than a claim, so the run is attached to the
  statement. Every campaign carries a **control** that changes nothing and a **canary** that
  must die, anchored on something a test pins by value.
- It has its own tests (`npm run test:scripts`), which is the same argument one level up: a
  tool that reports on your tests needs its own. `CONVENTIONS.md` §6 lists the ten distinct
  ways this harness printed a full page of confident and entirely fictional results in a
  single day — the common symptom being that **a run that never started is
  indistinguishable from a run that caught nothing**.

#### Documentation

- Architecture, conventions, getting started, the data model, adding a tax regime,
  security for users, a good-first-issues list, and an index tying them together.
- Contributor, security and community documentation; issue and pull-request templates;
  CODEOWNERS.
- The README covers what Coffer does today rather than what it will do, where releases
  will appear, how to check a SHA-256, and — the step nobody writes down — which buttons
  get you past Windows SmartScreen and macOS Gatekeeper on an unsigned build.
- The README says in its first paragraph who Coffer is for and what it is, and answers
  the questions people ask before trying it — is it free, does it do GST, where does the
  data live, what if the passphrase is lost — in a FAQ that is honest about what is
  missing. `SUPPORT.md` says where each kind of question goes, `CITATION.cff` makes the
  project citable, and `llms.txt` gives AI assistants an accurate summary to quote.
- Building from source says to install with `--ignore-scripts` and fetch Electron by
  hand. The earlier advice — `npm install` rather than `npm ci` — fails the same way on a
  fresh clone, asking for a C++ compiler to build a binary the package already ships.
- The conduct policy names an e-mail address. It said to send a GitHub direct message,
  which GitHub no longer has.

### Fixed

Nothing has been released, so these are bugs found and corrected before anyone could have
been running them. They are recorded because each one was a wrong answer that agreed with
everything around it, which is the shape this project spends its constraints on.

- **[accounting]** **An aged report reported nonsense rows under a correct total.** A
  refund of 400 against a credit note of 1,180 reported the note at −1,580 and a fully
  settled voucher at +800. `ageing.ts` took an allocation off a document and put it back on
  a receipt, and the comment beside it argued the asymmetry correctly — a document's
  movement was positive and a receipt's negative — so it was the right pair of signs for
  the wrong reason. `0015`'s two new kinds broke it. **Both figures came off a report that
  still said `ties: true`**, because a match is applied at two ends and two equal and
  opposite errors cancel at the foot. A tie is a statement about the arithmetic between the
  rows, not about the rows. It is one function now: a match opposes the end it is on,
  whether that end is a document or a voucher.
- **[accounting]** A fiscal year that broke exactly even could not be closed. The
  retained-earnings line came out as debit `0.00` and credit `0.00` — a both-zero line,
  which invariant 5 refuses — so the close failed with `AMBIGUOUS_LINE`, an error nothing
  on that screen could act on. The cause is that **`isPositive()` is true for zero in
  decimal.js**, because zero carries a positive sign. A year that nets to nothing now
  writes no profit line at all, which is the honest entry: the closing lines already
  balance among themselves. Found by auditing every `isPositive()` in the codebase after
  the same trap made a test in the posting rule fail.
- **[accounting]** A statement dropped a row when its subtree **totalled** zero rather than
  when nothing had been posted to it. A group holding +2,000 of petty cash and −2,000 of
  bank vanished from the balance sheet — four thousand rupees the reader has to be able to
  see — and the sheet still balanced.
- **26 tests were each asserting a different constraint from the one they named.** Measured:
  a `BEFORE INSERT` trigger pre-empts every CHECK on the row, and the most recently created
  trigger fires first — so adding a trigger to a table changes which rule an existing bad
  write reports. Each test was fixed to reach the guard it names, and the behaviour is
  written down in `docs/data-model.md` with the other five things SQLite does that its
  documentation does not lead you to expect.
- `repoErrorFrom` did not map every code a trigger raises, and no test failed. `0007` raised
  `SERIES_IN_USE` from three triggers and nothing mapped it, because the repository's own
  check answers first on every path except the one the mapping exists for. The test now
  **reads the migrations** rather than a list somebody remembered to update.
- `TaxRegime` rate helpers documented themselves as two decimal places. The scale has been
  three from the start — 0.125% is half of India's 0.25% slab — and only the comments were
  wrong, but a reader trusting them would have built the two-place column the scale exists
  to prevent.

Found while building the redesign, by driving the app rather than by its tests:

- **Every installer packed the whole repository.** `app.asar` was 29.6 MB and held `src/`
  with every test and fixture, `docs/`, `scripts/` and `coverage/`: a platform's `files`
  list replaces the shared one, and one beginning with an exclusion makes electron-builder
  prepend `**/*`. A test reads the configuration and the build checks the archive.
- Reverse charge and the export treatment were dropped at the IPC boundary, so no screen
  could set either although the service and the repository honoured both.
- No customer or vendor could be added without a credit limit: a blank limit arrived as
  `''` and was refused. The screen tests stubbed the bridge and passed.
- Every figure column in every ledger table was left-aligned under a header meant to sit
  right.
- Escape on the issue confirmation left it stuck open, because the editor's own Escape
  claimed the keystroke the platform closes a dialog with.
- Every print refusal — a draft, no copies, a page that would not render — reached the
  print dialog as an internal error, because its error class was never registered at the
  IPC boundary.
- The picker wrote "Sep 17, 2026, 11:41 AM" on a machine set up in American English,
  beside registers that write "17 Sep 2026".
- Three reports that did not tie asked the reader to send a backup — somebody's books —
  with their bug report. They ask for the figures on the screen.
- Refusals for an unmapped role sent people to map one in the chart of accounts, which no
  screen can do.
- The Units screen said a new company starts with no units and that "nothing was seeded,
  on purpose", while every new company is given eight.
- The document editor's line grid squeezed its figures until a price read "82." and a tax
  rate "18.0" at a 1440 px window, and scrolled sideways as well.
- On a window shorter than a first-run step, the top of the step sat above the canvas where
  no scrolling reached it, because the canvas centred what did not fit.

### Changed

Nothing has been released, so these correct decisions made earlier rather than changing
behaviour anyone has seen.

- **[accounting]** The rate storage scale is 3dp, not 2dp. Half of India's 0.25% slab is
  0.125%, and at two places an invoice would print CGST at 0.13% — a rate the tax was
  never computed from. Decided before any rate column existed, so `items.tax_rate_pct`,
  `document_lines.rate_pct` and `document_line_taxes.rate_pct` were all written at three
  places and nothing had to be migrated.
- ESLint's purity rule for `domain/` now anchors its patterns to the start of an import
  specifier. Unanchored, the entry for Node's legacy `domain` module also matched
  `@main/domain/money`, so the first cross-module import inside `domain/` was reported
  as a filesystem violation. Both directions are covered by a probe rather than assumed.
- **[accounting]** The ledger contract's account of how the insert order is enforced was
  wrong. It claimed a parent-first write would fail the deferred foreign key at commit;
  it does not, and it silently bypasses the balance check. Corrected in
  `domain/ledger/types.ts`, in migration `0004` and in the data model, with the three
  triggers that actually enforce it named in all three.

[Unreleased]: https://github.com/abinauv/coffer/commits/main
