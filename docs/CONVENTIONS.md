# Coffer — Conventions

> Read this before writing code. It exists so that work done in parallel by
> different people (or agents) merges cleanly and reads as one codebase.

---

## 1. Rules that are not negotiable

Breaking any of these is a review rejection, not a discussion.

1. **No floats for money.** No `number` for a monetary value anywhere — not in a
   variable, not in a database column, not in a JSON payload crossing IPC. Money is a
   `Decimal` in memory and a decimal string at every boundary.
2. **`domain/` is pure.** No imports from `db`, `electron`, `node:fs`, or any I/O. If a
   domain function needs data, it takes it as an argument.
3. **No stored balances.** Never add a column that caches a total the journal could
   contradict. Derive it. **The test is whether the INPUTS can change, not whether the
   answer can be computed.** A balance is derived because every line it sums is immutable,
   so the answer cannot drift and a stored copy can only ever disagree. A due date is
   computed from the document's date and the party's terms and is stored anyway (migration
   0014), because `payment_terms_days` is a fact about the party _today_: deriving it would
   mean that editing one customer re-ages every invoice they have ever had, including ones
   in closed periods and on reports already printed and signed. Where a computed value
   depends on something a user can edit later, it is not derived — it is **historical**.
   Stamp it when the event happens and freeze it, the way a document's number and its entry
   already are.
4. **No `any`.** `strict: true`, `noUncheckedIndexedAccess: true`. Use `unknown` and
   narrow. `@ts-expect-error` needs a comment explaining why.
5. **Never edit a merged migration.** Fix it forward with a new one.
6. **Tax logic lives in `regimes/`.** If you are about to write `gst` or `cgst` outside
   `src/main/regimes/in-gst/`, stop.
7. **The renderer never computes money.** It displays what main sent. It does _format_
   it — where the separators go is presentation — and it takes the rule for that from
   `regime.describe()` rather than choosing one. `formatAmount` requires a
   `NumberFormat`; there is no default, because the default was the lakh/crore grouping
   and it was silently wrong for everyone outside India.

   A COROLLARY WORTH ITS OWN SENTENCE: where a figure main sends is SUBTRACTED to reach a
   total beside it, the COLUMN HEADING carries the sign and the figure keeps the one it
   arrived with. "Less on account", not a negated copy of what main sent as a positive
   quantity — flipping a sign is arithmetic, and a screen that does it in one place and
   not another ends up contradicting itself. The aged report is where this bites: the same
   money is a positive in a party's on-account column and a negative on the item behind
   it, because it is a credit, and no heading can be right for both (`AgedReport.tsx`).

8. **"As at a date" is a filter on the LEDGER, never on the document.** A report drawn as
   at 30 June counts entries dated on or before it — not documents raised by then, and not
   today's rows under last month's heading. The difference is invisible until something is
   cancelled or settled after the date: an invoice cancelled in July WAS outstanding on 30
   June, because the reversal is a second entry and it was not in the books yet. And where
   a figure is netted off by a MATCH between two things — a receipt against an invoice —
   the match counts only once BOTH ends were in the books by the date. One end alone gives
   a page that reads plausibly and shows an invoice nobody had yet raised as part paid
   (migration 0014, `db/repos/ageing.ts`).

9. **Choosing over a closed union is a TOTAL RECORD, never a conditional.** `Record<Kind,
T>` — or a lookup that goes through the kind table — and never `kind === 'a' ? x : y`,
   never an `if/else` chain, never a `.find` that takes the first match. The reason is
   that the two are indistinguishable while the union has two members and stop being the
   same thing the moment it has three: a record does not compile until the new member is
   answered for, and every other shape silently gives it whatever the last branch said.

   MEASURED, TWICE. `receiptPostingRuleFor` was `kind === 'receipt' ? receiptRule :
paymentRule` and was correct for as long as there were two voucher kinds; 0015 added
   two and it would have posted a customer's refund with the PAYMENT rule, onto accounts
   payable, where no statement of theirs would ever have shown it. Nothing in the suite
   pointed at it. And `chargeKindIn` exists in its counting form because 0013-2 found a
   `.find` implementing "whichever is listed first" while looking like a rule.

   THE COROLLARY IS THAT THE GUARD TAKES ITS TABLE AS AN ARGUMENT. A refusal that the real
   table cannot trigger is a line no test can reach and no mutation can kill, so the
   function is given the list to search and a test hands it the ambiguity (`postingKindIn`,
   `settledByIn`).

