# Brand, UI and the design system

> What is a placeholder and what is decided, where every visual decision lives in the
> code, and the rules a redesign has to keep. Read this before changing how Coffer looks.

---

## 1. What is decided, and what is a placeholder

| Decided                                                                                                                                | Placeholder, waiting for real design                                          |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| The name, **Coffer** — a strongbox, because the books are encrypted at rest                                                            | README screenshots — the README carries a comment marking where they go       |
| The tagline, _Your books, in your own safe._                                                                                           | Installer artwork: the NSIS sidebar image and the macOS disk-image background |
| The audience (§2)                                                                                                                      |                                                                               |
| **Mark:** a square recessed into a square — a coffered ceiling panel, a strongbox lid and a ruled ledger cell at once. Rectangles only |                                                                               |
| **Wordmark:** the name in IBM Plex Serif SemiBold beside the mark. A serif on the name and a sans in the interface                     |                                                                               |
| **App icon:** the mark reversed white on Lapis, one flat 1024 × 1024 square with 12% padding, no platform mask                         |                                                                               |
| **README banner** (1280 × 320) and **GitHub social preview** (1280 × 640, dark), rendered from the bundled fonts                       |                                                                               |
| Colour: **Paper** (light) and **Slate** (dark), accent **Lapis**. Measured, not asserted — see the header of `tokens.css`              |                                                                               |
| Type: **IBM Plex** Sans, Serif and Mono, bundled under SIL OFL 1.1, with the Devanagari cut alongside                                  |                                                                               |
| The layout model: a sidebar, a title bar with a command palette, and one screen at a time                                              |                                                                               |

## 2. Who it is designed for

- **The owner or bookkeeper of a small Indian business** — a trader, distributor,
  manufacturer or service firm — entering invoices, bills and receipts every day. Often on
  a mid-range Windows laptop, often with Tally or a spreadsheet as the point of comparison.
- **An accountant or CA** keeping several clients' books, one company file each, switching
  between them.
- **Later, small businesses elsewhere.** Nothing visual may assume India: number grouping,
  the currency word, the financial year and tax labels all come from the tax regime.

What follows from that: long sessions of keyboard-heavy data entry, figures that must be
read correctly at a glance, and people who are trusting the app with records they are
legally required to keep. Calm and exact beats lively.

## 3. Where everything lives

| What                                   | Where                                                                                                                                                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name, tagline, description             | `src/branding.ts` is the source of truth. `electron-builder.yml` repeats the values by hand, because YAML cannot import it: change both                                                                                                        |
| The mark                               | `src/shared/brand-mark.ts` holds its construction and small-size rules. Drawn by `components/shell/BrandMark.tsx` and, with the name, `Wordmark.tsx`                                                                                           |
| App icon                               | `build/icon.png`, 1024 × 1024, committed. Drawn from the mark by `scripts/generate-icon.mjs` (`npm run icon`): rerun it and commit the result after changing the mark or the accent. electron-builder derives every platform's icon from it    |
| README banner, social preview          | `scripts/render-brand-assets.mjs` (`npm run brand:assets`). The banner is committed at `docs/assets/banner.png`; the social preview goes to `dist/brand/` and is uploaded by hand in the repository settings                                   |
| Colour, type, spacing, radius, density | `src/renderer/src/styles/tokens.css`, with the palette's reasoning and its measurements in the header                                                                                                                                          |
| Fonts                                  | `src/renderer/src/assets/fonts/` as local woff2, declared with `@font-face` in `styles/base.css`. Versions, checksums and the OFL notice are in `THIRD-PARTY.md`                                                                               |
| Element defaults                       | `src/renderer/src/styles/base.css`                                                                                                                                                                                                             |
| Component styles                       | `styles/atoms.css` (buttons, inputs, badges…), `styles/shell.css` (title bar, sidebar), `screens/screens.css` (screen layouts)                                                                                                                 |
| Components                             | `src/renderer/src/components/` — `atoms/`, `shell/`, `command-palette/`, `toast/`                                                                                                                                                              |
| Icons                                  | `src/renderer/src/lib/icons.ts` — 24 × 24 stroke paths drawn by `components/atoms/Icon.tsx`. No icon library                                                                                                                                   |
| Screens                                | `src/renderer/src/screens/welcome/` (create, pick, unlock, recover a company) and `screens/workspace/` (everything inside an open company)                                                                                                     |
| Screen building blocks                 | `src/renderer/src/screens/components/` — frames, notices, the passphrase field and strength meter, report lines, `MoneyField`, and the three states every screen ships besides its full one: `EmptyState`, `RegisterSkeleton` and `ErrorState` |
| Density preference                     | `lib/density.ts` decides, `store/density.tsx` wires it: the `data-density` attribute on `<html>`, stored as `coffer.density`. Chosen from the command palette until Settings exists                                                            |

