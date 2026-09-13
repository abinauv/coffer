# The data model, so far

> What a company is on disk, what the registry knows, why there is no `company_id`,
> and how migrations work.
>
> This describes what has actually been built. The file format and the machinery around
> it; the double-entry ledger — chart of accounts, periods, journal; the masters; the
> trade documents and what settles them; and the stock register. Twenty-two migrations,
> and [`src/main/db/schema.ts`](../src/main/db/schema.ts) is the authority for every one
> of them. If this document and that file disagree, that file is right.

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

**Twenty tables, plus `schema_migrations`.** The twenty are the keys of the `Database`
interface in [`src/main/db/schema.ts`](../src/main/db/schema.ts), which is where a table
is registered as its migration lands, and adding one without adding its typing is a
compile error rather than an omission. `schema_migrations` is the twenty-first table in
the file and is deliberately not on that interface: it belongs to the runner, which reads
and writes it in raw SQL before Kysely has been handed anything, so typing it would
suggest a query layer that never touches it.

Three of the twenty hold a figure that anything sums, and they are worth naming because
everything else is a default, an identity or a match:

- `journal_lines` — every balance in Coffer is a sum over this table.
- `stock_ledger` — every quantity and every stock value is a fold over this one,
  recomputed each time (see below, and migration `0019`).
- `document_lines` and `document_line_taxes` hold what a document _says_, which is not
  the same claim: those figures are the paper, and the ledger is the books.

`receipt_allocations` and `document_offsets` hold amounts and are neither. They are
matching records — statements about two movements that already happened — and nothing in
them posts, moves money or changes a balance.

The masters — parties, items, units, numbering series, warehouses — hold defaults and
identities, never totals.

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

It is deliberately not a company profile. Address and registration numbers are business
data, and they live in `company_profile` (migration `0011`) with their own columns and
their own constraints. The tempting alternative is a single-row `settings` table that
grows into all of that plus the invoice defaults and the e-mail configuration, where every
new field is a migration that rewrites it.

`company_profile` is single-row as well, so the distinction is worth stating: a
`settings` table's problem is not its row count but that it has no subject. This one
holds identity — the name a tax authority knows, the registration, the jurisdiction, the
address — and nothing that is a preference. **It can legitimately be empty.** A migration
cannot invent a company's legal name, so no row is seeded and every read answers null
until somebody enters one; books with no profile still keep a chart, periods, parties,
drafts and a ledger. What the profile is needed for is tax: `TaxRegime.computeTax` takes
a supplier and a customer and decides CGST+SGST against IGST from whether their
jurisdictions match, and this is where the supplier comes from.

### Every migration, in order

Typed in [`src/main/db/schema.ts`](../src/main/db/schema.ts), contracted in
`src/main/domain/{ledger,documents,receipts,inventory}/types.ts`, and registered in
[`src/main/db/migrations/index.ts`](../src/main/db/migrations/index.ts) — which reserves
numbers ahead of the files, so that parallel work cannot collide. Every one has landed.

