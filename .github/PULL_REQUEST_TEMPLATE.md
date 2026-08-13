<!--
Thanks for contributing to Coffer.
Please open an issue first for anything beyond a small fix — see CONTRIBUTING.md.
-->

## What this changes

<!-- One or two sentences. What does this do, and why? -->

Closes #

## How it was tested

<!-- What did you run, and what did you check by hand? -->

## Checklist

- [ ] `npm run verify` passes (typecheck, lint, tests)
- [ ] New logic has tests
- [ ] Commits are signed off (`git commit -s`) — see [DCO](https://developercertificate.org/)
- [ ] This is one change; unrelated fixes are in separate PRs
- [ ] No files outside the scope of this change were modified

## If this touches money, tax, or the ledger

<!-- Delete this section if it does not apply. -->

- [ ] Golden fixtures added or updated
- [ ] No floats — decimals throughout, including across IPC
- [ ] Tax logic stays inside `regimes/`
- [ ] No stored balances introduced
- [ ] Rounding behaviour is unchanged, or the change is called out below

**Do figures on existing documents change as a result of this PR?**
<!-- If yes, explain exactly how. This decides whether it needs a migration and a
     changelog entry marked [accounting]. -->
