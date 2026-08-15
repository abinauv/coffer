# Good first issues

> Real work, drawn from what is actually in the code today. Nothing invented to give
> newcomers something to do.
>
> Coffer is pre-alpha and [`CONTRIBUTING.md`](../CONTRIBUTING.md) asks you to open an
> issue before anything beyond a small fix. Everything below is small enough that
> "I'm taking this one" on an issue is the whole conversation — except the two in §4,
> which are worth agreeing on first.
>
> Read [`getting-started.md`](./getting-started.md) first. Every task here ends with
> `npm run verify` green.

---

## How to read an entry

Each one names the files, says what "done" looks like, and says why it is worth doing.
Several exist because a module was **frozen** while another was being built in parallel —
the author wrote the workaround, wrote down why, and left the fix for later. Those are the
best first issues in the repo: the decision is already made and written down, so the work
is mechanical and the reviewer already agrees with you.

## 1. Tidy-ups the code already asks for

### 1.1 Move `API_SURFACE` into `src/shared/ipc.ts`

**Files:** `src/main/ipc/surface.ts`, `src/shared/ipc.ts`, `src/preload/bridge.ts`,
`src/main/ipc/index.ts`, plus the tests beside them.

`src/shared/ipc.ts` declares `CofferApi`, which is a TypeScript interface and so does not
exist at runtime. `API_SURFACE` is its runtime enumeration, and both the startup
completeness check and the preload bridge need it.

It currently lives under `src/main/ipc/`, which means **the preload imports from main**:

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

### 1.2 Delete `src/main/companies/migrations.ts`

**Files:** `src/main/companies/migrations.ts`, `src/main/companies/service.ts`,
`src/main/companies/index.ts`.

This module exists only because `src/main/db/migrations/index.ts` was frozen at a moment
when it did not yet register migration `0001`. It composes the list by hand:

```ts
export const COMPANY_MIGRATIONS: readonly Migration[] = withMigration(MIGRATIONS, m0001)
```

Its header says it was written to survive its own fix — once `0001` is registered, the
append finds it already there and does nothing. `MIGRATIONS` is now `[m0001]`, so
`withMigration` returns the registry unchanged and this whole file is a no-op.

**Done when** `service.ts` imports `MIGRATIONS` from `src/main/db/migrations` directly at
both call sites, `COMPANY_MIGRATIONS` is gone from `companies/index.ts`, the file and its
test are deleted, and `npm run verify` is green.

### 1.3 Fix three comments that no longer describe the code

**Files:** `src/main/db/migrations/index.ts`, `electron-builder.yml`,
`src/main/ipc/electron.ts`.

Comments-only, no behaviour change. A genuinely good way to read three parts of the
codebase carefully.

1. **`src/main/db/migrations/index.ts`** opens with "Empty for now, and deliberately so"
   and "A database at this point has exactly one table, `schema_migrations`, and no
   business tables at all". Neither is true any more: `MIGRATIONS` is `[m0001]`, and
   `0001` creates `app_metadata`.

2. **`electron-builder.yml`**, in the Linux block: "deb requires a maintainer and
   package.json has no author field." `package.json` has had an `author` field since the
   commit `style: apply prettier across the repo and add the author field`. The
   `maintainer:` line is still right; the reason given for it is not.

3. **`src/main/ipc/electron.ts`**, on `BACKUP_ARCHIVE_EXTENSIONS`: "The backup service
   does not exist yet, so the archive's real extension is not settled." It exists —
   `src/main/companies/backup.ts` — and the extension is settled at
   `.coffer-backup.zip`. See 1.4, which is the follow-on.

**Done when** all three describe what the code does. Keep the register of the surrounding
comments: say what and why, not what a diff would already show.

### 1.4 Put the backup extension in `src/branding.ts`

**Files:** `src/branding.ts`, `src/main/ipc/electron.ts`, `src/main/companies/backup.ts`.

Follows on from 1.3.3. `src/main/ipc/electron.ts` filters the backup-archive file picker
on `['zip']` and says the value belongs in `src/branding.ts` beside
`companyFileExtension` once the format settles. It has settled:
`BACKUP_FILE_SUFFIX = '.coffer-backup.zip'` in `backup.ts`.

`branding.ts` is the single source of truth for every user-visible name and file
extension — its header explains that the reference project had 412 hard-coded client
references across 30-odd files, which is the situation it exists to prevent.

**Done when** the extension is declared once in `BRAND`, both the picker and
`backup.ts` read it from there, and picking a backup in the dialog still works.