| Migration | What it adds                                                          | What it is                                               |
| --------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| `0001`    | `app_metadata`                                                        | File-level facts, so a decrypting file identifies itself |
| `0002`    | `accounts`, `account_roles`                                           | The chart of accounts, as a tree                         |
| `0003`    | `accounting_periods`                                                  | Periods that can be opened, closed and locked            |
| `0004`    | `journal_entries`, `journal_lines`                                    | The ledger itself, with the balance triggers             |
| `0005`    | `parties`, `journal_lines.party_id`                                   | Who a document is with, and whose money a line is        |
| `0006`    | `units_of_measure`, `items`                                           | What goes on a document line                             |
| `0007`    | `numbering_series`, `numbering_counters`                              | What a document's number is                              |
| `0008`    | `documents`, `document_lines`, `document_line_taxes`                  | The trade document itself                                |
| `0009`    | `documents_frozen_once_issued`, replaced                              | Narration and series, frozen after issue                 |
| `0010`    | `documents`, rebuilt                                                  | A quotation may be issued without posting                |
| `0011`    | `company_profile`                                                     | Who these books belong to, in one row                    |
| `0012`    | `receipts`, `receipt_allocations`, `numbering_series` rebuilt         | What has been paid against a document                    |
| `0013`    | `documents.original_document_id`                                      | The invoice a credit note corrects                       |
| `0014`    | `documents.due_date`                                                  | When an invoice falls due, stamped at issue              |
| `0015`    | `numbering_series` and `receipts` rebuilt, an allocation-kind trigger | A refund is a voucher                                    |
| `0016`    | `document_offsets`                                                    | Which invoice a credit note settles                      |
| `0017`    | `items.is_stock_tracked`, `items.reorder_level`                       | Which items keep a balance                               |
| `0018`    | `warehouses`                                                          | Where the stock is                                       |
| `0019`    | `stock_ledger`                                                        | The stock register itself                                |
| `0020`    | `documents.export_tax_payment`, `documents.is_reverse_charge`         | How a supply is taxed, as against what the tax came to   |
| `0021`    | `document_lines.itc_eligibility`                                      | Whether credit may be taken, per line                    |
| `0022`    | `stock_ledger.entry_id`                                               | Every movement that moved money posts                    |

`0009`, `0010` and `0015` correct earlier migrations rather than adding anything, and
`0012` and `0015` rebuild `numbering_series` — so the table above is a history and not a
schema. The schema is `schema.ts`.

Eleven things about the ledger and the masters are worth knowing before you read them,
because each one is a decision rather than a detail:

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
disagree, or which has fewer than two lines.

**Three triggers, not the foreign key, are what hold that order in place.** This was
originally written down the other way round, and it was wrong — measuring it is what
found out. A deferred key only asks that the parent exist _by commit_, not that it did
not exist already, so an entry written before its lines commits perfectly happily. Worse,
that order skips the balance check completely: the trigger runs when no line carries the
entry's id yet, and the sum of no lines is zero, which balances. What actually refuses it
is `journal_entries_need_two_lines`; what stops a line being appended to an entry already
posted is `journal_lines_before_entry`. Read those two and the balance trigger as one
mechanism — removing any of them reopens a path that writes an unbalanced entry with no
error at all.

**Money is summed in SQL as integer paise, never as `REAL`.** `SUM(debit)` over decimal
text coerces to floating point, and that is not a theoretical objection: `'0.07'` three
times plus `'1234567.89'` plus `'0.01'` comes back as `1234568.1099999999`. The triggers
and the balance queries strip the decimal point and sum
`CAST(REPLACE(debit, '.', '') AS INTEGER)` instead, which is exact. That is only sound
because every stored amount carries exactly two decimal places and no sign — which is
why the `GLOB '[0-9]*.[0-9][0-9]'` CHECK on those columns is load-bearing rather than
cosmetic, and why it rejects `'12.3'`, `'-1.00'` and `'1e5'`.

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

**A party is not an account.** Tally gives every customer its own ledger account under
Sundry Debtors. Coffer keeps one control account per side and puts `party_id` on the
line instead, because a chart of accounts holding four hundred customers is not a chart
anybody can read, and reports drop nothing that has been posted to — so every one of
those accounts would appear on the balance sheet. A party's balance is then a sum over
the same rows the control account totals, grouped differently, which is what makes it
impossible for an aged receivables report and the balance sheet to disagree. A trigger
requires a party on any line posting to the accounts mapped to `accounts-receivable` or
`accounts-payable`, looked up by role live rather than pinned to an account id; a party
is permitted on any other line, because an advance from a customer is that customer's
money even though it sits under a liability that is not the control account.

**An item is a default for a line, never a lookup.** Every column on `items` — the
description, the price, the tax rate, the account — is where a document line _starts_. The
line then stores its own copy, so renaming an item or repricing it cannot rewrite an
invoice already issued. The same reasoning as `DocumentLine` in `domain/documents`, seen
from the masters end. Units are keyed by their own code rather than a surrogate id,
because the code is what a user types, what prints, and what an item refers to.

