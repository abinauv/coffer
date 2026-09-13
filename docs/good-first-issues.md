# Good first issues

> Real work, drawn from what is actually in the code today. Nothing invented to give
> newcomers something to do.
>
> [`CONTRIBUTING.md`](../CONTRIBUTING.md) asks you to open an issue before anything beyond
> a small fix. Everything below is small enough that "I'm taking this one" on an issue is
> the whole conversation — except the three in §5, which are worth agreeing on first.
>
> Read [`getting-started.md`](./getting-started.md) first, including §6, which is where
> `npm ci` fails on a fresh clone for a reason that is not your fault. Every task here
> ends with `npm run verify` green.

---

## How to read an entry

Each one names the files, says what "done" looks like, and says why it is worth doing.

Several exist because a module was **frozen** while another was being built in parallel —
the author wrote the workaround, wrote down why, and left the fix for later. Those are the
best first issues in the repo: the decision is already made and written down, so the work
is mechanical and the reviewer already agrees with you. This codebase does not carry
`TODO` comments; a deferred item is a paragraph in a module header, which is why the
entries below quote them.

## 1. Layering the code already asks you to fix

### 1.1 Move `API_SURFACE` into `src/shared/ipc.ts`

**Files:** `src/main/ipc/surface.ts`, `src/shared/ipc.ts`, `src/preload/bridge.ts`,
`src/main/ipc/index.ts`, plus the tests beside them.

`src/shared/ipc.ts` declares `CofferApi`, which is a TypeScript interface and so does not
exist at runtime. `API_SURFACE` is its runtime enumeration, and both the startup
completeness check and the preload bridge need it.

It lives under `src/main/ipc/`, which means **the preload imports from main**:

```ts
// src/preload/bridge.ts
import { API_SURFACE, isResultEnvelope } from '../main/ipc/surface'
```

That is a layering violation, and both files say so in their own headers — `src/shared/`
was frozen for the batch that needed it. It is not frozen now.

**Done when** the contract enumeration and `isResultEnvelope` live in `src/shared/ipc.ts`
beside `toChannelName` and `createApiProxy`, the preload no longer reaches into
`src/main/`, and `npm run verify` is green. Decide where `ok()` belongs while you are
there — it builds a `Result` and is only used by main-process handlers, so it may
reasonably stay.

**Why it matters:** it is the one place the process boundary is crossed by an import
rather than by IPC.

### 1.2 Move three input wrappers from `shared/ipc.ts` into `shared/dto.ts`

**Files:** `src/shared/ipc.ts`, `src/shared/dto.ts`, `src/main/units/service.ts`,
`src/main/numbering/service.ts`, `src/main/ipc/handlers/units.ts`,
`src/main/ipc/handlers/numbering.ts`.

`ArchiveUnitInput`, `ArchiveNumberingSeriesInput` and `PreviewNumberInput` are DTOs
sitting in the contract file. Its own header says why and names the fix:

> THREE INPUT WRAPPERS THAT BELONG IN `./dto.ts` AND ARE HERE INSTEAD. `dto.ts` was
> frozen at Gate 2.0 and other batches are building against it, so this batch may not add
> to it — the same reason `API_SURFACE` sits under `main/ipc`. Move all three to
> `./dto.ts` when it thaws; four files import them from here, and each import moves with
> them.

Both services carry a matching one-line note pointing at it. `dto.ts` is not frozen now.

**Done when** all three are declared in `src/shared/dto.ts`, the four importers name the
new home, the notes in all three files are deleted rather than left describing a state
that no longer exists, and `npm run verify` is green.

**A good pairing with 1.1** — same shape of problem, and doing both teaches you the whole
IPC layer. Two PRs, not one.

### 1.3 Delete `src/main/companies/migrations.ts`

**Files:** `src/main/companies/migrations.ts` and its test,
`src/main/companies/service.ts`, `src/main/companies/index.ts`.

This module exists only because `src/main/db/migrations/index.ts` was frozen at a moment
when it did not yet register migration `0001`. It composes the list by hand:

```ts
export const COMPANY_MIGRATIONS: readonly Migration[] = withMigration(MIGRATIONS, m0001)
```

Its header says it was written to survive its own fix — once `0001` is registered, the
append finds it already there and does nothing. `MIGRATIONS` now runs `m0001` through
`m0022` with `m0001` first, so `withMigration` returns the registry unchanged and the
whole file is a no-op.

**Done when** `service.ts` imports `MIGRATIONS` from `src/main/db/migrations` directly at
all three call sites, `COMPANY_MIGRATIONS` is gone from `companies/index.ts`, the file and
its test are deleted, and `npm run verify` is green.

### 1.4 Move `TitleBarSync` up into the shell

**Files:** `src/renderer/src/screens/components/ScreenFrame.tsx`,
`src/renderer/src/screens/components/TitleBarSync.tsx`,
`src/renderer/src/screens/components/ScreenFrame.test.tsx`, and wherever
`ThemeProvider` is mounted in `src/renderer/src/components/shell/`.

`TitleBarSync` repaints the OS-drawn window buttons to match the theme, reading the
colours off the design tokens. It rides along inside `ScreenFrame`, which every screen
renders, and it says why in its own header:

> WHY IT LIVES IN A SCREEN. The natural home is the shell, beside the `ThemeProvider` that
> already owns this decision. This batch does not own those files… moving it up into the
> shell is a three-line change and should happen.

The test beside it was written for this move. `ScreenFrame.test.tsx` pins **what it does
today** — the colours crossing the bridge on mount — "precisely so that moving the effect
upstairs is a visible change with a test to update, rather than a three-line edit that
silently stops repainting the window buttons." So the failing test is the specification.

**Done when** the effect is mounted once in the shell, `ScreenFrame` renders no
side-effect of its own, the window buttons still repaint when the theme changes, and the
test asserts the new arrangement rather than being deleted.

### 1.5 Put the backup extension in `src/branding.ts`

**Files:** `src/branding.ts`, `src/main/ipc/electron.ts`, `src/main/companies/backup.ts`.

`src/main/ipc/electron.ts` filters the backup-archive file picker on `['zip']` and says
the value belongs in `src/branding.ts` beside `companyFileExtension` once the format
settles. It has settled: `BACKUP_FILE_SUFFIX = '.coffer-backup.zip'` in `backup.ts`,
re-exported from `companies/index.ts`.

`branding.ts` is the single source of truth for every user-visible name and file
extension — its header explains that a product name hard-coded across dozens of files
is the situation it exists to prevent.

**Done when** the extension is declared once in `BRAND`, both the picker and `backup.ts`
read it from there, the stale comment in `electron.ts` goes with it, and picking a backup
in the dialog still works.

Consider whether the picker should offer `.coffer-backup.zip` specifically rather than any
`.zip` — a narrower filter is friendlier, but check it does not hide an archive a user
renamed.

### 1.6 Fix four comments that no longer describe the code

**Files:** `src/main/db/migrations/index.ts`, `src/main/db/migrations/0018_warehouses.ts`,
`src/main/db/repos/stock.ts`, `electron-builder.yml`.

Comments only, no behaviour change. A genuinely good way to read four parts of the
codebase carefully — and the first three matter more than a typo would, because each says
a company file created by the app cannot record stock, which stopped being true.

1. **`src/main/db/migrations/index.ts`** still carries "NOTHING SEEDS A WAREHOUSE, AND
   SOMETHING MUST… the one line that calls it belongs in `bootstrap.ts`". That line
   exists: `seedDefaultWarehouse` is called by `setUpBooks` and the count comes back as
   `warehousesCreated`, with tests in `bootstrap.test.ts` and end to end in
   `companies/service.test.ts`.
2. **`0018_warehouses.ts`** ends its seeding argument with "which this batch does not own.
   Until that line exists, `defaultWarehouseId` refuses with `WAREHOUSE_NOT_CONFIGURED`."
   Keep the argument for why a migration is the wrong place; correct the ending.
