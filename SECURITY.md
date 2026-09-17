# Security Policy

Coffer holds financial records and the keys that protect them. Security reports are the
highest-priority issues this project receives.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Report it privately through GitHub:

1. Go to the **Security** tab of this repository
2. Click **Report a vulnerability**
3. Describe the issue, how to reproduce it, and what an attacker could achieve

This creates a private advisory visible only to maintainers.

If you cannot use GitHub's private reporting, e-mail
[abinauvselvaraj13@gmail.com](mailto:abinauvselvaraj13@gmail.com) with "Coffer security" in
the subject. Never put details of a vulnerability in a public issue.

### What to expect

|                        |                                                                    |
| ---------------------- | ------------------------------------------------------------------ |
| Acknowledgement        | Within 5 days                                                      |
| Initial assessment     | Within 14 days                                                     |
| Fix or mitigation plan | Communicated once assessed                                         |
| Credit                 | Offered in the advisory and changelog, unless you prefer otherwise |

Coffer is maintained by one person. These are honest targets, not an SLA. If something
is being actively exploited, say so prominently and it will be treated accordingly.

### Please do not

- Test against anyone else's data or installation
- Open a pull request that fixes a vulnerability before it is disclosed — the diff is
  the disclosure
- Publish details before a fix ships, unless we have gone quiet past the timelines above

## Scope

**In scope** — anything that could expose or corrupt a user's books:

- Bypassing the passphrase or unlock flow
- Weaknesses in key derivation, DEK wrapping, or database encryption
- Recovery-code generation or validation flaws
- Renderer escaping its sandbox, or reaching the filesystem or database directly
- Path traversal in backup, restore, import or export
- Code execution through a crafted import file, backup archive, or compliance pack
- Secrets written anywhere they should not be — logs, crash reports, plaintext on disk
- Any unrequested network transmission of user data
- **Silent corruption of financial data**, including a path that writes an unbalanced
  journal entry

That last one is unusual to see in a security policy. In accounting software, data that
is quietly wrong is as damaging as data that leaks — treat it as a security issue.

**Out of scope:**

- Attacks requiring an already-compromised machine or OS account. Coffer protects data
  at rest; it cannot defend against a keylogger already running as the user.
- Physical access to an unlocked, running session
- Weak passphrases chosen by the user, though _allowing_ one without warning is in scope
- Missing code signing — a known, documented gap; see below
- Dependency advisories with no demonstrated path to exploitation in Coffer. Report
  those as normal issues.

### Already refused, so please check first

These are the ones most likely to be reported twice. Each is a property of what is **not
implemented** rather than a limit somebody tuned, so the way to lose one is to add a
feature — which is exactly the kind of change worth a report.

- **A `<!DOCTYPE` in an imported XML file is refused by name**, with a line and a column,
  never skipped. That is where both XXE and billion-laughs arrive. Nothing in the reader
  resolves a SYSTEM or PUBLIC identifier, so there is no code path that opens a file or a
  URL; and no document can declare an entity, so the only entities that expand are the
  five XML defines, each to exactly one character from a constant. A lower-case
  `<!doctype` is refused too.
- **The CSV and XML readers cap what a file can allocate** — rows, fields, field length,
  element count, nesting depth, text length, attributes per element — and exceeding one is
  a refusal with a line number. The caps are _defaults_, and a caller may raise or disable
  them, so a report that a caller passes bad options is a real report.
- **A backup archive's entry names are rejected at parse time** if they contain a
  separator, a drive letter or a leading dot. There is no option to allow them.
- **Neither reader touches the filesystem.** The caller supplies the text and owns the
  file dialog. Neither imports `electron`, reads a clock, or writes anything.

## Known gaps

Stated plainly rather than discovered later:

**Releases are not code-signed.** Certificates cost more than this project currently has.
Windows shows a SmartScreen warning and macOS quarantines the download. Every release
publishes SHA-256 checksums and a signed build-provenance attestation for every file —
verify them. This means a tampered build cannot be detected by the OS, only by checking
the checksum and the attestation. Signing is the first thing funded if the project finds
an audience.

The release workflow generates `SHA256SUMS.txt` from the artefacts actually attached,
attests every one of those files with `actions/attest` (SLSA build provenance, signed
through Sigstore with the run's own OIDC token) before anything is published, and puts
both verification commands in the release notes. The attestation is not a substitute for
signing: the operating system does not read it. The workflow also sets
`CSC_IDENTITY_AUTO_DISCOVERY: false` so a signing identity in a runner keychain cannot be
picked up by accident. **No release has been cut yet**, so there is nothing on a downloads
page to verify; when there is, [the README](./README.md#install) is where the commands
live.

**Workflow actions are pinned to tags, not commit SHAs.** `actions/checkout@v7` and the
rest are mutable references: whoever can move that tag runs their code inside the
workflow, holding the workflow's token — the same class of foothold as a compromised
dependency, with none of a lockfile's protection. It matters most in `release.yml`, which
holds `contents: write` and puts binaries on a download page. All three workflows carry
the note and the exact list of references to pin; it is undone because the SHAs have to be
read off the upstream repositories and an invented one breaks every run at once.

**There is no CSV or spreadsheet writer, so formula injection is not handled.** The
importers only read. A cell beginning `=`, `+`, `-` or `@` is treated as text, because
nothing here ever writes one back out for a spreadsheet to evaluate. Stated because it is
a requirement on any future export path rather than a property of the current one: the
day Coffer writes a `.csv` or a `.xlsx`, neutralising those is part of the work.

**`services/` is not reachable from the app.** The PDF renderer and all four importers are
pure library code with no IPC group behind them and no caller outside `services/`. Their
hardening is real and tested; none of it has yet been exercised through a handler that
supplies options and a file the user chose. That handler is where the next review should
look.

**There is no separate activity log.** The ledger is the audit trail — journal entries and
stock movements are append-only, enforced by triggers, and a correction is a reversal. A
record of non-posting actions (who archived a party, who reopened a period) does not
exist.

**No formal security audit** has been performed.

## For users

- **Your passphrase cannot be recovered.** It is not stored anywhere. If you lose both
  it and your recovery codes, your books are unrecoverable. That is the design.
- **Store recovery codes away from the machine holding the database.** Codes in a text
  file beside the file they protect defeat the purpose.
- **Back up regularly, and keep a copy off the machine.** Encryption protects against
  theft, not against a failed disk.
- **Verify the checksum** of any release you download, until signing is in place. Your
  operating system cannot do it for you on an unsigned build, and it will say so in a
  dialog that gives you no other information.

[`docs/security-for-users.md`](./docs/security-for-users.md) covers all four at length —
how to choose a passphrase, what recovery codes are and where to keep them, and the exact
commands for checking a SHA-256 on each platform. [The README](./README.md#install) has
the other half: what Windows SmartScreen and macOS Gatekeeper will show you, and which
buttons get you past them once the checksum matches.

## Supported versions

Alpha, and nothing has been released: only the latest commit on `main` is supported. Once
releases begin, this section will state which versions receive security fixes.