**A counter's scope key is never NULL.** `numbering_counters.fiscal_year_label` is the
empty string for a series that never resets, and the repository maps that to and from the
domain's `null`. A NULL in a unique index does not collide, so a nullable scope column
would admit two counter rows for one series — and two counters hand the same number to two
invoices. Three triggers guard the rest of the same fact: a counter may only move forward,
may not be deleted, and a series that has handed out a number may not change shape.
Reissuing a number is not an error anybody sees; it is a second invoice carrying a number
an officer will match against the first.

An account's _type_ — asset, liability, equity, income, expense — is the one field that
may never change once anything has posted to it, because every figure already in the
books was classified by it. The `UpdateAccountInput` DTO has no `type` for that reason.

### The trade document, and the four columns added to it since

`documents`, `document_lines` and `document_line_taxes` (`0008`) hold all five kinds —
quotation, sales invoice, credit note, purchase bill, debit note — in one table with a
`kind` column. The five differ in three fields and are otherwise identical, and five
tables would have meant five copies of the tax summary and a Phase 3 that was a schema
change rather than a posting rule.

**The columns that are not there are as much of the design as the ones that are.** There
is no `grand_total`, no `total_tax` and no `outstanding`: every figure on the foot of a
document is a fold over its lines, computed when asked. `document_lines.taxable_amount`
is the one deliberate exception, because it is the number handed to the regime and the
multiplication that produced it rounds — recomputing it later from a price with more
places than the line shows would give a figure the tax was never calculated from.
`document_line_taxes` is the other, and it is the regime's answer as of the document's
own date: rates change, and an invoice must reprint years later exactly as it was taxed
and exactly as it was filed.

Four columns have been added since, and each is a fact that cannot be derived from the
figures:

**`original_document_id` (`0013`) — what a credit note corrects.** Nothing in the ledger
reads it, and it could not: a credit note that names its invoice and one that does not
post identically, because a return adjusts accounts rather than documents. It exists for
GSTR-1 table 9B and for the person reading the paper, and it cannot be reconstructed
afterwards — two invoices to one customer in one month for one amount are ordinary, and
nothing in the figures says which one a note undid. It is **nullable**, because one
credit note against several invoices has been legal since the 2019 amendment to section
34 and has no single original to name.

**`due_date` (`0014`) — when an invoice falls due.** The obvious version needs no column:
`parties.payment_terms_days` has existed since `0005`, so a report could add it to the
document date on the way past. That is the version this column exists to refuse. Terms
are a fact about a party _today_; the date an invoice fell due is a fact about _that
invoice_, fixed when it was issued. Under the derived version, moving one customer from
30 days to 15 silently re-ages every invoice they have ever had — including ones in
closed periods and on reports already printed and signed. So the due date joins the small
set of facts stamped at issue and frozen: the number, the series, the entry. The rule is
a **biconditional** — present exactly when a kind that charges on terms has left draft —
because a one-way rule leaves the dangerous direction legal: an issued invoice with no
due date reads to an aged report as a document that is never late, and every total still
ties.

**`export_tax_payment` and `is_reverse_charge` (`0020`) — how a supply is taxed, as
opposed to what the tax came to.** The first looks like a reporting flag and is not. A
supply that leaves the country is inter-state, so the full rate arrives as one integrated
component — right for an export on which tax is paid and refunded, wrong for one made
under an undertaking, where no tax is charged at all. Until this column, the only way to
show nothing was to set the line's rate to zero, and **that is a different supply**: a
rate with no tax is zero-rated and the credit on its inputs stays refundable, while a
rate _of_ zero is nil-rated and that credit has to be reversed. Every total on the return
still adds up either way. `is_reverse_charge` is `NOT NULL DEFAULT 0` because forward
charge is the honest default — a document wrongly marked reverse charge invents a cash
liability that no credit can discharge.