10. **A SIGN BELONGS TO THE THING, NEVER TO THE QUERY THAT FETCHED IT.** Where a figure has
    to be added or subtracted, read the direction off the ROW — its kind, its facing — and
    never off which table, which join or which branch it arrived through. The two agree
    exactly as long as every row of that table points the same way, which is a property
    nothing states and nothing tests.

    MEASURED. `ageing.ts` took an allocation OFF a document and put it BACK ON a receipt,
    and the comment beside it argued the asymmetry correctly: a document's movement was
    positive, a receipt's was negative, so bringing each to zero meant opposite signs. It
    was the right pair of signs for the wrong reason. 0015 added the two kinds that break
    it, and a 400 refund against a 1,180 credit note reported the note at -1,580 and a
    fully settled voucher at +800. It is one function now — a match opposes the end it is
    on, whether that end is a document or a voucher — and `receiptFacing` is what lets a
    voucher be described in a document's word.

    AND THE HALF THAT MATTERS MORE, BECAUSE IT IS ABOUT TESTS: A REPORT THAT CHECKS ITSELF
    WITH A TOTAL CANNOT SEE AN ERROR THAT APPEARS TWICE WITH OPPOSITE SIGNS. Both figures
    above were wrong and `ties` stayed TRUE, because a match is applied at two ends and the
    two mistakes cancelled at the foot. A tie is a statement about the arithmetic between
    the rows, not about the rows. Assert the items as well, every time.

## 2. Naming

| Thing                    | Style                           | Example                        |
| ------------------------ | ------------------------------- | ------------------------------ |
| Database tables, columns | `snake_case`, tables plural     | `journal_lines`, `posted_at`   |
| TypeScript               | `camelCase`, types `PascalCase` | `journalLines`, `JournalLine`  |
| Files                    | `kebab-case.ts`                 | `posting-engine.ts`            |
| React components         | `PascalCase.tsx`                | `InvoiceEditor.tsx`            |
| IPC channels             | `group:method`                  | `invoices:list`                |
| Migrations               | `NNNN_snake_summary.ts`         | `0007_journal_entries.ts`      |
| Booleans                 | `is` / `has` prefix             | `isGroup`, `hasOpeningBalance` |

Repos map `snake_case` rows to `camelCase` DTOs at the repo boundary. Nothing above the
repo layer sees a snake_case key.

## 3. Types and storage

| Kind           | In TypeScript            | In SQLite                           |
| -------------- | ------------------------ | ----------------------------------- |
| Money          | `Decimal`                | decimal string, 2dp                 |
| Quantity       | `Decimal`                | decimal string, 3dp                 |
| Rate / percent | `Decimal`                | decimal string, 3dp                 |
| Timestamp      | ISO-8601 UTC string      | `TEXT` — `2026-08-13T09:30:00.000Z` |
| Date           | `YYYY-MM-DD` string      | `TEXT`                              |
| Boolean        | `boolean`                | `INTEGER` 0/1                       |
| Enum           | union of string literals | `TEXT` + `CHECK` constraint         |
| Money in a DTO | `string`                 | —                                   |

Never store a local-time timestamp. Never store a `Date` object.

**A `Record<string, string>` whose KEYS come from a file is `Object.create(null)`, not
`{}`.** `Record<string, string>` is a promise about values, and a plain object breaks it
the moment the key is somebody else's. Measured:

```js
const o = {}
o['__proto__'] = 'hello'
Object.keys(o) // []            the write VANISHED — no own property
typeof o['__proto__'] // 'object'      and reading it back gives Object.prototype
typeof o['constructor'] // 'function'    which the type says is a string
```

Neither of those throws, and neither is visible at the write. `Object.create(null)` has no
inherited keys, so the key stays a key and the value stays a string; a `Map` does the same
where lookups are the point. This is why the XML reader's attribute records are
null-prototype objects and its entity table is a `Map` — an attribute name comes from the
file, so the file chooses the key. There are tests pinning both, one of which asserts
`Object.keys` equals `['__proto__', 'constructor', 'hasOwnProperty']`.

**A column that must be filled in exactly some of the time gets ONE rule, written as a
biconditional, not two checks.** `due_date` is present exactly when a document has left
draft on a kind that charges on terms — one trigger condition, both directions at once.
Two separate checks would leave whichever direction nobody thought to write, and the one
people forget is reliably the dangerous one: an issued invoice with a MISSING due date
reads to an aged report as a document that is never late, and every total on the page
still ties. A wrong answer that disagrees with something gets found; a wrong answer that
agrees with everything does not.

## 4. Adding an IPC endpoint

The contract in `src/shared/ipc.ts` is the single source of truth:

1. Add the method to its group in the `CofferApi` interface.
2. Add any DTOs to `src/shared/dto.ts`.
3. Add the method name to `API_SURFACE` in `src/main/ipc/surface.ts`. `CofferApi` is an
   interface and does not exist at runtime; this is its runtime enumeration, and both the
   preload bridge and the startup check read it. Its type is mapped over the contract, so
   **typecheck fails until you do this**.
4. Register a handler in `src/main/ipc/handlers/<group>.ts` under `group:method`.

The renderer proxy is generated — call `api.invoices.list(args)` with no extra wiring.
Do not add a bare `ipcRenderer.invoke` anywhere.

`assertApiSurfaceComplete` runs at startup, before any window exists, so a contract method
with no handler behind it crashes the app at boot rather than at click time.

Handlers validate their input, catch, log, and return a typed result. An unhandled
throw in a handler is a bug.

## 5. Errors

```ts
// Expected, actionable — the user can fix it
return { ok: false, error: { code: 'PERIOD_CLOSED', message: 'The period is closed.' } }

// Unexpected — throw, let the handler boundary log it
throw new Error(`Unbalanced entry: debits ${d} != credits ${c}`)
```

User-facing messages say what went wrong and what to do. No stack traces in the UI, no
apologies, no `Something went wrong`.

## 6. Tests

- Co-locate: `posting-engine.ts` → `posting-engine.test.ts`.
- `domain/` and `regimes/` need real unit coverage; that is where correctness lives.
- Money, tax, and posting rules use **golden fixtures** in `__fixtures__/*.json`.
  Changing a rounding or tax rule must break a test — that is the point.
- Repos test against in-memory SQLite, seeded per test.
- No snapshot tests for anything numeric.

Every batch must leave `npm run typecheck && npm test` green.

### Two environments

Vitest runs two projects, chosen by directory:

| Where                                   | Environment | Setup                            |
| --------------------------------------- | ----------- | -------------------------------- |
| `src/main`, `src/preload`, `src/shared` | `node`      | none                             |
| `src/renderer`                          | `happy-dom` | `src/renderer/src/test/setup.ts` |

A renderer test runs in a browser environment because the renderer runs in a browser.
Not jsdom: it has no `<dialog>.showModal()` and no `matchMedia`, both of which this
product depends on — the measured comparison is in `setup.ts`.

### Screen tests

Render a screen with `renderScreen` from `src/renderer/src/test/harness.tsx`. It supplies
the providers a screen expects and a `window.coffer` built by the **real** `createApiProxy`,
so a stub is looked up by the channel production would actually call. A channel nothing
answers fails the test by name rather than silently becoming an error notice.