## 4. Rules a redesign must keep

These are enforced by code, tests or the security model. A visual change that breaks one
is a bug, however it looks.

**Money**

- **The renderer never computes money.** Every figure on a screen was calculated in the
  main process. The document editor shows the last saved totals marked as stale rather
  than adding up lines as you type; a design that wants a live running total needs a
  round trip to main, not arithmetic in a component.
- **A register has no page total.** A sum across one page of rows changes when you press
  Next and means nothing either way.
- **Negative money is never shown by colour alone.** It carries a sign, and
  `--figure-negative` is deliberately the darkest, heaviest figure colour.
- **Number grouping comes from the regime.** India groups `1,00,000`; other regimes group
  `100,000`. Never hardcode either.
- **Figures use tabular numerals** (`--numeric-figures`) so columns of money line up, and
  identifiers additionally use a slashed zero (`--numeric-identifier`) because they are
  read aloud down a phone line and retyped.

**The mark**

- **One construction, drawn in one place.** The title bar, the packaging icon and the
  launch images all read `src/shared/brand-mark.ts`; a copy of the shape anywhere else is
  a copy that drifts. Its tests pin the construction.
- **Never below 16px.** Below 20px the inner frame is drawn solid and the outer frame is
  held at two device pixels, because a 2px hole closes up when rasterised. `BrandMark`
  enforces both.
- **One colour:** Lapis, or its lighter step on Slate, or white reversed on Lapis. Never the
  positive teal, never a gradient, never rotated, and no keyhole, coin, rupee sign or
  padlock added. Encryption is in the copy, not the mark.
- **The serif is for the name.** Plex Serif appears in the wordmark and nowhere else in
  the working interface.

**Colour and contrast**

- **No raw colours in components.** Every colour is a token. If one is missing, add a token.
  The one exception is the recovery-sheet print style, which prints black on white whatever
  the screen theme, and says so where it does it.
- **Every token is defined on bare `:root` first**, and dark mode only redefines existing
  names. A token that exists only inside a dark block vanishes in light mode.
- **Positive is teal, not green, and the accent is Lapis, not green**, so that positive,
  negative and warning stay distinguishable under protanopia, deuteranopia and tritanopia.
  The header of `tokens.css` has the measurements — worst case dE76 23.7 light, 30.6 dark.
  **Re-measure if any of accent, positive, negative or warning changes.**
- **Text meets WCAG AA (4.5:1)** on every surface it is used on — not merely on white.
  `--rule-strong` and the four state fills meet 3:1 for non-text; `--rule` is a decorative
  hairline and must never be the only thing identifying a control.
- **`--rule-strong` is for the edges of controls.** Table headers, totals, separators and
  empty-state outlines use `--rule-total`, which is lighter; the strong rule on a table
  outweighs the figures in it.
- **Three themes are a real choice**: follow the system, light, or dark. Light is warm
  "paper"; dark is a cool "slate", not an inversion.

**Density**

- **Density is four numbers.** `--control-height`, `--row-height`, the row padding pair and
  `--screen-pad`. Controls, table rows and the workspace frame read them; nothing else
  moves. Compact is chosen from the command palette ("Density: compact") until Settings
  exists.