**`itc_eligibility` (`0021`) — whether credit may be taken, on the line.** One bill can
carry a laptop and a staff car. It is also where the posting rule needs it: an ineligible
line's tax is not recoverable, so it is not an asset, and it posts to the line's own
value account rather than to input tax. The two ineligible members are kept apart because
a return reports blocked credit and un-availed credit in different places and the money
is identical, so collapsing them loses which one a figure was. **NULL is a fourth state
and not one of the three** — a return resolves it to `eligible` and _counts the
resolution as an issue_, which is why `0021` declines to backfill: a backfilled
assumption is indistinguishable from a decision.

### Receipts and allocations

`receipts` and `receipt_allocations` (`0012`) are the other half of an invoice: what has
been paid against one. Three rules, in
[`src/main/domain/receipts/types.ts`](../src/main/domain/receipts/types.ts).

**A receipt is posted the moment it exists, and there is no draft.** `number` and
`entry_id` are both `NOT NULL`, where a document's are both nullable, and that difference
is the whole rule. A document has a draft stage because an invoice is built up before it
means anything; a receipt records money that has _already moved_. A draft receipt would
be a row saying money arrived that the ledger has not seen, and a customer's balance that
disagrees with a payment they can quote the reference for. The state `0008` needs a CHECK
to forbid — issued and not yet posted — is one this table cannot represent. `status` has
two values and not three, and a mistake is corrected the way an issued invoice is:
reverse the entry, keep the number, mark it cancelled. Rule 50 wants a receipt voucher
series consecutive for exactly the reason rule 46(b) wants an invoice series consecutive.

**An allocation is a matching record and not a posting.** Both the invoice's debit and
the receipt's credit already carry the party's id, so the control account is correct the
instant the receipt posts, whether or not anybody has said which invoice it pays. Saying
which moves no money, writes no entry and changes no balance — which is why these rows
may be rewritten while a posted entry may not, and why the row carries **no date and no
narration**: giving it either would invite somebody to report on it as though money moved
when the matching was done. A receipt with nothing allocated is money on account, which
is an ordinary thing a business has rather than an unfinished task.

**Nothing derivable is stored, again.** There is no `allocated`, no `unallocated`, no
`is_settled` and no `paid` status. A document's outstanding is the movement its entry
made on the party's control account, less what has been allocated to it; a receipt's
spare money is its amount less the same sum. The identity that falls out —

```
party control balance = SUM(document outstanding) - SUM(receipt unallocated)
```

— is what makes it impossible for an aged report and the balance sheet to disagree, but
only if the report _shows_ the unallocated money rather than quietly dropping it.

There is deliberately **no `method` column**. Cash, NEFT, IMPS, UPI, cheque, card was
considered and not written: the account already says cash or bank, and what a user needs
is the `reference` — a cheque number, a UTR, a UPI reference — as free text, because it is
somebody else's format. A closed list in a CHECK is a table rebuild on the day somebody's
payment app is not on it.

`0015` widened the voucher kinds from two to four. A **refund** is a sales-side voucher
that moves money out and touches _receivables_; a **refund received** is its purchase-side
mirror. Those two rows are why `controlRole` earns its keep — direction disagrees with
side on half the table, and the control account does not follow either.

`0015` also wrote a trigger `0012` had considered and declined, and the reversal is worth
reading. `0012` argued that a wrong pairing was never silent, because with one voucher per
side it was always cross-account: a payment against a sales invoice puts one end on
receivables and the other on payables, and two control accounts visibly stop agreeing. A
refund is on the **same side** as a receipt and moves the **same** control account — so a
refund allocated to a sales invoice is same party, same side, same account, and the only
thing wrong with it is the direction. Nothing looks odd anywhere except an aged report
saying it does not tie, without being able to say why.

### Document offsets — a credit note set against an invoice