- Assert on **what crossed the bridge**, not only on what is drawn. State that never
  reaches an input is not observable in the DOM: a `<select>` whose chosen option is
  removed falls back to the first one on its own, so the field can read correctly while
  the state behind it is stale.
- Assert figures **by position**, not by presence. A debit found "somewhere in the row"
  is found just as happily when the two columns have been swapped.
- Order fixtures so they **disagree** with the expected output. A chart of accounts
  listed in its natural order cannot tell a sorted report from an unsorted one.

### Mutation testing

A passing test is not evidence until it has failed. Before a batch is called done, break
each rule it claims to enforce — one edit at a time, run the tests, put it back — and
check that something fails. Every batch so far has found a rule nothing was testing.

The harness that does this needs three things, and each has been learned by losing time
to its absence:

- A **CONTROL** that changes nothing. If the control is reported as killed, one test was
  already failing and no other number in the report can be believed. Stop there.
- A **CANARY** that must be killed, anchored on something a test pins **by value**. It is
  the only proof that a kill was still possible at all — and "by value" is the whole of
  it: a canary sitting on a message no assertion reads survives, which reports a broken
  harness as a broken suite. 0012's first one did exactly that.
- An **anchor check**. When the text being replaced does not appear exactly once, say so
  instead of skipping — a reformatted file silently drops mutations otherwise. Run the
  harness _after_ `npm run format`.

Snapshot the files to disk, not only to memory: an interrupted run does not execute its
`finally`, and the mutation left behind becomes the next run's "original".

The harness is **`scripts/mutate.mjs`**, reached as **`npm run mutate`**:

```
npm run mutate -- --file src/main/domain/money/scale.ts --anchor '  money: 2,' --replace '  money: 3,'
npm run mutate -- --defs domain-money          # a recorded campaign
npm run mutate -- --defs domain-money --dry-run # anchors only, no tests
```

The first form is a one-off. The second reads a definitions file from
`scripts/mutations/`, and that difference is the difference between a claim and
evidence: "I mutation-tested it" is a statement about a run nobody else can repeat,
whereas a definitions file is the same statement with the run attached to it.
`scripts/mutations/domain-money.mjs` is the worked example — a canary, eleven
mutations, and a note on each survivor saying whether it is a gap or an equivalent
mutant. The exit code carries the verdict on its own, so the page need not be read to
be acted on: 0 everything killed, 1 something survived, 2 the run was broken.

It has its own test, `scripts/mutate.test.mjs` — `node --test scripts/mutate.test.mjs`
— which is the same argument one level up rather than ceremony. **A tool that reports
on your tests needs its own.** What it proves is that a killed control reports BROKEN,
that a surviving canary reports BROKEN however clean the rest of the page looks, that a
zero-match anchor is reported rather than skipped, that a snapshot left by an earlier
run refuses to start, and that an exception mid-campaign still puts the source back
byte for byte. Its fixtures are under the OS temp directory; it mutates nothing in
`src/`.

**Why the control and the canary are not optional.** In a single day this harness
failed in ten distinct ways, and each one printed a full page of confident results that
was entirely fictional. They are worth listing because they do not look like bugs when
you are writing them, and because each is now a thing the harness cannot do:

| What went wrong                                                                          | What it looked like                                                |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| PowerShell 5.1 `Get-Content`/`Set-Content` round-tripped UTF-8 through the ANSI codepage | every em-dash corrupted and a BOM added, in silence                |
| `npx.cmd` through `spawnSync` refused with `EINVAL` on Windows                           | no run started; every mutation SURVIVED                            |
| a lowercase drive letter as `cwd`                                                        | vitest read it as a different root and failed the whole suite      |
| `--reporter=basic`, which does not exist in Vitest 4                                     | no run started; all 19 mutations SURVIVED                          |
| vitest wrote its summary to stderr                                                       | every mutant, control included, reported as a module-load kill     |
| driving vitest from an Electron-as-node parent                                           | 0 tests collected in every file                                    |
| prettier reformatting between runs                                                       | a canary's anchor silently deleted                                 |
| an interrupted run left a mutation in the source                                         | the next run snapshotted it as the original and made it permanent  |
| reading only the `Tests` line                                                            | `Test Files 1 failed` above `Tests 384 passed` called a gap        |
| Python's `write_text` translating `\n` to `\r\n`                                         | a whole file to CRLF, and every multi-line anchor stopped matching |

