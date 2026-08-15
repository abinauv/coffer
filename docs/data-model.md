# The data model, so far

> What a company is on disk, what the registry knows, why there is no `company_id`,
> and how migrations work.
>
> Coffer is pre-alpha and there is no ledger yet. This describes what Phase 0 actually
> built — the file format and the machinery around it. The business tables arrive in
> Phase 1.

---

## 1. A company is two files

There is no server and no shared database. One company is one encrypted SQLite file plus
a sidecar holding its keys:

```
Accounts/
  Acme-Traders.coffer          the SQLCipher database — the books
  Acme-Traders.coffer.vault    wrapped keys, salts, KDF parameters, recovery slots
```

The vault path is always the database path with `.vault` appended. Not a name derived
separately, not a name the user chooses — the same string plus five characters
(`src/main/companies/paths.ts`). That is what lets Coffer find the keys for a file you
point it at without asking a second question, and it makes "these two travel together" a
rule the filesystem itself states.

The database file name comes from the company's display name, reduced to something safe
on all three platforms:

| Display name                    | File name                                                       |
| ------------------------------- | --------------------------------------------------------------- |
| `Acme Traders`                  | `Acme-Traders.coffer`                                           |
| `Acme <2026>: "the good year"?` | `Acme-2026-the-good-year.coffer`                                |
| `CON`                           | `CON-company.coffer` — a Windows device name in every directory |
| `///`                           | `books.coffer` — the fallback                                   |

Path separators, the five characters Windows forbids, control characters, trailing dots
and spaces (which Windows strips behind your back) and the device names are all handled
in `fileNameSlug`. The display name you typed is kept exactly as typed, in the registry
— only the file name is sanitised.

### Why the keys cannot live inside the database

Something has to be readable before the database can be opened. A key that decrypts a
file cannot be stored inside that file. So the vault is a sidecar, and the consequences
are handled rather than hidden:

- **Backup is an action, not a file copy.** It produces one archive holding both files.
  That is the only artefact Coffer calls a backup.
- **A database with no vault beside it fails with a specific message.** Not a decryption
  error — `COMPANY_VAULT_MISSING`, saying the keys are gone and a backup holds both.
  `availabilityOf()` distinguishes `database-missing` from `vault-missing` before any
  decryption is attempted, because those are different problems needing different words.
- **The database stays a plain SQLCipher file.** Any SQLCipher-capable tool opens it
  given the key. The "take your data elsewhere" promise still holds.

## 2. The database

SQLCipher, via `better-sqlite3-multiple-ciphers`. `src/main/db/connection.ts` opens it,
and it does three things worth knowing about.

**The cipher is pinned.** `PRAGMA cipher='sqlcipher'` is set explicitly on every open.
The driver's own default is `chacha20`, so a file written without that pragma would not
be readable by a build that sets it. Pinning it is what makes "copy the file to another
machine" work.

**The key is applied raw.** As `x'<64 hex chars>'`, which tells SQLCipher to use the
bytes directly as the AES key with no further derivation. The key arriving at this layer
is already the output of Argon2id; running PBKDF2 over it again would cost hundreds of
milliseconds per open and buy nothing. Note that passing a plain byte buffer to `db.key()`
would _not_ do this — the driver would treat it as a passphrase and derive from it.

**The wrong key fails at open, not later.** `verifyKey()` forces a decrypt of page 1
immediately, so a wrong passphrase raises `DB_WRONG_KEY` there rather than on whatever
query happens to touch disk first.

Pragmas applied on every connection:

|                    |                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `journal_mode=WAL` | Concurrent readers, fewer fsyncs. The WAL is encrypted alongside.                                                                |
| `foreign_keys=ON`  | Off by default in SQLite. A ledger without referential integrity is a spreadsheet. Per-connection, so it must be set every time. |
| `synchronous=FULL` | A committed invoice survives a power cut, at one extra fsync per commit.                                                         |

A brand-new database gets `PRAGMA user_version = 0` written immediately. Keying an empty
file changes nothing on disk, and a zero-byte file would happily accept a _different_ key
on the next open — which is how a mistyped passphrase quietly starts a second, parallel
set of books. One page write makes the file a real encrypted database from the moment it
is created.

### What is in the database today

Five tables, and none of them holds a figure yet — the figures arrive with `0004`.

`schema_migrations` — one row per applied migration, created by the runner:

```sql
CREATE TABLE schema_migrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT
```

`app_metadata` — created by migration `0001`, a small key/value table of file-level
facts:

| key                     | value                                                             |
| ----------------------- | ----------------------------------------------------------------- |
| `coffer.format`         | `coffer.company` — what makes "is this a Coffer file?" answerable |
| `coffer.format_version` | `1` — the shape of this table, not the schema                     |
| `company.display_name`  | the name at creation. Advisory; the registry is authoritative     |
| `company.created_at`    | ISO-8601 UTC                                                      |

It is deliberately not a company profile. Address, registration numbers and invoice
defaults are business data with their own Phase 1 table and their own constraints. The
reference project kept a single-row `settings` table that grew into all of that, and
every new field became a migration that rewrote it.

### The ledger tables

Typed in [`src/main/db/schema.ts`](../src/main/db/schema.ts) and contracted in
[`src/main/domain/ledger/types.ts`](../src/main/domain/ledger/types.ts), with migration
numbers reserved so that parallel work cannot collide.

| Migration | Tables                             | What it is                                    | State  |
| --------- | ---------------------------------- | --------------------------------------------- | ------ |
| `0002`    | `accounts`, `account_roles`        | The chart of accounts, as a tree              | landed |
| `0003`    | `accounting_periods`               | Periods that can be opened, closed and locked | landed |
| `0004`    | `journal_entries`, `journal_lines` | The ledger itself, with the balance triggers  | next   |

Six things about these tables are worth knowing before you read them, because each one
is a decision rather than a detail:

**There is no `status` on an entry, and no draft.** The ledger holds posted entries and
nothing else. A draft invoice is a draft in the sales tables; it reaches the ledger when
it is posted. That is what lets a trial balance be a sum over `journal_lines` with no
filter — and a filter somebody forgets to write is exactly how a draft leaks into a
filed return.

**A posted entry is never edited or deleted.** Triggers abort any `UPDATE` or `DELETE`.
A correction is a reversing entry, dated when the correction was made, linked back
through `reverses_entry_id`. That column is `UNIQUE`, which is what makes an entry
reversible at most once — a constraint rather than a check somebody remembered.

**No balance is stored anywhere.** Not on an account, not on a period, not as a
running total. Every balance is a sum over lines, computed when asked. A cached balance
is a second source of truth, and the two disagree silently starting on a date nobody can
afterwards identify.

**Lines are written before the entry they belong to.** This looks like a mistake and is
not. SQLite has no deferred triggers, so nothing can check a running total midway
through inserting an entry's lines. Instead the line's foreign key is
`DEFERRABLE INITIALLY DEFERRED`, the lines go in first, and a `BEFORE INSERT` trigger on
`journal_entries` sees the complete set and refuses an entry whose debits and credits
disagree, or which has fewer than two lines. Code that writes the parent first fails the
foreign key at commit — which is the point.

**Periods never overlap, and a period's span never changes.** Two periods covering the
same day would make an entry's period a matter of which row was found first, and the
same figure would appear in two months' returns — or in neither. A trigger refuses an
overlapping span on insert, and a second one refuses any `UPDATE` that names a column
other than `status` and `closed_at`, because moving a boundary silently moves every
entry already posted either side of it.

A useful consequence, and the reason there is no granularity column: **a set of books
uses one period length throughout.** `Apr 2026` overlaps `Q1 2026-27`, so a company
keeping months cannot also keep quarters. The rule is not written down anywhere as a
rule; it falls out of the one about overlap.

**`closed` reopens and `locked` does not.** The ordinary month end is `closed`, and
reopening it is a decision somebody is allowed to make. `locked` is a filed return or a
signed audit, and it is final — enforced by a trigger on `UPDATE` and by a second one on
`DELETE`, so that "unlock" is not one delete and one insert away. There is deliberately
no escape hatch: an error found after filing is corrected in the current open period,
which is what an accountant would do anyway and what an amended return already expects.
A single "closed" flag would have made every close feel dangerous, and a period nobody
dares close is a period that stays open forever.

An account's _type_ — asset, liability, equity, income, expense — is the one field that
may never change once anything has posted to it, because every figure already in the
books was classified by it. The `UpdateAccountInput` DTO has no `type` for that reason.

## 3. The registry

A JSON file listing the companies this machine knows about. Nothing else.