3. **`src/main/db/repos/stock.ts`**, on `seedDefaultWarehouse`: "IT BELONGS IN
   `setUpBooks`… and the line that calls it is not this batch's to write." It is written.
   `bootstrap.ts` already tells the corrected story, so these three are the stragglers.
4. **`electron-builder.yml`**, in the Linux block: "deb requires a maintainer and
   `package.json` has no author field." It has had one since the commit
   `style: apply prettier across the repo and add the author field`. The `maintainer:`
   line is still right; the reason given for it is not.

**Done when** all four describe what the code does. Keep the register of the surrounding
comments: say what and why, not what a diff would already show.

## 2. The importers, which name their own follow-ups

`src/main/services/importers/` holds four readers — `csv/`, `xml/`, `zoho/` and `tally/` —
written in separate batches against frozen shared files. Two of them left a note saying
exactly what the integration step should do.

### 2.1 A shared issue module for the importers

**Files:** `src/main/services/importers/model.ts`,
`src/main/services/importers/xml/errors.ts`, `src/main/services/importers/tally/index.ts`,
and a new `src/main/services/importers/issues.ts`.

`BatchIssueCode` in `model.ts` is a closed union. The Tally reader raises three facts it
has no code for and borrows the nearest one for each, carrying a `field` that says what it
really is — and its header lists them:

> The integration step should add `UNKNOWN_VOUCHER_TYPE`, `UNMAPPED_ELEMENT` and
> `UNBALANCED_VOUCHER`, and `xml/errors.ts` already asks for the shared issue module that
> would hold them.

`xml/errors.ts` is the other half:

> A SEPARATE TYPE FROM `ImportIssue`, DELIBERATELY. Its code union is closed and does not
> contain these two codes, and widening it is a change to a file this batch does not own…
> the natural home is a shared `importers/issues.ts` that both readers contribute codes
> to.

**Done when** the three codes exist, the Tally reader raises each by name instead of
borrowing, the XML reader's `XmlIssue` and the batch's `ImportIssue` share one module, and
the tests assert the new codes rather than the borrowed ones. Read both headers first —
they say what the shared type has to keep, which is the severity split between a refusal
and a report.

### 2.2 Hoist the BOM rule to `importers/text.ts`

**Files:** `src/main/services/importers/csv/text.ts`,
`src/main/services/importers/xml/text.ts`, and a new
`src/main/services/importers/text.ts`.

`xml/text.ts` duplicates the byte-order-mark rule from `csv/text.ts` and says so:

> THE BOM RULE IS DUPLICATED FROM `csv/text.ts` RATHER THAN IMPORTED, and that is the one
> piece of duplication in this folder. Importing it would make the XML reader depend on
> the CSV reader for no better reason than that both formats start at byte zero. **If a
> third importer arrives, hoist it to `importers/text.ts`.**

Two more have arrived. The condition the note set has been met.

**Done when** the rule is declared once, both readers import it, and each keeps its own
tests — the two formats fold whitespace differently and only the BOM is shared. Do not
hoist anything else while you are in there; the note is specific for a reason.

## 3. Tests

### 3.1 Boundary tests for the rest of the `reports` group

**Files:** `src/main/ipc/handlers/reports.test.ts`.

The `reports` group has five methods and one of them has a boundary test. Its header says
why, and is worth reading before you write anything:

> WHY THIS FILE STARTS WITH ONE METHOD… `aged` gets one now because it is the first method
> in the group whose argument CHOOSES SOMETHING rather than narrowing a range. A malformed
> date on a day book returns the wrong set of entries; a malformed side on this one would
> resolve no control account at all.

The point that carries over is the group's own: a date goes straight into a text
comparison against `entry_date`, so `'2026-4-1'` sorts below `'2026-04-01'` and quietly
returns a **different set of entries** rather than failing. That is a wrong report, not an
error, and it is what `expectDateString` exists to stop.

