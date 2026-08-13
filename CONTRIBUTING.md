# Contributing to Coffer

Thank you for considering it. Coffer is accounting software — people will trust it with
records they are legally required to keep and cannot afford to lose. That shapes how we
work: slower than most projects, with more tests, and a strong bias toward correctness
over features.

Please read this alongside [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md), which covers
naming, types and the rules that are not negotiable.

---

## Project status

Coffer is **pre-alpha**. Interfaces move weekly and the schema is not yet stable.

Until the first alpha lands, the most useful contributions are **issues, questions and
design feedback** rather than pull requests — a PR against a module that gets restructured
next week helps nobody. Once interfaces settle, this section will say so.

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

### Setup

```bash
git clone https://github.com/<owner>/coffer.git
cd coffer
npm install
npm run dev
```

Node 22 LTS or newer. On first install, native modules are rebuilt for Electron — this
takes a few minutes and needs no compiler, since prebuilt binaries are used.

### The loop

```bash
npm run verify      # typecheck + lint + test — must pass before you push
npm test -- --watch # while working
npm run format      # prettier
```

### What a good PR looks like

- **One change.** Unrelated fixes go in separate PRs, however tempting.
- **Tests.** New logic needs tests. Anything touching money, tax or posting needs
  **golden fixtures** — if your change cannot break a test, it is not covered.
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
