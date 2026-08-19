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

The shapes and rules Phase 2 is built against. Types and pure functions only — no table
exists yet, and migrations `0005`–`0009` are reserved for the ones that will.

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
- **[accounting]** The ledger contract's account of how the insert order is enforced was
  wrong. It claimed a parent-first write would fail the deferred foreign key at commit;
  it does not, and it silently bypasses the balance check. Corrected in
  `domain/ledger/types.ts`, in migration `0004` and in the data model, with the three
  triggers that actually enforce it named in all three.

[Unreleased]: https://github.com/abinauv/coffer/commits/main