Ten different causes and one symptom: **a run that never started is indistinguishable
from a run that caught nothing.** Exactly one of the ten was noticed by reading the
report, and only because the anchor check said `ANCHOR? (matched 0x)` out loud. Every
other one was caught by a control that should have been green and was not, or by a
canary that should have died and did not. That is what those two are for, and it is why
a report carrying neither of them is not a result — it is a page of numbers.

So the harness is Node only — nothing but `fs` with an explicit `utf8` ever writes a
source file, and the restore path copies the original bytes rather than re-encoding
text. It spawns vitest's own entry with `process.execPath`, never `npx`. It
upper-cases the drive letter. It concatenates stdout and stderr before it parses. It
reads the FILE count before the test count, both against a baseline the control took
before anything was touched. And its snapshot is a file on disk, so finding one is a
refusal to start rather than a warning.

**Defence in depth makes tests blind.** Where a rule lives in both a migration and a
repository, a test that goes through the repository passes whichever layer answers first
— and the database constraint can be deleted with nothing failing. This has now been
found in six separate batches. Test the constraint by writing straight to the table.

**Two filters on one query mask each other when no fixture makes them disagree.** Not the
same failure as two implementations of one rule: here each filter is written once and is
correct, and the suite still cannot tell whether either exists. `openDocumentsFor` narrows
by party and by side, and every fixture had a customer and a vendor who were different
people — so deleting the side test changed no result, because the party test had already
excluded the other side's rows. The case that separates them is the ordinary one nobody
had written down: a firm you both buy from and sell to. Ask of each condition in a
compound `WHERE` what row it alone excludes, and build that row (0013-1).

**And it makes one of the two layers unreachable, which is worse.** The same overlap read
from the other side: if the repository's check runs _after_ the write that trips the
trigger, the repository check can never answer, and no assertion on the error code can
tell — both layers report the same code by design. 0012 was written that way and a
mutation deleting the check changed nothing. The fix is not a cleverer test: it is to
decide the rule **before** touching the database, so the repository speaks first and says
the sentence with the figures in it, and the trigger is the floor underneath. Where the
two must both be reachable, assert on `details` or on the message — only one layer
populates either.

**A guard against a state the real data cannot reach is a guard nothing can kill.** The
correction mapping in `shared/documents.ts` refuses a side with two charge kinds, which
the shipped table cannot have — so the mutation that deleted the refusal survived the
whole suite, correctly. The answer is not to label it equivalent and move on: it is to let
a test hand the function the table it is guarding against. `correctionMap` takes the kinds
as an argument for exactly that reason, and the test builds the ambiguous table in four
lines (0013-2).

**`.find` cannot tell "one answer" from "the first of two".** Where a rule says "the one
X that matches", `filter` and a count say it and `find` does not — `find` silently
implements "whichever is listed first", so the rule becomes table order and no assertion
downstream can see the difference. 0013's first correction mapping was written that way
and passed only because `sales-invoice` is listed above `quotation` (0013-2).

**The absence of the old name is not the presence of the new one.** A test asserting that
a button is NOT offered keeps passing after that button is renamed — it is now asserting
the absence of a string nothing renders, which is true of every screen in the product.
0013-2 asserted that a purchase bill offered no `Record a receipt`, correctly, because no
payment editor existed; 0013-3 built one and called the button `Record a payment`, and the
test went on passing while testing nothing. **When a batch supplies the thing an earlier
one asserted was missing, grep the suite for assertions about its absence.** Assert the
new name's presence beside the old name's absence (0013-3).

