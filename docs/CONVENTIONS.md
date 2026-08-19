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
   contradict. Derive it.
4. **No `any`.** `strict: true`, `noUncheckedIndexedAccess: true`. Use `unknown` and
   narrow. `@ts-expect-error` needs a comment explaining why.
5. **Never edit a merged migration.** Fix it forward with a new one.
6. **Tax logic lives in `regimes/`.** If you are about to write `gst` or `cgst` outside
   `src/main/regimes/in-gst/`, stop.
7. **The renderer never computes money.** It displays what main sent.

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
- A **CANARY** that must be killed, anchored on something a test pins by value. It is the
  only proof that a kill was still possible at all.
- An **anchor check**. When the text being replaced does not appear exactly once, say so
  instead of skipping — a reformatted file silently drops mutations otherwise. Run the
  harness _after_ `npm run format`.

Snapshot the files to disk, not only to memory: an interrupted run does not execute its
`finally`, and the mutation left behind becomes the next run's "original".

**Defence in depth makes tests blind.** Where a rule lives in both a migration and a
repository, a test that goes through the repository passes whichever layer answers first
— and the database constraint can be deleted with nothing failing. This has now been
found in three separate batches. Test the constraint by writing straight to the table.

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
  - the single-row `settings` company profile
- **Do port the discipline:** the decimal handling, the golden fixtures, the typed IPC
  proxy, the migration runner, the security model. That is the part worth having.
