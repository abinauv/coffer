<div align="center">

# Coffer

**Your books, in your own safe.**

A local-first, double-entry ERP for small businesses — invoicing, purchases,
inventory, a real general ledger, and India GST compliance. It runs entirely on your
own machine, in one encrypted file you own.

[![Licence: AGPL v3](https://img.shields.io/badge/licence-AGPL--3.0-0F6B58.svg)](./LICENSE)
[![Status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-8A5518.svg)](#status)

</div>

---

## Status

**Pre-alpha — under active construction. Not yet usable.** There is no release to
download. The first public alpha is planned for the end of Phase 2; see
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for where the project is heading.

Stars and issues are welcome. Pull requests are welcome once the alpha lands and the
interfaces stop moving.

## Why this exists

Small businesses have two options for keeping their books, and neither fits a
one-person company:

**Desktop accounting software** is expensive, proprietary, and mostly Windows-only.
**Cloud accounting** means your financial records sit on someone else's machine,
behind a subscription that can lapse, an account that can be locked, and an internet
connection you might not have.

Open-source ERPs exist, and they are good — but they are _servers_. Running one means
Docker, a database, a message queue, a VPS, and someone to keep it all alive. A
two-person consultancy cannot do that and should never have to.

Coffer is not a server. **It is a file.** You install an app; your books are one
encrypted database on your own disk. One click writes a backup you can copy to a pen
drive.
No account, no subscription, no vendor who can lock you out, and it works on a day the
internet doesn't.

## What it will do

|                        |                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Real books**         | Double-entry general ledger, chart of accounts, trial balance, P&L, balance sheet, cash flow — not a billing app with reports bolted on. |
| **Sell**               | Quotations → invoices → receipts, with GST computed correctly and PDFs that look professional.                                           |
| **Buy**                | Vendor bills, debit notes, expenses, payments, and input-tax-credit tracking.                                                            |
| **Stock**              | Perpetual inventory with moving-average valuation that reconciles to the balance sheet.                                                  |
| **Comply**             | GSTR-1, GSTR-3B, GSTR-2B reconciliation, e-invoice and e-way bill payloads — generated offline, ready to upload.                         |
| **Several businesses** | Each company is its own encrypted file. Run three firms, or a hundred clients, from one install.                                         |
| **Leave**              | Your data is in SQLite. Export it, read it with any tool, take it elsewhere. No lock-in is a feature, not an oversight.                  |

## Design principles

1. **Offline is the default, not the fallback.** No core function may require a network.
2. **The file is yours.** Standard SQLite, documented schema, exportable at any time.
3. **Correctness over speed.** Money is arbitrary-precision decimal everywhere. Balances
   are always derived from the journal, never cached into a column that can drift.
4. **No surprises.** No telemetry, no account, no phone-home, no upsell.

## Building from source

Releases will arrive with the alpha. Until then:

```bash
git clone https://github.com/abinauv/coffer.git
cd coffer
npm install
npm run dev
```

Requires Node 22 LTS or newer. Nothing is compiled — both native modules ship prebuilt
binaries — so no C++ toolchain is needed. Builds target Windows, macOS and Linux.

[`docs/getting-started.md`](./docs/getting-started.md) covers every script, how the
three-process build fits together, and what to check if the build succeeds and no window
appears.

> **On unsigned builds.** Coffer is not yet code-signed — certificates cost more than
> this project currently has. Windows will show a SmartScreen warning and macOS will
> quarantine the download. Every release publishes SHA-256 checksums so you can verify
> what you downloaded. If the project finds an audience, signing is the first thing the
> money goes to.

## Documentation

[`docs/`](./docs/README.md) is the index. The short version:

- [Getting started](./docs/getting-started.md) — clone to a running window, and what each
  script does
- [Architecture & stack](./docs/ARCHITECTURE.md) — how it is built and why
- [Conventions](./docs/CONVENTIONS.md) — read before contributing
- [The data model](./docs/data-model.md) — what a company is on disk, and how migrations
  work
- [Adding a tax regime](./docs/adding-a-tax-regime.md) — the internationalisation seam
- [Security for users](./docs/security-for-users.md) — passphrases, recovery codes,
  verifying a download
- [Good first issues](./docs/good-first-issues.md) — scoped starter tasks

## Licence

[AGPL-3.0-or-later](./LICENSE). You may use, modify and redistribute Coffer freely.
If you run a modified version as a network service, you must publish your changes.

Contributions are accepted under the [Developer Certificate of
Origin](https://developercertificate.org/) — sign off your commits with `git commit -s`.
