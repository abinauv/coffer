# Security, for people who use Coffer

> Choosing a passphrase, what recovery codes are, and how to check a download.
> This is the user-facing companion to [`SECURITY.md`](../SECURITY.md), which is about
> reporting vulnerabilities.
>
> Coffer is alpha and nothing has been released, so there is no download yet. §4 describes
> what to do when there is.

---

## 1. The one thing to understand first

**Nobody can recover your passphrase. Not you, not the maintainers, not anyone.**

Your books are encrypted with a key that only your passphrase — or one of your five
recovery codes — can unwrap. The passphrase is not stored anywhere, in any form, on your
machine or off it. There is no reset link, no support channel that can let you back in,
and no master key held by anyone.

If you lose your passphrase **and** all five recovery codes, your books are gone.
Permanently. That is not a limitation waiting to be fixed; it is the design, and it is
the reason Coffer can honestly say your financial records are yours alone.

This is a deliberate trade. An escrow key would make the promise false, and in an
open-source product nobody can verify that a maintainer is _not_ holding one. The only
credible version of that claim is the one the code makes impossible to break.

## 2. Choosing a passphrase

### Length beats cleverness

Four unrelated words you can actually remember beats eight scrambled characters you
cannot. `harbour-clarinet-gravel-onion` is stronger, and easier to type on a Monday
morning, than `Tr0ub4dor&3`.

That is not a slogan; it is what the arithmetic says. Adding a word multiplies the work
of guessing. Substituting `4` for `a` does not — every guessing program tries that
substitution first.

### What Coffer does when you type one

Coffer scores the passphrase as you type it — a rating from 0 to 4, a label, and one
sentence of advice. The score is **advisory and it never blocks you**. You can create a
company with a weak passphrase, and Coffer will warn you clearly and then let you.

That is on purpose. With no escrow and no reset, refusing you your own passphrase would
leave you with no fallback and nobody to appeal to. [`SECURITY.md`](../SECURITY.md)
treats accepting a weak passphrase _without warning_ as a vulnerability — the remedy is
the warning, not the refusal.

The meter is honest about a few things people get wrong:

- **Under 8 characters can never score above "Very weak"**, whatever alphabet you use.
- **Under 12 characters can never clear the warning**, for the same reason.
- **`Password123!` scores as `password`.** Case is folded, the usual `@`-for-`a`
  substitutions are undone, and the digits and punctuation people append when a form
  demands them are stripped before the comparison.
- **`qwerty`, `asdfgh`, `abcdef` and `aaaa` are recognised as runs.** Everything past the
  first two characters of a run is free to a guessing program, and the score reflects
  that.

The scale, in bits of estimated guessing difficulty:

| Score | Label       | Bits       |
| ----- | ----------- | ---------- |
| 0     | Very weak   | under 28   |
| 1     | Weak        | under 40   |
| 2     | Fair        | under 56   |
| 3     | Strong      | under 72   |
| 4     | Very strong | 72 or more |

The warning shows below "Strong".

### How it is protected

Your passphrase goes through Argon2id at 256 MiB of memory, 3 passes, 4 lanes. That is
about thirteen times the current OWASP floor, and it is why unlocking takes a noticeable
moment — around 120 ms on a 16-core desktop, and 0.4 to 0.8 seconds on a low-end two- or
four-core laptop.

That delay is the point. It is paid once, when you open a company, and it multiplies the
cost of every guess an attacker makes.

### Changing it later

You can change your passphrase whenever you like, and it is cheap: Coffer re-wraps one
small key slot. Your database is not re-encrypted, not rewritten, and not even opened.
All five recovery codes keep working, because they wrap the same underlying key.

A passphrase change cannot corrupt a single ledger row. That is the whole reason the
design has a separate database key at all.

You need a company open, and you need your current passphrase.

## 3. Recovery codes

When you create a company, Coffer generates **five recovery codes** and shows them once:

```
K7M2X-9PQR4-TVW3H-6BNJ8
```

Twenty characters in four groups of five. Each code is 100 bits of randomness from your
operating system's cryptographic generator — far beyond any possible search.

### They are shown once. There is no second chance to read them.

Coffer does not store the codes. What the vault keeps is a one-way function of each code,
plus your key wrapped under it. There is no path from anything on disk back to a
printable code — which is precisely why a lost code is lost for good, and precisely why
the promise in §1 is true.

Write them down before you close that screen.

### The alphabet is designed for handwriting

The codes use Crockford's Base32:

```
0 1 2 3 4 5 6 7 8 9 A B C D E F G H J K M N P Q R S T V W X Y Z
```

`I`, `L`, `O` and `U` are missing. The first three because they are indistinguishable
from `1`, `1` and `0` in handwriting; `U` because leaving it out keeps accidental words
out of a code.

When you type a code back in, Coffer repairs the obvious misreadings rather than
punishing them. A transcribed `O` becomes `0`; `I` or `L` become `1`. Hyphens, spaces and
lower case are all accepted and ignored. If you wrote down what you saw, you will get in.

### Each code works exactly once

