# Coffer documentation

Coffer is a local-first, double-entry ERP for small businesses. It runs on your own
machine, and one company's books are one encrypted file you own.

The project is **pre-alpha**. There is no release to download, and interfaces still move.

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
belongs, and the two traps that produce a successful build and a broken app.

**[Conventions](./CONVENTIONS.md)** — naming, types, storage representations, how to add
an IPC endpoint, how errors are shaped, and the seven rules that are not negotiable. Read
before writing code.

**[Architecture & stack](./ARCHITECTURE.md)** — what Coffer is, what it will never be,
the stack and why each piece was chosen, the process model, and the six load-bearing
decisions everything else follows from.

**[Good first issues](./good-first-issues.md)** — scoped starter tasks drawn from what is
actually in the code, each with the files involved and how to tell when it is done.

### For understanding the system

**[The data model, so far](./data-model.md)** — a company is an encrypted SQLite database
plus a sidecar vault. What the registry holds and what it must never hold, why there is
no `company_id` anywhere, how keys are wrapped, what a backup archive contains, and how
migrations work.

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
| [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) | How people are expected to behave here.                                          |
| [`CHANGELOG.md`](../CHANGELOG.md)             | What changed, with `[accounting]` marking anything that alters figures.          |

## What is not here yet

Coffer is at the end of Phase 0. The ledger, documents, inventory and return generation
are later phases, so there is no documentation for them — and none should be written
before the code is. `ARCHITECTURE.md` describes where they are heading.

If a document here disagrees with the code, the code is right and the document is a bug.
Please report it.
