# Coffer documentation

Coffer is a local-first, double-entry ERP for small businesses. It runs on your own
machine, and one company's books are one encrypted file you own.

The project is **alpha**. The ledger, the documents, the vouchers and the stock register
are built and tested; nothing has been released yet, and interfaces still move.

---

## Start here

| If you are…                                                                          | Read                                                                          |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **using Coffer** and choosing a passphrase, or wondering what happens if you lose it | [Security, for people who use Coffer](./security-for-users.md)                |
| **about to contribute code**                                                         | [Getting started](./getting-started.md), then [Conventions](./CONVENTIONS.md) |
| **wondering why it is built this way**                                               | [Architecture & stack](./ARCHITECTURE.md)                                     |
| **looking for something to work on**                                                 | [Good first issues](./good-first-issues.md)                                   |

## Everything, by subject

### For contributors

**[Getting started](./getting-started.md)** — clone to a running window. What every
`npm` script does, how the main/preload/renderer build fits together, where a new feature
belongs, and the four traps — starting with the one that makes `npm ci` demand a C++
compiler for a binary it already has.

**[Conventions](./CONVENTIONS.md)** — naming, types, storage representations, how to add
an IPC endpoint, how errors are shaped, and the seven rules that are not negotiable. Read
before writing code.

**[Architecture & stack](./ARCHITECTURE.md)** — what Coffer is, what it will never be,
the stack and why each piece was chosen, the process model, and the six load-bearing
decisions everything else follows from.

**[Good first issues](./good-first-issues.md)** — scoped starter tasks drawn from what is
actually in the code, each with the files involved and how to tell when it is done.

**[Brand, UI and the design system](./design.md)** — what is a placeholder and what is
decided, where every visual decision lives, and the rules a redesign has to keep: money
the renderer never computes, colour that never carries meaning alone, and nothing loaded
from the internet.

### For understanding the system

**[The data model, so far](./data-model.md)** — a company is an encrypted SQLite database
plus a sidecar vault. What the registry holds and what it must never hold, why there is
no `company_id` anywhere, how keys are wrapped, what a backup archive contains, all
twenty-two migrations and the twenty tables they produce, and six things SQLite does that
its documentation does not lead you to expect.

**[Adding a tax regime](./adding-a-tax-regime.md)** — the `TaxRegime` interface as the
internationalisation seam. Every member a new regime must implement, what ESLint enforces,
and what must never leak out of `regimes/`.

### For users

**[Security, for people who use Coffer](./security-for-users.md)** — choosing a
passphrase, what recovery codes are and where to keep them, the plain fact that losing
your passphrase and all five codes means the books are gone, and how to verify a
download's SHA-256 while builds are unsigned.

## In the repository root

|                                               |                                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| [`README.md`](../README.md)                   | What Coffer is and why it exists.                                                |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md)       | How to report a bug, propose a feature, and what a good pull request looks like. |
| [`SECURITY.md`](../SECURITY.md)               | Reporting a vulnerability, what is in scope, and the known gaps.                 |
| [`SUPPORT.md`](../SUPPORT.md)                 | Where to ask a question, report a bug, or suggest an idea.                       |
| [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) | How people are expected to behave here.                                          |
| [`CHANGELOG.md`](../CHANGELOG.md)             | What changed, with `[accounting]` marking anything that alters figures.          |

## What is not here yet

Documentation is written after the code, never before it, so a gap here is usually a gap
there. Four in particular are worth knowing about before you go looking:

- **No document on the stock register of its own.** What exists is in
  [`data-model.md`](./data-model.md) and in `src/main/domain/inventory/types.ts`, whose
  seven invariants are the contract.
- **No document on generating a return.** `regimes/in-gst/returns/` builds GSTR-1 and
  GSTR-3B, and every artefact it produces carries a `SCHEMA_UNVERIFIED` notice saying the
  arithmetic is pinned and the shape has never been through a filing cycle. Writing a
  user-facing page about it before that is true would be the mistake the notice exists to
  prevent.
- **No document on printing or importing.** Printing is reachable — a document prints or
  saves a PDF from its editor and from the register — and no page here describes it; the
  screens name their own steps. The readers in `services/importers/{csv,xml,zoho,tally}/`
  are built and tested with no IPC group behind them, so there is nothing a user can be
  told to do with those at all.
- **No release notes of their own.** [`CHANGELOG.md`](../CHANGELOG.md) is where they are:
  its `[0.1.0]` section is the first alpha's.

If a document here disagrees with the code, the code is right and the document is a bug.
Please report it.