`document_offsets` (`0016`) is `receipt_allocations` again **with money at neither end**.
`0015` gave a refund document a voucher — money actually going back — and left the
commoner case unbuilt: the credit note nobody pays out, which simply reduces the next
invoice. Until this table there was no way to say _which_ invoice, so an aged report
showed the invoice in `Over 90 days` and the credit note on account beside it, with
nothing that could match them.

An allocation matches two movements on one control account that point opposite ways, and
that sentence never mentioned money. It was true of a receipt because a receipt moves
receivables the way a credit note does. So an offset is the same row with a document at
the end where a voucher used to be: it posts nothing, carries no date and no narration,
and may be rewritten where an entry may not.

**It is not a column on `documents`**, because a credit note may be set against three
invoices and an invoice may take credit from two notes — and because one column holds no
_amount_ at all, which is the whole of what a partial offset is.

**And it is not `original_document_id`, which already points the right way.** The two
links look nearly identical and say different things. `0013` records what a note
**corrects** — the supply being undone, which a filed return names, so it is frozen at
issue and there is one of it. `0016` records what a note **settles** — decided after both
documents are issued, changed as often as the parties agree, and there may be several. A
note raised for a short delivery in April may perfectly well be set against November's
invoice, because a credit balance is money and money settles whatever the two sides agree
it settles. They coexist with no rule tying them together, deliberately: a rule refusing
that would be `0016` inventing a policy `0013` explicitly declined to have.

**The set belongs to the refund end, and only to it.** That is a repository rule
(`db/repos/offsets.ts`) rather than a constraint, and it is the reason the invoice's own
screen shows the offsets read-only. If both ends could replace an overlapping set, the
last save would silently drop the other's rows — two screens, each correct on its own,
each deleting what the other had just written.

The caps — an offset may exceed what is unsettled at neither end — are repository checks
and not triggers, for `0012`'s reasons arriving unchanged. They depend on the ledger and
on which account currently fills a control role, both of which can move under a row that
is already written; they depend on each document's direction, which lives in a TypeScript
table a CHECK cannot import; and what they prevent is **visible** — an over-offset
document shows a negative outstanding, which a reader notices. What _is_ a trigger is the
same-party rule, for the opposite reason: an offset across two parties takes A's
outstanding down because B was credited, the control account still totals, the trial
balance still ties, and both statements are quietly wrong from that day on.

### Warehouses

`warehouses` (`0018`) has a **surrogate id where `units_of_measure` has none**, and the
contrast is the decision. A unit's code _is_ its identity, because it is what a person
types on a line and what prints on the invoice. A warehouse's code is an internal handle —
`MAIN`, `WH-2`, `GODOWN-A` — that nothing prints, and a business that reorganises its
premises renames one without meaning to rewrite every movement recorded against it. So
the id is the identity, the code is a label, and `updateWarehouse` permits a code change
while `updateUnit` refuses one.

Both `code` and `name` are unique **ignoring case**, and the half of that rule which is
not in the migration is the one that has already cost this project a bug: a `NOCASE`
unique index and a case-sensitive comparison do not agree.
`SELECT id FROM warehouses WHERE code = 'main'` returns nothing while `MAIN` is present,
and the very next INSERT is refused by the index — so the user sees a raw constraint
message instead of "MAIN is already a warehouse in these books", and the repository check
written that way is not merely useless, it is unreachable.

**Nothing seeds a warehouse in the migration, and something has to seed one somewhere.** A
stock movement names a warehouse and the column is `NOT NULL`, so a company file with no
warehouse can record no stock at all. A migration is the wrong place for it: a seed there
runs on every existing company file, including those belonging to businesses that keep no
stock, and would put a warehouse in front of people who have no use for one and cannot
delete it once a movement exists. So `seedDefaultWarehouse` is called by `setUpBooks`,
beside the chart of accounts and the numbering series, when a company is created.

### The stock ledger