- **Compact removes padding, never legibility.** No control or row below `--hit-min`
  (24px) in either density, and Compact touches no type token. `styles/tokens.test.ts`
  reads the stylesheet and fails if either slips.

**Components and states**

- **One home per class.** An atom's classes are styled in `styles/atoms.css` and a utility's
  in `styles/base.css`, and no later stylesheet redefines them. A second copy in
  `screens.css` once won everywhere because it loads last, and bent every field on every
  screen.
- **A disabled control is drawn, not faded,** and a field that is disabled says why in place
  of its hint (`disabledReason`).
- **Busy keeps the label.** Work that can fail swaps the button's icon for a spinner and
  keeps its words; it never becomes "Loading".
- **Every badge carries a word,** and the tones mean one thing each: positive is money that
  went the right way (Paid), warning is part of the way (Part paid), negative is late
  (Overdue), the accent is an issued document, and a cancelled one is struck through rather
  than coloured. A register's settlement state comes worked out from main
  (`DocumentListRow.settlement`); the screen only names it.
- **Four notice tones, never more:** info, positive, warning, danger.
- **An error leads with "!",** so it is not told from a hint by red alone.
- **Identifiers are set in mono with a slashed zero** (`isIdentifier`). **Money is typed into
  a `MoneyField`,** which takes the currency symbol from the regime and hands back exactly
  what was typed — it never groups, rounds or parses.
- **Every screen ships an empty, a loading and an error state,** and a register loads as a
  skeleton at its real column widths, never behind a spinner.

**Language**

- **Leading is set for the tallest script the build ships**, not for English. That is why
  `--leading-snug` is 1.4 rather than 1.35.
- **List only fonts that ship.** Plex has no Tamil cut, so Tamil text uses the operating
  system's Tamil face. A family named in `--font-sans` and not bundled falls through to
  whatever the OS has, silently.
- **Dates the app writes read `31 Mar 2026`. Dates typed into a field use the platform's own
  date picker,** which shows the operating system's format (`dd-mm-yyyy` on an Indian
  Windows). That is a deliberate exception rather than an oversight: the native picker keeps
  keyboard entry, the OS calendar and the user's own locale, and a hand-built date field
  that drew the regime's format would have to rebuild all three.

**Platform and security**

- **Nothing loads from the internet.** The Content Security Policy in
  `src/renderer/index.html` forbids remote origins. The fonts are bundled local woff2 under
  the OFL, and the icon set stays inline path data.
- **The recovery-codes screen has no Back, no Skip and no Escape.** The company is already
  created, and the codes are shown exactly once.
- **Unlock failures are four different screens**, not one "wrong passphrase" message: an
  invalid passphrase, a missing database, a missing vault, and keys that belong to a
  different file.

**Tests**

- **Screen tests find elements by role and accessible name**, the way a screen reader
  would (`@testing-library/react`). Renaming a button or a heading's text changes what a
  test looks for; that is intended, and `npm test` will say which ones.

## 5. Known gaps in the interface

Worth designing for, because each already has working code behind it and no screen in
front of it:

- **Printing.** An invoice print model and HTML template exist in `src/main/services/pdf/`,
  but no screen offers a print or PDF button.
- **Importing.** Readers for Tally XML, Zoho Books CSV and bank-statement CSV exist in
  `src/main/services/importers/`, with no screen in front of them.
- **GST returns.** GSTR-1 and GSTR-3B are generated but provisional, and have no screen.
- **New recovery codes.** After a code is used there is no way to issue a fresh set
  ([`security-for-users.md`](./security-for-users.md) §3).

## 6. Checking a change

```bash
npm run dev       # the app, with hot reload for renderer changes
npm run verify    # typecheck, lint, formatting and every test
```

Look at every changed screen in both light and dark, with a company open and with an empty
one, and at a narrow window as well as a wide one.