Consider whether the picker should offer `.coffer-backup.zip` specifically rather than any
`.zip` — a narrower filter is friendlier, but check it does not hide an archive a user
renamed.

## 2. Types and tests

### 2.1 Type `app_metadata` and `schema_migrations` in `schema.ts`

**Files:** `src/main/db/schema.ts`, and a test beside it.

`src/main/db/schema.ts` is the Kysely table typing, and today its `Database` interface is
an index signature:

```ts
export interface Database {
  [table: string]: unknown
}
```

Which means `Kysely<Database>` provides no type safety whatsoever — every table is
`unknown` and every column name is accepted. Two tables exist and neither is typed, even
though step 3 of the procedure in `src/main/db/migrations/index.ts` says to add each
table's interface as its migration lands.

**Done when** `app_metadata` and `schema_migrations` have interfaces registered on
`Database`, the index signature is gone, and a test proves the builder rejects a column
that does not exist. `createQueryBuilder` in `db/kysely.ts` has no production caller yet
— the repositories arrive in Phase 1 — so a test is the only thing that will exercise
this.

**Worth saying in the issue first:** removing the index signature means every future
migration must add its typing or fail to compile. That is the intent of the convention,
but confirm it is wanted now rather than at the start of Phase 1.

### 2.2 Make `npm run lint` fail on warnings

**Files:** `package.json`, and possibly `eslint.config.js`.

`eslint.config.js` sets `no-console` to `warn`. `eslint .` exits 0 on warnings, so
`npm run lint` passes and so does CI — a rule set to `warn` is a rule that is not
enforced.

The repository is currently clean: `npx eslint . --max-warnings=0` exits 0 today. So this
is a one-word change that can only get harder to make later.

**Done when** `lint` is `eslint . --max-warnings=0` and `npm run verify` is green. Decide
in the issue whether `no-console` should instead be `error` with the existing
`allow: ['warn', 'error']`, which says the same thing more directly.

### 2.3 Stop committing `coverage/`

**Files:** `.gitignore`, and a `git rm -r --cached coverage`.

`npm run coverage` writes an HTML report into `coverage/`, and that directory is tracked
in git. `.gitignore` already covers `out/`, `dist/` and `release/` but not this one, so
anyone who runs the coverage script gets thirty-odd modified files they did not write.

Worse, a committed report goes stale the moment anyone touches a covered file, so the
numbers in the repository are wrong more often than they are right.

**Done when** `coverage/` is in `.gitignore`, the tracked copy is removed from the index
(not from anyone's disk), and `npm run coverage` leaves `git status` clean.

## 3. Documentation

### 3.1 Reconcile `ARCHITECTURE.md` §5 with the directories that exist

**Files:** `docs/ARCHITECTURE.md`.

§5 shows `main/app/`, `db/repos/`, `domain/ledger/`, `domain/documents/`,
`domain/inventory/` and `main/services/`. None of them exist — they arrive with Phase 1
and later. It also omits things that do exist: `src/branding.ts`, `main/ipc/handlers/`
and `renderer/src/lib/`.

A newcomer reading it as a map of the repo will look for folders that are not there.
There is a note under the diagram flagging that some entries are planned, but the diagram
itself does not distinguish them.

**Done when** the layout marks planned directories apart from present ones — a suffix, a
column, whatever reads cleanly — and matches `find src -type d` for the present ones. A
mechanical, careful job that will teach you the whole tree.

## 4. Larger, but well-scoped

Agree the approach on an issue before starting either of these. Both touch the security
model, and [`CONTRIBUTING.md`](../CONTRIBUTING.md) is explicit that a finished PR which
violates a load-bearing constraint is unpleasant for everyone.

### 4.1 Let a user get a fresh set of recovery codes

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

**Note:** the screen is a separate issue. The renderer is moving quickly; land the
main-process half first.

### 4.2 Upgrade a vault's KDF parameters on unlock

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

## 5. Not on this list, and why

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
- **Adding a `down` to migration `0001`.** It has one.
- **Anything in `src/renderer/src/screens/`.** Under active construction.

## 6. If none of these appeal

The most useful contribution to Coffer right now is not code.

- **Test it against real books** once there is something to test, and say where it does
  not match how you actually work.
- **Check the GST handling** if you are an accountant or a CA. `regimes/in-gst/` is small
  enough to read in an afternoon, and a wrong tax split is the highest-priority bug this
  project can receive. You do not need to write code to open that issue.
- **Report anything where a number is wrong.** Always the top of the queue.

See [`CONTRIBUTING.md`](../CONTRIBUTING.md).