`stock_ledger` (`0019`) is one row per movement, per item, per warehouse — the register
`ARCHITECTURE.md` §6.4 requires to reconcile with the general ledger. Seven kinds, from
`src/main/domain/inventory/types.ts`: `opening`, `receipt`, `issue`, `purchase-return`,
`sales-return`, `adjustment-in`, `adjustment-out`.

**The columns that are not here are the design.** There is no `balance_quantity` and no
`balance_value`, and no derived cost on an outward row. The header of `0019` is the
argument, and it has three parts in increasing order of how much they settle it.

The convention against stored balances is the first, and on its own it is arguable: it
carves out exactly this shape for `due_date` — a value whose inputs can change, stamped
and frozen. **What kills the stored version is that freezing is not available here.** A
due date frozen at issue stays true forever. A running balance frozen before a back-dated
receipt is simply _wrong_ the moment the receipt lands, because the quantity on hand
really did change; and under moving weighted average a back-dated receipt re-averages the
pool, so it changes what every issue after it cost. The only stored version that works is
one that rewrites every later row — an UPDATE path over rows that mirror immutable
journal entries, plus a second implementation of the fold to drive it.

The second is that the domain has already decided, and is tested on it: the stock card is
recomputed, never stored. `runStockCard` folds from an opening state every time, in
date-then-sequence order, whatever order the rows arrived in.

And the third ends it: **a stored outward value is a value the domain refuses to take
back.** An outward movement is valued by the strategy and may not carry a cost at all —
`checkMovement` returns `COST_NOT_PERMITTED` for one that does — so a row that stored what
an issue cost could not be read back into a `StockMovement` without stripping the figure
off it again. This table stores a `StockMovement` and nothing a valuation produces, and
the two shapes therefore match with nothing in between them to get wrong.

**What it costs, stated plainly.** Every read of a card or of stock on hand is O(movements
for that item in that warehouse), every time, with no cached answer. And because an
outward movement's value is derived at read time, recording a back-dated receipt changes
the cost of a sale that has _already posted_. The register moves and the ledger cannot,
because a posted entry is immutable. The answer is a valuation adjustment for the
difference — a second entry, dated at the movement it restates, the same shape as a
reversal — never an edit to the first.

`cost` is nullable and its nullability is a rule: an inward movement **states** what the
goods cost, because a purchase bill line already fixed that figure and there is nowhere
else for it to come from; an outward movement is **valued** and states nothing. The CHECK
is a biconditional, and the second half is the dangerous one — an inward row with no cost
values stock at nothing, and the card that results is arithmetically impeccable.

**Value cannot exist without quantity; quantity can exist without value.** The asymmetry
is deliberate. Stock held at nil is an ordinary fact — a free sample taken in at zero, an
item written down to nothing — and a row carrying quantity `0.000` _with_ a cost is
freight capitalised onto stock already on hand. The illegal state is not a row but a
running total, which this table structurally cannot see, so it is refused in the domain
where somebody can still fix it.

`sequence` is the tiebreak **within** a date and never the order itself: a back-dated
movement takes the highest sequence and the earliest date, which is exactly the case that
matters. A duplicate makes `runStockCard` refuse the whole set rather than reorder two
rows, because issue-then-receive and receive-then-issue are not the same card.

Rows are append-only, like the journal's, and here the reason is sharper: editing a
movement changes what every later movement cost, while the entries those costs posted as
cannot be edited to match.

`entry_id` (`0022`) is §6.4's other half — the journal entry each movement posts as, in
the same transaction. It is **not** a cached figure, and the distinction is `0019`'s own:
a running balance is refused because a back-dated movement changes it, while an entry id
is the identity of an immutable row and cannot drift. The trigger says only the half the
row can prove — an inward movement whose stated cost is not zero must name an entry —
because an outward movement's value is not in the table to test. The repository states the
other half with the strategy's figure in hand, and `0022`'s header says so rather than
implying a floor that is not there. A movement that moved no money names no entry and is
not a hole in the reconciliation: a journal entry of two zero lines is refused by the
ledger anyway, and nothing moved, so nothing had to be recorded.

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

