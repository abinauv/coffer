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

If you cannot use GitHub's private reporting, open a public issue containing **only** a
request for a private contact channel — no details of the vulnerability.

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

## Known gaps

Stated plainly rather than discovered later:

**Releases are not code-signed.** Certificates cost more than this project currently has.
Windows shows a SmartScreen warning and macOS quarantines the download. Every release
publishes SHA-256 checksums — verify them. This means a tampered build cannot be
detected by the OS, only by checking the checksum against the release page. Signing is
the first thing funded if the project finds an audience.

**No formal security audit** has been performed.

## For users

- **Your passphrase cannot be recovered.** It is not stored anywhere. If you lose both
  it and your recovery codes, your books are unrecoverable. That is the design.
- **Store recovery codes away from the machine holding the database.** Codes in a text
  file beside the file they protect defeat the purpose.
- **Back up regularly, and keep a copy off the machine.** Encryption protects against
  theft, not against a failed disk.
- **Verify the checksum** of any release you download, until signing is in place.

[`docs/security-for-users.md`](./docs/security-for-users.md) covers all four at length —
how to choose a passphrase, what recovery codes are and where to keep them, and the exact
commands for checking a SHA-256 on each platform.

## Supported versions

Pre-alpha: only the latest commit on `main` is supported. Once releases begin, this
section will state which versions receive security fixes.