Its location is the Electron `userData` directory, with `Coffer` appended only when
`userData` does not already end in it — so it is `.../coffer/companies.json` in
development and `.../Coffer/companies.json` in a packaged build, never `Coffer/Coffer`.

```json
{
  "format": "coffer.companies",
  "version": 1,
  "companies": [
    {
      "id": "9f1c…",
      "displayName": "Acme Traders",
      "filePath": "D:\\Accounts\\Acme-Traders.coffer",
      "vaultPath": "D:\\Accounts\\Acme-Traders.coffer.vault",
      "createdAt": "2026-08-14T09:30:00.000Z",
      "lastOpenedAt": "2026-08-14T11:02:13.412Z"
    }
  ]
}
```

**What is never in it:** keys, passphrases, recovery codes, or a single figure from
anyone's books. It is an index of file locations. Delete it and you lose the list, not
the books — every company goes back with "Add an existing company", because the company
_is_ the pair of files, not the row pointing at them.

**It must survive being wrong.** It is plain text in a folder the user can open, so it
will occasionally be hand-edited, truncated by a full disk, or mangled by a cloud sync.
A registry that threw on load would take the app down at launch, before the user could
reach the screen that fixes it. So:

- An unreadable file degrades to "no companies" plus a stated problem. `read()` never
  throws.
- An entry that fails validation is dropped; its siblings survive. An entry needs a valid
  id and an absolute `filePath`; a missing display name or timestamp is repaired rather
  than being grounds for dropping the company.
- Nothing is overwritten silently. The first write after a degraded read renames the old
  file to `companies.json.corrupt-<timestamp>` first.

Writes are atomic: temporary file, `fsync`, rename over the target.

`registryStatus()` is where a degraded read explains itself. `src/main/index.ts` logs it
at startup, because `list()` returning an empty set otherwise looks exactly like a first
run.

## 4. Why there is no `company_id`

There is no `company_id` column anywhere in the schema, and there will not be one. Two
consequences, both deliberate:

- **A missing `WHERE` clause cannot leak one client's data into another's report.** In a
  multi-tenant schema that bug is one forgotten predicate away, and it is silent. Here
  the query has no other company's rows to find.
- **One corrupt file costs one company.** Not the whole practice.

Exactly one company is open at a time. `CompanyService.close()` takes no argument and no
DTO carries a company id, because "which company" is answered once, at open, and never
again by a query. The session holds a keyed SQLite handle and nothing else.

The IPC layer goes further: `createIpcMainTransport()` drops the Electron event object
before the handler sees it, so no handler can even tell callers apart.

## 5. Keys, in one diagram

The full reasoning is in `src/main/security/` — `dek.ts` and `vault.ts` both open with
it. The shape:

Each slot in the vault turns one secret into one wrapped copy of the same key:

```
secret ──Argon2id(salt, params)──> slotKey ──HKDF──> kek       (used, never stored)
                                            └─────> verifier   (stored)

wrapped = AES-256-GCM(kek, nonce, DEK, aad = the slot's own header)
```

The DEK is 32 random bytes, generated once per company. It goes to SQLCipher as the raw
key and is never changed for the life of that database.

```
slot "passphrase"    Argon2id m=256 MiB, t=3, p=4    always present
slot "recovery-1"    Argon2id m=64 MiB,  t=3, p=4    single use
…
slot "recovery-5"    Argon2id m=64 MiB,  t=3, p=4    single use
```

Six slots, all wrapping **the same DEK** under a different key. Everything else follows:

- Changing the passphrase rewrites one slot. The database is not re-encrypted, not
  rewritten, not even opened. A passphrase change cannot corrupt a ledger row.
- Any one recovery code opens the books on its own.
- Redeeming a code destroys that slot's ciphertext outright. The salt and verifier stay
  so the code can still be _recognised_ and reported as spent. It works once because the
  ciphertext is gone, not because a boolean says so.

The vault file is JSON, `format: "coffer.vault"`, version 1, with binary fields in
base64. Two layers are authenticated: each slot's AES-GCM wrap covers its own header as
associated data, and an HMAC-SHA256 over the whole canonical document — keyed from a
subkey of the DEK — is checked immediately after any successful unlock. The second layer
is what stops the one attack the first misses: editing `usedAt` back to `null` to
resurrect a spent recovery code.

The DEK is zeroed the moment the SQLite handle is keyed. SQLCipher has copied it into its
own memory by then, and a key sitting in a long-lived JavaScript object is a key in every
heap dump for the rest of the session.

