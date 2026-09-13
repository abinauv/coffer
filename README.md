<div align="center">

# Coffer

**Your books, in your own safe.**

A local-first, double-entry ERP for small businesses — invoicing, purchases,
inventory, a real general ledger, and India GST compliance. It runs entirely on your
own machine, in one encrypted file you own.

[![CI](https://github.com/abinauv/coffer/actions/workflows/ci.yml/badge.svg)](https://github.com/abinauv/coffer/actions/workflows/ci.yml)
[![Licence: AGPL v3](https://img.shields.io/badge/licence-AGPL--3.0-0F6B58.svg)](./LICENSE)
[![Status: alpha](https://img.shields.io/badge/status-alpha-8A5518.svg)](#status)

</div>

---

## Status

**Alpha. There is no download yet.** The books work — you can create a company, keep a
chart of accounts, raise and issue documents, record what has been paid, run the
statements, and keep a stock register that reconciles with the balance sheet. What has not
happened is a release: no version has been tagged, so there is nothing on the releases
page to install. [Install](#install) says where it will appear and what to do with it when
it does.

Interfaces still move. Issues and design feedback are welcome; so are pull requests
against anything on
[`docs/good-first-issues.md`](./docs/good-first-issues.md), which is drawn from notes the
code leaves about itself.

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

## What it does today

|                        |                                                                                                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Real books**         | Double-entry general ledger, a chart of accounts you can renumber, fiscal periods that close and lock, opening balances, reversals and a year-end close. Trial balance, balance sheet, profit and loss, day book, account ledger. |
| **Sell**               | Quotations, sales invoices and credit notes, with GST computed by the regime and frozen onto the document at issue.                                                                                                               |
| **Buy**                | Purchase bills and debit notes, with input-tax-credit eligibility recorded per line — because one bill can carry a laptop and a staff car.                                                                                        |
| **Get paid**           | Receipts, payments and refunds both ways, allocated against the documents they settle; credit notes set off against invoices. Aged receivables and payables that cannot disagree with the balance sheet.                          |
| **Stock**              | A perpetual register per item and warehouse, valued at moving weighted average, where every movement that moved money also posts — so inventory on the balance sheet ties to the register, as at every date.                      |
| **Several businesses** | Each company is its own encrypted file. Run three firms, or a hundred clients, from one install.                                                                                                                                  |
| **Leave**              | Your data is in SQLite. Any SQLCipher-capable tool opens it given the key. No lock-in is a feature, not an oversight.                                                                                                             |

**And what it does not do yet**, because a landing page that lists plans as features is
the thing this project is trying not to be:

- **No printing.** The invoice renderer is written and tested; nothing in the app reaches
  it, so there is no PDF button.
- **No importing.** Readers for CSV bank statements, Zoho Books exports and Tally XML are
  written and tested, and are likewise not wired to a screen.
- **No filed returns.** GSTR-1 and GSTR-3B are built from your documents and the
  arithmetic is pinned to the paisa — but the _shape_ has never been checked against the
  portal's published schema or been through a filing cycle, so every artefact says so on
  its own face. GSTR-2B reconciliation, e-invoice and e-way bill payloads are not written.
- **No e-mail, no auto-update, no telemetry.** The last of those is permanent.

## Design principles

1. **Offline is the default, not the fallback.** No core function may require a network.
2. **The file is yours.** Standard SQLite, documented schema, exportable at any time.
3. **Correctness over speed.** Money is arbitrary-precision decimal everywhere. Balances
   are always derived from the journal, never cached into a column that can drift.
4. **No surprises.** No telemetry, no account, no phone-home, no upsell.

## Install

**Nothing has been released yet.** When it is, tagged releases will appear at
**[github.com/abinauv/coffer/releases](https://github.com/abinauv/coffer/releases)**,
built by CI on all three platforms:

| Platform            | File                                             |
| ------------------- | ------------------------------------------------ |
| Windows x64         | `Coffer-<version>-windows-x64-setup.exe`         |
| macOS Apple silicon | `Coffer-<version>-macos-arm64.dmg`               |
| macOS Intel         | `Coffer-<version>-macos-x64.dmg`                 |
| Linux x64           | `Coffer-<version>-linux-x64.AppImage` and `.deb` |

Alongside them, a file called `SHA256SUMS.txt`. Please use it — see below for why it is
not optional here.

### Verify what you downloaded

Coffer's builds are **not code-signed**, so your operating system cannot tell you whether
an installer was tampered with. The published checksum is the only integrity signal these
builds have. Download `SHA256SUMS.txt` into the same folder as the installer, then:

```bash
sha256sum -c SHA256SUMS.txt        # Linux
shasum -a 256 -c SHA256SUMS.txt    # macOS
```

Each prints `OK` beside the file it checked.

Windows has no `-c` equivalent, so compare by eye. Open `SHA256SUMS.txt`, find the line
for your file, and run:

```powershell
Get-FileHash -Algorithm SHA256 .\Coffer-0.1.0-windows-x64-setup.exe
```

Compare the whole 64-character string, not the first few. `Get-FileHash` prints upper case
and the checksum file is lower case; that difference is not a mismatch.

**If they do not match, do not run the installer.** Download it again, and if it still
does not match, open an issue.

### Getting past the OS warning

Once the checksum matches, you still have to get past a dialog that assumes you have not
checked. This is the part nobody tells you, so here it is in full.

**Windows — SmartScreen.** Running the installer shows a blue box saying
_"Windows protected your PC"_ with only a **Don't run** button visible. Click **More
info** — a line appears naming the app and the publisher as unknown — then **Run anyway**.
If that link does not appear, Windows has flagged the file as coming from the internet:
right-click the `.exe`, choose **Properties**, tick **Unblock** at the bottom of the
General tab, apply, and run it again.

**macOS — Gatekeeper.** The `.dmg` mounts, and double-clicking the app inside gives
_"Coffer cannot be opened because the developer cannot be verified"_ with only **Move to
Bin** offered. Do not move it to the bin. Drag the app to Applications first, then:

- **Control-click** (or right-click) the app in Applications and choose **Open**. The same
  warning appears with an **Open** button on it this time. Once is enough — macOS
  remembers.
- On recent macOS versions that button has been removed from the Control-click menu. Try
  to open the app normally, then go to **System Settings → Privacy & Security**, scroll to
  the Security section, and click **Open Anyway** beside the message naming Coffer.

If you would rather do it from a terminal, this removes the download flag directly:

```bash
xattr -d com.apple.quarantine /Applications/Coffer.app
```

Only run that on a file whose checksum you have already verified. It is the step that
removes the warning, not the step that makes the file safe.

**Linux.** No prompt to get past.

```bash
chmod +x Coffer-*.AppImage && ./Coffer-*.AppImage   # or
sudo apt install ./Coffer-*.deb
```

Signing is the first thing this project spends money on if it finds an audience, and it
will make all of the above unnecessary. Until then, the checksum is the check that
matters and the dialog is only a dialog.

## Building from source

```bash
git clone https://github.com/abinauv/coffer.git
cd coffer
npm install
npm run dev
```

Requires Node 22 LTS or newer. Nothing is compiled — both native modules ship prebuilt
Node-API binaries — so no C++ toolchain is needed.

**Use `npm install`, not `npm ci`.** `npm ci` tries to build one of those native modules
from source and fails asking for a compiler, for a binary that is already inside the
package. [`docs/getting-started.md`](./docs/getting-started.md) §6 has the two-line fix,
along with the other three traps that produce a successful build and a broken app.

## Documentation

[`docs/`](./docs/README.md) is the index. The short version:

- [Getting started](./docs/getting-started.md) — clone to a running window, every script,
  and the four traps
- [Architecture & stack](./docs/ARCHITECTURE.md) — how it is built and why
- [Conventions](./docs/CONVENTIONS.md) — read before contributing
- [The data model](./docs/data-model.md) — what a company is on disk, the twenty-two
  migrations, and how they are written
- [Adding a tax regime](./docs/adding-a-tax-regime.md) — the internationalisation seam
- [Security for users](./docs/security-for-users.md) — passphrases, recovery codes,
  verifying a download
- [Good first issues](./docs/good-first-issues.md) — scoped starter tasks

## Licence

[AGPL-3.0-or-later](./LICENSE). You may use, modify and redistribute Coffer freely.
If you run a modified version as a network service, you must publish your changes.

Contributions are accepted under the [Developer Certificate of
Origin](https://developercertificate.org/) — sign off your commits with `git commit -s`.