Using a code destroys that slot's key material outright. A code found on paper afterwards
opens nothing — it works once because the ciphertext is gone, not because a flag says so.

Coffer can still tell a spent code apart from a code that was never yours, so you get
"that code has already been used" rather than a confusing "wrong code".

### What happens when you use one

1. You enter a recovery code instead of a passphrase.
2. Coffer spends the code and writes that to disk **before** it opens anything. A code
   that was accepted but not recorded would be a code that works twice.
3. You must set a new passphrase there and then. Recovery always establishes one — you
   have just proved you do not know the old one.
4. Your other four codes keep working.

Coffer deliberately does **not** issue a fresh set of five at that moment. Doing so would
invalidate the four codes on the sheet in your hand, at the one moment you have proved
you need it.

> **Currently missing:** there is no way to ask Coffer for a fresh set of recovery codes
> after using one. The capability exists inside the application but no screen or command
> reaches it yet. Until it lands, using a code leaves you with four, permanently. This is
> tracked in [`good-first-issues.md`](./good-first-issues.md).

### Where to keep them

- **Not on the machine holding the books.** Codes in a text file beside the file they
  protect defeat the entire purpose. Somebody who steals the laptop gets both.
- **On paper, somewhere you would keep a title deed.** A locked drawer at home, a safe, a
  bank locker.
- **Or in a password manager** — provided that password manager is not itself protected
  by the passphrase you are trying to recover.
- **Split them if it helps.** Five independent codes means you can keep two at the office
  and three at home. Any one of them opens the books.

## 4. Verifying a download

Coffer's builds are **not code-signed**. Certificates cost more than this project
currently has. Windows will show a SmartScreen warning and macOS will quarantine the
download.

The practical consequence: your operating system cannot tell you whether an installer was
tampered with. The published SHA-256 checksum is the only integrity signal these builds
have, so it is worth the thirty seconds.

Every release attaches a file called `SHA256SUMS.txt`, generated by CI from the exact
artefacts on the release page. Download it alongside the installer, put both in the same
folder, then:

**Linux**

```bash
sha256sum -c SHA256SUMS.txt
```

**macOS**

```bash
shasum -a 256 -c SHA256SUMS.txt
```

Both print `OK` beside each file they could verify:

```
Coffer-0.1.0-linux-x64.AppImage: OK
```

**Windows** — PowerShell has no `-c` equivalent, so compare by eye. Open
`SHA256SUMS.txt`, find the line for your file, and run:

```powershell
Get-FileHash -Algorithm SHA256 .\Coffer-0.1.0-windows-x64-setup.exe
```

or, in `cmd`:

```
certutil -hashfile Coffer-0.1.0-windows-x64-setup.exe SHA256
```

The hash is 64 hexadecimal characters. Compare the whole string, not the first few — and
note that `Get-FileHash` prints upper case while the checksum file is lower case. That
difference is not a mismatch.

**If they do not match, do not run the installer.** Download it again, and if it still
does not match, open an issue.

**And when they do match, you still have a dialog to get past.** Windows SmartScreen and
macOS Gatekeeper both assume you have not checked anything, and neither offers an obvious
way through. [The README](../README.md#getting-past-the-os-warning) names the buttons on
each platform. Do that step only after the checksum has matched: it is what removes the
warning, not what makes the file safe.

## 5. Backing up

Encryption protects your books from being read by someone who takes your laptop. It does
nothing at all about a disk that dies.

- **A Coffer backup is one archive holding both files** — the database and the keys that
  open it. Use the backup action; do not copy the `.coffer` file on its own. A database
  without its `.vault` file cannot be opened by anyone, including Coffer, including you.
- **Keep a copy off the machine.** A pen drive in a drawer, or a second disk. The archive
  is encrypted, so it is safe to store somewhere less private than the machine itself.
- **Test a restore occasionally.** A backup nobody has ever restored is a hypothesis.
  Restore into an empty folder — Coffer refuses to overwrite an existing company, because
  doing so would destroy the books already there.
- **Your recovery codes are not in the backup.** Nothing recoverable from the archive
  will get you in without the passphrase or a code. Store them separately, as in §3.

## 6. What Coffer does not protect you from

Stated plainly rather than discovered later.

- **A machine that is already compromised.** Coffer protects data at rest. It cannot
  defend against a keylogger already running as you, or malware reading your screen.
- **Someone sitting at an unlocked, running session** with a company open. Lock your
  screen.
- **A weak passphrase you chose despite the warning.** The warning is the mitigation
  available; see §2 for why.
- **A tampered installer, without the checksum check.** See §4.

Coffer has had **no formal security audit**. Nothing here has been reviewed by anyone
outside the project.

## 7. What Coffer never does

- No account, no sign-in, no server.
- No telemetry, no analytics, no crash reporting, no phone-home of any kind.
- No network request in any core function. Coffer works on a day the internet does not.
- No key held by anyone but you.

If you find any of these to be untrue, that is a security vulnerability — report it as
described in [`SECURITY.md`](../SECURITY.md).