### Six things SQLite does that its documentation does not lead you to expect

All measured on 3.53.4, on a scratch database, rather than read. Each one has cost this
project time, and each one is the kind of fact that makes a rule you thought you had
written turn out not to be there.

**A `BEFORE INSERT` trigger pre-empts every CHECK constraint on the row, and the most
recently created trigger fires first.** A table with a CHECK and one trigger reports the
trigger; add a second trigger, and it reports the second one. Which means **adding a
trigger to a table changes which rule an existing bad write reports**. That is not a
theoretical hazard — it broke 26 tests in one batch, each of which had been asserting a
different constraint from the one it named. If a test asserts an error code, it is
asserting the order of the guards as much as the guard, and the way to test a CHECK is to
write a row that only the CHECK objects to.

**`ALTER TABLE … DROP COLUMN` and a CHECK: it depends on which kind of CHECK.** A
_column_ constraint goes with its column, so dropping the column succeeds — even when the
constraint names a different column of the same row, which is the shape migration `0017`
uses to refuse a stock-tracked service. A _table_ constraint naming the column does not,
and the failure arrives on the schema re-parse afterwards:
`error in table t after drop column: no such column: b`. So the documentation's "the
column may not be used in a CHECK" is true of one of the two spellings.

**A trigger holds a column down harder than a CHECK does.** `DROP COLUMN` is refused
outright while any trigger reads the column — `error in trigger dt after drop column: no
such column: NEW.b`. This is why `0017`'s `down` only works after `0019`'s has run: `0019`
put a trigger on `items` that reads `is_stock_tracked`. The rollback runner reverts newest
first, so the order is supplied rather than hoped for, and the registry test rolls the
whole list back rather than one migration to prove it.

**`ADD COLUMN … NOT NULL DEFAULT 'x' REFERENCES …` is accepted, and what fails afterwards
is narrower and worse than "the table is unwritable".** The statement does not fail at
migration time. An insert that _names_ a real parent succeeds. Only an insert that takes
the default fails, with `FOREIGN KEY constraint failed` and nothing naming the column. So
the table is not unwritable forever — it is writable through every caller that happens to
supply the column, and broken for the one that does not, which is much harder to find than
a table nothing can write to. Migration `0005` met this from one side and `0022` measured
it from the other.

**`DEFERRABLE INITIALLY DEFERRED` defers to COMMIT — and every statement outside an
explicit transaction is its own commit.** A child row written before its parent is
refused immediately in autocommit and accepted inside a `BEGIN`, where the check moves to
the `COMMIT` that follows. This is what lets `0004` write journal lines before their
entry so that a `BEFORE INSERT` trigger on the entry can see a complete set. It is also
why the deferred key on its own enforces nothing about order: a parent written _first_
commits perfectly happily, and that order skips the balance check entirely, because the
sum of no lines is zero. Three triggers hold the order, not the key.

**A CHECK whose expression evaluates to NULL passes; a trigger's `WHEN` that evaluates to
NULL does not fire.** NULL is "no opinion", not false. So `CHECK (length(trim(code)) > 0)`
says nothing whatever about a missing code, and every required column needs `NOT NULL`
beside its blank check — one rule in the two halves SQLite needs to hear it in. And in a
trigger, `NEW.number <> OLD.number` is NULL when either side is NULL, which would silently
exempt exactly the transitions that set a nullable column for the first time. `0009`'s
freeze wraps every nullable column in `IFNULL` for that reason.

### A merged migration is never edited

Not to fix a typo. Not to add a column. Not "because nobody has run it yet" — someone
has, and the databases that already ran it will never run it again. Their schema would
then differ from the one the migration list claims to produce, and nothing would detect
the divergence. There is no checksum on migration bodies, so the drift would be silent
and permanent.

Fix it forward with a new migration. This is [`CONVENTIONS.md`](./CONVENTIONS.md) §1.5
and it is a review rejection, not a discussion.