**Done when** `balanceSheet`, `profitAndLoss`, `accountLedger` and `dayBook` each have
boundary tests covering a malformed date, a missing required argument and — for
`accountLedger` — an account id that is not a string. Test-only, self-contained, and it
will teach you what the boundary is for.

**While you are there:** the header says "the other three" and there are four. Fix the
count.

### 3.2 Put a `salesAccountId` and a `purchaseAccountId` on `ItemSummary`

**Files:** `src/shared/dto.ts`, `src/main/db/repos/items.ts`,
`src/renderer/src/screens/lib/document-editor.ts`, plus the tests beside them.

`document-editor.ts` says what is missing and why it was left:

> THE ACCOUNT OVERRIDE IS NOT SEEDED. `Item` carries `salesAccountId` and
> `purchaseAccountId` and `ItemSummary` does not, so honouring them would mean a second
> round trip per pick — noted for a later batch rather than half-done here.

So an item that names its own revenue account is picked onto a document line without it,
and the line posts to whatever the kind implies. The item screen can set the override and
nothing downstream reads it.

**Done when** both ids are on `ItemSummary`, `lineFromItem` seeds the line's `accountId`
from the right one for the document's side, and a test proves a line picked from an item
with a sales account override carries it.

**Worth saying in the issue first:** whether `ItemSummary` is allowed to grow. It is the
list DTO, and the argument for keeping it small is real — but a second IPC round trip per
line pick is worse, and the alternative is a screen that silently drops a setting.

## 4. Documentation

### 4.1 Check the tax handling and say where it is wrong

Not code, and the most valuable thing on this page.

`src/main/regimes/in-gst/` is small enough to read in an afternoon, and
`regimes/in-gst/returns/` states in its own header that the arithmetic is pinned to the
paisa and the **shape** — field names, nesting, which figure goes in which box — has never
been checked against GSTN's published schema or been through a filing cycle. Every
artefact it produces carries a `SCHEMA_UNVERIFIED` notice for that reason.

`returns/provisional.ts` lists nine known gaps and fourteen decisions, each decision
pinned by a named test. If you file GST returns for a living, reading that list and saying
which of the fourteen is wrong is worth more than any patch on this page. You do not need
to write code to open that issue.

## 5. Larger, but well-scoped

Agree the approach on an issue before starting any of these. All three touch a contract or
the security model, and [`CONTRIBUTING.md`](../CONTRIBUTING.md) is explicit that a
finished PR which violates a load-bearing constraint is unpleasant for everyone.

### 5.1 Let a user get a fresh set of recovery codes

**Files:** `src/shared/ipc.ts`, `src/shared/dto.ts`, `src/main/ipc/surface.ts`,
`src/main/ipc/handlers/companies.ts`, `src/main/companies/service.ts`.

Today, using a recovery code leaves you with four — permanently. There is no way to ask
for a new set.

The capability is already built and tested: `replaceVaultFileRecoveryCodes` in
`src/main/security/vault.ts` issues a fresh set against a passphrase, invalidating every
existing code. It requires the passphrase by design, so a stolen vault file cannot mint
itself new codes. Nothing calls it.

`CompanyService.recover()` names this gap in its own comment, and explains why recovery
does **not** silently reissue: it would invalidate the four codes on the sheet in the
user's hand at the one moment they have proved they need it. So this must be a separate,
deliberate action.

**Done when** there is a `companies.replaceRecoveryCodes` method on the contract, listed
in `API_SURFACE`, with a handler and a service method, returning the new codes once and
only once. Tests should cover: the old codes stop working, the new ones work, and a wrong
passphrase changes nothing.

**Note:** the screen is a separate issue. Land the main-process half first — and see 5.3,
which is what that screen will need to offer the sheet as a file.

### 5.2 Upgrade a vault's KDF parameters on unlock

**Files:** `src/main/companies/service.ts`, possibly `src/main/security/vault.ts`.