## 6. Backups

One archive, both files, or it is not a backup.

`Acme-Traders-2026-08-14-1102.coffer-backup.zip` holds three entries:

```
manifest.json                  format, version, when, display name, SHA-256 of each file
Acme-Traders.coffer.vault
Acme-Traders.coffer
```

The manifest means restore knows which entry is which without guessing from names, and
that a damaged archive is detected before anything is written to disk rather than after.
Hashes are checked on the way in and on the way out.

It really is a `.zip`, written by about two hundred lines in
`src/main/companies/archive.ts` rather than a dependency — stored entries, no
compression, one flat level. A user who wants to check their backup contains what it
claims can double-click it. Compression would be pointless: the database is ciphertext,
with no redundancy left for deflate to find. Reading still accepts deflated entries, so
an archive repacked by another tool restores.

The reader rejects any entry name containing a separator, a drive letter or a leading dot
at parse time, with no option to allow them. A crafted archive is a named vulnerability
class in [`SECURITY.md`](../SECURITY.md), and `../../autostart/evil` is its classic form.

Two ordering rules the service enforces:

- **Checkpoint before archiving.** In WAL mode the newest committed rows may still be in
  the `-wal` sidecar, which is not in the archive. `backup()` calls `checkpoint()` first.
- **Restore never overwrites.** Into an empty folder or not at all. Overwriting a company
  would destroy the books already there. Restore also does not open the company —
  restoring proves nothing about who holds the passphrase.

## 7. Migrations

Numbered files in `src/main/db/migrations/`, named `NNNN_snake_summary.ts`, registered in
`index.ts` of that folder, ordered by number and applied exactly once each.

```ts
import type { Migration } from '../migrate'

export const m0002: Migration = {
  id: '0002',
  name: 'accounts',
  up(db) {
    db.exec(`CREATE TABLE accounts (…) STRICT`)
  },
  down(db) {
    db.exec(`DROP TABLE accounts`)
  },
}
```

Adding one:

1. **Use the migration number reserved for your task.** Never take "the next free one" —
   two people working in parallel will both take it. `validateRegistry()` refuses a
   registry with two migrations claiming the same id, naming both.
2. Create the file in `src/main/db/migrations/`.
3. Add the table's interface to `src/main/db/schema.ts` and register it on `Database`.
4. Import it in `src/main/db/migrations/index.ts` and append it to `MIGRATIONS`.

Money, quantity and rate columns are `TEXT` holding decimal strings. Never `REAL`, never
`INTEGER`. Tables are `STRICT`. There is no `company_id`.

Migrations use raw SQL against the connection rather than Kysely. A migration is a
historical record of one schema change; typing it against the current `schema.ts` would
let every later change break it.

### What the runner guarantees

- **One transaction per migration.** SQLite makes DDL transactional, so a migration that
  throws half way leaves no trace. The run then stops; the ones that already succeeded
  stay applied and the recorded version reflects that.
- **`defer_foreign_keys = ON` inside that transaction.** A table rebuild momentarily
  breaks its own references. `foreign_keys` cannot be toggled inside a transaction;
  `defer_foreign_keys` can, and still enforces every constraint at `COMMIT`.
- **A database carrying unknown migrations is refused.** If every unknown id is beyond
  what this build knows, the file is from a newer Coffer (`DB_SCHEMA_TOO_NEW`, "update
  Coffer to open it"). If one sits inside the known range, the file is from a different
  lineage entirely (`DB_SCHEMA_UNKNOWN`). Either way, writing to it could destroy data
  this build cannot describe.
- **One row per migration, not a version counter.** The file itself says precisely what
  has run.
- **`down` is optional and rollback is all-or-nothing.** Some changes cannot be undone
  without losing data, and saying so honestly beats a `down` that silently drops a
  column. The whole range is checked for a `down` before anything is reverted.

### A merged migration is never edited

Not to fix a typo. Not to add a column. Not "because nobody has run it yet" — someone
has, and the databases that already ran it will never run it again. Their schema would
then differ from the one the migration list claims to produce, and nothing would detect
the divergence. There is no checksum on migration bodies, so the drift would be silent
and permanent.

Fix it forward with a new migration. This is [`CONVENTIONS.md`](./CONVENTIONS.md) §1.5
and it is a review rejection, not a discussion.
