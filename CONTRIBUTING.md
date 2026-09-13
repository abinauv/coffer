# Contributing to Coffer

Thank you for considering it. Coffer is accounting software — people will trust it with
records they are legally required to keep and cannot afford to lose. That shapes how we
work: slower than most projects, with more tests, and a strong bias toward correctness
over features.

Please read this alongside [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md), which covers
naming, types and the rules that are not negotiable, and
[`docs/getting-started.md`](./docs/getting-started.md), which takes you from a clone to a
running window. [`docs/README.md`](./docs/README.md) indexes the rest.

---

## Project status

Coffer is **alpha**, and nothing has been released. The ledger, the documents, the
vouchers and the stock register are built and tested; interfaces still move and the schema
is not yet stable.

The most useful contributions are still **issues, questions and design feedback** — a PR
against a module that gets restructured next week helps nobody. The exception is
[`docs/good-first-issues.md`](./docs/good-first-issues.md): every entry there is drawn from
a note the code left about itself, so the decision is already made and written down, and a
PR is welcome without a conversation first.

## Ways to help

|                             |                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Report a bug**            | Especially anything where a number is wrong. Those are the highest-priority issues in the tracker, always.                                         |
| **Test against real books** | If you run a small business, telling us where Coffer does not match how you actually work is worth more than a patch.                              |
| **Domain expertise**        | Accountants and CAs: tell us where our GST handling, ledger treatment or return output is wrong. You do not need to write code to open that issue. |
| **Translations**            | Once the i18n layer lands.                                                                                                                         |
| **Code**                    | See below.                                                                                                                                         |

## Reporting bugs

Open an issue using the bug template. A good report includes what you did, what you
expected, and what happened.

**If the bug involves a wrong number**, include the document or entry that produced it —
amounts, tax rates, dates and place of supply. Redact names and GSTINs freely; we need
the arithmetic, not your customers.

**Never attach a real company database.** It contains your financial records. If a file
is genuinely needed to reproduce, we will ask you to construct a minimal one.

## Suggesting features

Open an issue using the feature template. Two things make a proposal much likelier to be
accepted:

- **A concrete situation.** "I sell to customers in three states and have to file
  quarterly" beats "add better GST support".
- **How you handle it today.** Whatever you currently do in Tally, Excel or by hand tells
  us what the feature actually has to do.

Proposals requiring an always-on server, a subscription, or sending user data anywhere
are out of scope — see the design principles in the [README](./README.md).

## Contributing code

### Before you start

For anything beyond a small fix, **open an issue first** and agree on the approach. This
is not bureaucracy; the architecture has load-bearing constraints (a pure domain layer,
tax logic confined to `regimes/`, no stored balances) and it is unpleasant for everyone
when a finished PR turns out to violate one.

Issues labelled `good first issue` are scoped and safe to pick up directly.
[`docs/good-first-issues.md`](./docs/good-first-issues.md) lists the ones drawn from the
code as it stands, with the files and what "done" looks like for each.

### Setup

```bash
git clone https://github.com/abinauv/coffer.git
cd coffer
npm install
npm run dev
```

Node 22 LTS or newer. Nothing is compiled: both native modules are Node-API addons that
ship prebuilt binaries, so there is no rebuild step and no C++ toolchain requirement.
`postinstall` runs `scripts/native-modules.mjs`, which only checks that those binaries
load — it takes about a second.

**`npm install`, not `npm ci`.** `npm ci` reaches for `node-gyp` and fails asking for a
C++ compiler, to build a binary the package already contains. It is the first trap in
[`docs/getting-started.md`](./docs/getting-started.md) §6, and the fix is two lines.

If `npm run dev` builds cleanly and no window appears, read that same section before
debugging anything else. Two of the traps there produce exactly that.

### The loop

```bash
npm run verify              # typecheck + lint + format:check + test + test:scripts
npm test -- --watch         # while working
npm test -- --project=main  # or --project=renderer, to run one side only
npm run format              # prettier, writing in place
npm run mutate -- --defs <campaign>   # prove a test would have failed
```

Tests run as two projects: `main` (Node) and `renderer` (a real DOM, happy-dom). Which
one a file belongs to is decided by its directory, so there is nothing to declare. To
render a screen, use `renderScreen` from `src/renderer/src/test/harness.tsx` — see
[`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md) §6.

`verify` includes `format:check`, so run `npm run format` first if Prettier would reflow
anything you touched. Every script is listed in
[`docs/getting-started.md`](./docs/getting-started.md) §4.

### What a good PR looks like

- **One change.** Unrelated fixes go in separate PRs, however tempting.
- **Tests.** New logic needs tests. Anything touching money, tax or posting needs
  **golden fixtures** — if your change cannot break a test, it is not covered.
- **Evidence that the tests would fail.** For a rule you are claiming to enforce, break it
  once and check that something goes red. `npm run mutate` is the harness; a recorded
  campaign in `scripts/mutations/` is a run somebody else can repeat, which is the
  difference between evidence and a claim. Not required for every PR, and expected for
  anything that adds a constraint.
- **Green.** `npm run verify` passes.
- **No drive-by refactors.** Improvements you spotted elsewhere go in an issue.
- **Conventional commits**, scoped to the module:
  ```
  feat(ledger): add reversal entries
  fix(invoices): preserve custom UoM instead of coercing to Nos
  docs(architecture): clarify the regime adapter
  ```

### Sign your commits (DCO)

Coffer uses the [Developer Certificate of Origin](https://developercertificate.org/).
It is a one-line assertion that you wrote the contribution and may submit it under the
project's licence. There is no CLA and no copyright assignment.

```bash
git commit -s -m "fix(ledger): correct rounding on reversal"
```

`-s` appends `Signed-off-by: Your Name <your@email>`. Use your real name and a working
email. Set `git config user.name` and `user.email` once and it is automatic.

Unsigned commits will be asked to amend:

```bash
git rebase --signoff main
```

### Review

Every PR is reviewed by a maintainer. Expect questions about edge cases — particularly
rounding, period boundaries, and what happens on the last day of a financial year.
Correctness review is not distrust; it is the job.

## Things that will be rejected

Not to be discouraging, but to save you the work:

- **Floats for money.** Anywhere, at any layer, including JSON across IPC.
- **Tax logic outside `regimes/`.** The adapter is what makes non-India regimes possible.
- **Stored balances.** Any column caching a total the journal could contradict.
- **I/O inside `domain/`.** That layer stays pure.
- **Network calls in a core path.** Offline is the product.
- **Telemetry, analytics, or phone-home** of any kind, for any reason.
- **Editing a merged migration.** Fix it forward.
- **Generated code you have not read and cannot explain.** You are signing the DCO for
  it; you are responsible for it in review.

## Licence

Contributions are licensed under [AGPL-3.0-or-later](./LICENSE), the same as the project.
You keep copyright in your work; the DCO sign-off confirms you may contribute it.