`needsKdfUpgrade(vault)` reports when any key slot was written with Argon2 parameters
weaker than this build's profile — an older vault, or one created before the numbers were
raised. Its own comment says "the unlock path can use it to re-wrap transparently while
it has the DEK in hand". Nothing does, so the function has no production caller.

Re-wrapping is cheap and safe: it rewrites key slots, never the database. `setPassphrase`
already refuses to weaken the passphrase slot's parameters. The DEK is unchanged, so
every existing recovery code keeps working.

**Done when** a successful unlock re-wraps weak slots, the user sees nothing, and a test
proves an old-profile vault opens, is upgraded, and still opens with the same passphrase
afterwards.

**Design questions for the issue:** re-wrapping recovery slots needs the codes themselves,
which nobody has — so only the passphrase slot can be upgraded on unlock. Say so plainly
rather than leaving `needsKdfUpgrade` reporting a state that can never be cleared. And a
failed write must not cost the user their unlock.

### 5.3 A `system.writeTextFile` on the contract

**Files:** `src/shared/ipc.ts`, `src/shared/dto.ts`, `src/main/ipc/surface.ts`,
`src/main/ipc/handlers/system.ts`, `src/main/ipc/electron.ts`,
`src/renderer/src/screens/lib/browser.ts`.

`browser.ts` says what is missing:

> There is no `system.writeTextFile` in the IPC contract, so saving goes through the
> browser's own download path (an anchor with `download`), which Electron turns into a
> native save dialog. Noted in the batch report as a gap worth closing.

The one thing that path saves today is **the recovery-code sheet**, which is why this is on
the list rather than filed as tidying: the codes are the only fallback a user has, there is
no escrow, and the save happens on the one screen they cannot go back to.

**Done when** the method exists with a handler that goes through `SystemEnvironment` and
the same path allowlist `revealInFileManager` uses, the renderer calls it instead of
synthesising an anchor, and a cancelled dialog is reported as a cancellation rather than
as a failure.

**Design questions for the issue:** what the method may write and where — an unconstrained
"write this text to that path" on the contract is a hole the renderer should not have. A
save-dialog-first shape, where main chooses the path and the renderer never names one, is
the narrower design and is probably the right one.

## 6. Not on this list, and why

A few things look like easy wins and are not.

- **Calling `checkIntegrity` from somewhere.** `src/main/db/connection.ts` exports it and
  nothing uses it. A "check this file" action is genuinely wanted — but it needs a screen,
  a place in the UI, and a decision about what a user does with the answer. That is a
  feature proposal, not a first issue.
- **Deleting apparently unused security exports.** `hashPassphrase`, `verifyPassphrase`,
  `sealRequest` and `openRequest` have no production callers. Each is deliberate and each
  is explained in its module header — `sealed-box.ts` in particular bakes in no maintainer
  public key on purpose, because a placeholder key in source is a key that ships by
  accident. Do not tidy these away.
- **Making `npm run lint` fail on warnings.** It was on this list and is now a decision.
  `eslint .` exits 0 on warnings locally so that a warning is visible without stopping you
  mid-change, and `.github/workflows/ci.yml` runs `npm run lint -- --max-warnings 0` with
  its reasoning beside it. The rule is enforced where it counts.
- **Typing `schema_migrations` in `schema.ts`.** Every table a repository queries is typed
  and the index signature is long gone. `schema_migrations` is deliberately not on
  `Database`: it belongs to the migration runner, which reads and writes it in raw SQL
  before Kysely has been handed anything.
- **Adding a `down` to migration `0001`.** It has one.
- **Adding a stored balance anywhere.** Not a first issue, not a later issue. See
  `CONVENTIONS.md` §1.3, and migration `0019`'s header for the version of the argument
  that has already been had.

## 7. If none of these appeal

The most useful contribution to Coffer right now is still not code.

- **Test it against real books.** Say where it does not match how you actually work.
- **Check the GST handling** if you are an accountant or a CA — see 4.1, which is the
  same request with the files named.
- **Report anything where a number is wrong.** Always the top of the queue.

See [`CONTRIBUTING.md`](../CONTRIBUTING.md).