**A mutation that breaks module load prints no test summary at all**, which a naive
harness reports as no result — and "no result" reads exactly like "nothing caught it". It
is the loudest possible kill: every test in every importing file fails to collect. The
harness now reads `Test Files N failed` as a kill in its own right and says so (0013-2).

**The harder half of the same trap: when SOME files load and some do not, there is a Tests
line and it reports no failures.** A run of nine files where one throws at import prints
`Test Files 1 failed | 8 passed` above `Tests 384 passed` — the broken file collected
nothing, so not one test failed. A harness reading the Tests line alone calls that
SURVIVED, which is the exact opposite of what happened. Two rules, and the second is the
general one: **read the FILE count before the test count, and compare the total against a
baseline taken before any mutation — tests that never ran are tests that disappeared.**
Found in 0014-1, where it reported two of the loudest kills in the batch as gaps (0014-1).

**A self-check that cannot fail is not a check.** The aged report carries `ties` — whether
its foot equals the control account it decomposes — in the same spirit as a balance sheet's
`balanced`. Every test asserted it true, and a mutation replacing the whole expression with
`true` survived, because nothing in the suite could produce a file where it was false. The
answer is not a better assertion, it is a FIXTURE: 0012's triggers check that an allocation
names one party but leave the SIDE of the trade to the repository, so a write straight at
the table can settle a purchase bill out of a sales receipt — putting the two ends on two
different control accounts and making the identity genuinely false. **When a reported
invariant is always true, go and build the file where it is not; and when the repository
refuses to create that file, write past the repository** (0014-2).

The general shape is worth stating on its own, because it has now cost three batches: **a
mutation harness reports what it can measure, and a measurement that goes missing looks
identical to a measurement that came back clean.** Anything that reduces what the suite
observes — a file that will not load, a test that stops being collected, a run that never
starts — must be a kill by construction, never an inference from a number that happens to
look fine.

## 7. Commits

Conventional commits, with a DCO sign-off:

```
feat(ledger): add posting engine with balance invariant
fix(invoices): preserve custom UoM instead of coercing to Nos
docs(architecture): document the regime adapter

Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds the sign-off. Scope is the module: `ledger`, `invoices`,
`regimes`, `db`, `security`, `ui`, `build`.

## 8. Working in parallel

When several agents work a batch simultaneously:

- **Own your paths.** Each task lists the files it owns. Read anything; write only
  those. If you need a change in someone else's file, note it for the integration step
  instead of making it.
- **Contracts are frozen.** Interfaces, DTOs and schema stubs are written before the
  batch starts. Implement against them; do not edit them. If a contract is wrong, stop
  and say so — a silent local fix breaks everyone else.
- **Your migration number is reserved.** Use the one assigned to your task. Never pick
  the next free number yourself; two agents will pick the same one.
- **Leave it green.** Typecheck and tests pass for your paths before you report done.
- **Don't drive-by refactor.** Improvements outside your paths go in the report, not the
  diff.

## 9. Porting from the reference project

`../reference/reference-app/` is a read-only snapshot of the project Coffer is derived from.
It is a useful reference and a trap in equal measure.

- **Never copy a file wholesale.** Read it, understand it, write the Coffer version.
- **Strip client identity.** No `reference-app` string, logo, or invoice-format artefact
  reaches this repo. The client's `assets/logo.png` and `specs/reference/*.jpeg` are
  theirs and stay out.
- **Do not port these bugs:**
  - freight hardcoded as never taxed, inside the tax function
  - UoM outside `Nos/Sets/Kg/Mtr` silently rewritten to `Nos`
  - tax computation called directly from screens
  - the single-row `settings` company profile — a table with no subject, shared by the
    profile, the invoice defaults and the e-mail configuration, which every screen wrote
    to and no constraint could describe. Coffer's `company_profile` (migration `0011`) is
    one row as well and is not this: its subject is identity, and a preference does not
    go in it.
- **Do port the discipline:** the decimal handling, the golden fixtures, the typed IPC
  proxy, the migration runner, the security model. That is the part worth having.
