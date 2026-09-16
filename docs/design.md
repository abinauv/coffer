# Brand, UI and the design system

> What is a placeholder and what is decided, where every visual decision lives in the
> code, and the rules a redesign has to keep. Read this before changing how Coffer looks.

---

## 1. What is decided, and what is a placeholder

| Decided                                                                                                                                                                    | Placeholder, waiting for real design                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| The name, **Coffer** — a strongbox, because the books are encrypted at rest                                                                                                | README screenshots — the README carries a comment marking where they go       |
| The tagline, _Your books, in your own safe._                                                                                                                               | Installer artwork: the NSIS sidebar image and the macOS disk-image background |
| The audience (§2)                                                                                                                                                          |                                                                               |
| **Mark:** a square recessed into a square — a coffered ceiling panel, a strongbox lid and a ruled ledger cell at once. Rectangles only                                     |                                                                               |
| **Wordmark:** the name in IBM Plex Serif SemiBold beside the mark. A serif on the name and a sans in the interface                                                         |                                                                               |
| **App icon:** the mark reversed white on Lapis, one flat 1024 × 1024 square with 12% padding, no platform mask                                                             |                                                                               |
| **README banner** (1280 × 320) and **GitHub social preview** (1280 × 640, dark), rendered from the bundled fonts                                                           |                                                                               |
| Colour: **Paper** (light) and **Slate** (dark), accent **Lapis**. Measured, not asserted — see the header of `tokens.css`                                                  |                                                                               |
| Type: **IBM Plex** Sans, Serif and Mono, bundled under SIL OFL 1.1, with the Devanagari cut alongside                                                                      |                                                                               |
| The layout model: a title bar with the command palette, six sections across a section bar, a rail of the current section’s screens, a status bar, and one screen at a time |                                                                               |

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

| What                                   | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name, tagline, description             | `src/branding.ts` is the source of truth. `electron-builder.yml` repeats the values by hand, because YAML cannot import it: change both                                                                                                                                                                                                                                                                                                              |
| The mark                               | `src/shared/brand-mark.ts` holds its construction and small-size rules. Drawn by `components/shell/BrandMark.tsx` and, with the name, `Wordmark.tsx`                                                                                                                                                                                                                                                                                                 |
| App icon                               | `build/icon.png`, 1024 × 1024, committed. Drawn from the mark by `scripts/generate-icon.mjs` (`npm run icon`): rerun it and commit the result after changing the mark or the accent. electron-builder derives every platform's icon from it                                                                                                                                                                                                          |
| README banner, social preview          | `scripts/render-brand-assets.mjs` (`npm run brand:assets`). The banner is committed at `docs/assets/banner.png`; the social preview goes to `dist/brand/` and is uploaded by hand in the repository settings                                                                                                                                                                                                                                         |
| Colour, type, spacing, radius, density | `src/renderer/src/styles/tokens.css`, with the palette's reasoning and its measurements in the header                                                                                                                                                                                                                                                                                                                                                |
| Fonts                                  | `src/renderer/src/assets/fonts/` as local woff2, declared with `@font-face` in `styles/base.css`. Versions, checksums and the OFL notice are in `THIRD-PARTY.md`                                                                                                                                                                                                                                                                                     |
| Element defaults                       | `src/renderer/src/styles/base.css`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Component styles                       | `styles/atoms.css` (buttons, inputs, badges…), `styles/shell.css` (title bar, section bar, rail, status bar), `screens/screens.css` (screen layouts)                                                                                                                                                                                                                                                                                                 |
| Components                             | `src/renderer/src/components/` — `atoms/`, `shell/`, `command-palette/`, `toast/`                                                                                                                                                                                                                                                                                                                                                                    |
| Sections and the rail                  | `lib/screens.ts` holds the six sections (`NAV_GROUPS`) and each screen's `nav` or `navParent`; `lib/sections.ts` decides which section shows and where choosing one lands; `components/shell/` draws the section bar, the rail and the status bar                                                                                                                                                                                                    |
| Icons                                  | `src/renderer/src/lib/icons.ts` — 24 × 24 stroke paths drawn by `components/atoms/Icon.tsx`. No icon library                                                                                                                                                                                                                                                                                                                                         |
| Screens                                | `src/renderer/src/screens/welcome/` (create, pick, unlock, recover a company) and `screens/workspace/` (everything inside an open company)                                                                                                                                                                                                                                                                                                           |
| Screen building blocks                 | `src/renderer/src/screens/components/` — frames, notices, the passphrase field and strength meter, report lines, `MoneyField`, `StepFrame` for a flow in steps, a register's `RegisterToolbar`, `RegisterSearch` and `RegisterPager`, a list's `ListToolbar`, `FigureCell` for a figure in a table, `DeleteDialog`, `CountrySelect`, and the three states every screen ships besides its full one: `EmptyState`, `RegisterSkeleton` and `ErrorState` |
| Density preference                     | `lib/density.ts` decides, `store/density.tsx` wires it: the `data-density` attribute on `<html>`, stored as `coffer.density`. Chosen from the command palette until Settings exists                                                                                                                                                                                                                                                                  |

## 4. Rules a redesign must keep

These are enforced by code, tests or the security model. A visual change that breaks one
is a bug, however it looks.

**Money**

- **The renderer never computes money.** Every figure on a screen was calculated in the
  main process. The document editor shows the last saved totals marked as stale rather
  than adding up lines as you type; a design that wants a live running total needs a
  round trip to main, not arithmetic in a component.
- **A register has no page total.** A sum across one page of rows changes when you press
  Next and means nothing either way. Its foot says where on the list the page is ("Showing
  1–50 of 184", from `documents.count` and `receipts.count`) and nothing more.
- **A line's amount is shown only while the line is what was saved.** The editor's grid
  shows each line's taxable amount from the last save and gives it up the moment that line
  is edited; a new or copied line has none until the draft is saved again.
- **The Overview adds nothing up.** Its four figures are main's: the two aged reports'
  totals, and cash and bank and the month so far from `reports.overviewFigures`, which
  names the accounts it counted. Its lists count and order; they do not sum.
- **A report adds nothing up either.** Every total and subtotal on a statement arrives from
  main, the trial balance's section subtotals included (`TrialBalance.sections`).
- **Negative money is never shown by colour alone.** It carries a sign, and
  `--figure-negative` is deliberately the darkest, heaviest figure colour. A table's figure
  goes through `FigureCell`, which adds the negative ink to a signed amount and nothing else.
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

**Navigation**

- **Six sections, one rail at a time.** Sales, Purchases, Inventory, Accounts, Reports and
  Company sit across the section bar; the rail lists only the screens of the section you
  are in. The Overview is under Accounts and is still where a company opens. Receipts and
  payments sit on their own trade side, beside the documents they settle.
- **The registry is the only list.** A screen joins the rail by declaring `nav` in
  `lib/screens.ts`. A screen outside the rail, such as an editor, declares `navParent`, and
  the rail keeps that register marked while it is open. `ContextRail.test.tsx` walks every
  registered screen and fails if one is more than a section click and a rail click away,
  or if a screen outside the rail names no parent in it.
- **Labels wrap, never truncate.** A long rail label takes a second line. The status bar
  prints the company file's whole path and grows a line rather than cut the folder off.
- **The status bar's sentences are claims.** "encrypted · SQLCipher" and "offline — this
  app never connects" are true because of the cipher in `src/main/db/connection.ts`, the
  renderer's Content Security Policy, and the spellchecker being off in `src/main/index.ts`
  (on Linux it downloads dictionaries). Anything that makes a request changes the sentence.
- **Keys:** <kbd>Ctrl</kbd><kbd>]</kbd> and <kbd>Ctrl</kbd><kbd>[</kbd> move to the next and
  previous section, <kbd>Alt</kbd><kbd>←</kbd> goes back, and <kbd>Ctrl</kbd><kbd>B</kbd>
  collapses the rail to icons, which narrow windows also do on their own. A shortcut on
  an arrow, Home or End never fires inside a field, whatever modifier is held: those keys
  move the caret there. The rest of the map is in §4a below.
- **Appearance and density are chosen from the command palette** until Settings exists.
- **Leaving the books is two commands, not one.** <kbd>Ctrl</kbd><kbd>L</kbd> locks and stops
  at the unlock screen for the company that was open; <kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>O</kbd>
  switches and goes to the picker. Both close the company in main.
- **Every palette result says where it lives,** under its title. A screen's commands are given
  the screen's place by the screen host (`CommandLocation`), so no call site spells its own.
  Parties are results too, read when the palette opens and offered only once something is
  typed (`Command.isSearchOnly`); choosing one opens its record.
- **The company's housekeeping is not on a business screen.** The file path is in the status
  bar, Back up now in the rail, and changing the passphrase and closing the company are
  palette commands on every workspace screen. Company → Backups is where the rest of it
  lives: when the last archive was written, where it went, and the reminder.
- **Coffer never says a backup still exists.** It says when one was written, how big it was
  and where it went, and puts the path on screen so the reader can check the only thing
  that settles it. The file may be on a USB stick in a drawer; this process has not looked
  at that folder since it wrote there. "Your books are safe" is not a claim it can make.

**The keyboard (§4a)**

- **Every binding is in `lib/shortcuts.ts`**, declared on the command that owns it, so the
  palette, the keycap on a button and the key that fires are one fact.
  <kbd>Ctrl</kbd><kbd>K</kbd> palette · <kbd>Ctrl</kbd><kbd>N</kbd> new, of the kind on
  screen · <kbd>Ctrl</kbd><kbd>S</kbd> save · <kbd>Ctrl</kbd><kbd>⏎</kbd> issue or record ·
  <kbd>Ctrl</kbd><kbd>F</kbd> search this register or list ·
  <kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>O</kbd> switch company · <kbd>Ctrl</kbd><kbd>L</kbd>
  lock · <kbd>Ctrl</kbd><kbd>]</kbd> / <kbd>Ctrl</kbd><kbd>[</kbd> sections ·
  <kbd>Ctrl</kbd><kbd>D</kbd> duplicate a line · <kbd>Esc</kbd> one level back.
  `shortcuts.test.ts` fails if two of them are the same chord, and `AppShell.test.tsx`
  fails if two commands registered at once claim one.
- **Enter advances, it never submits.** In an editor it moves to the next field, and at the
  end of the last line it opens another — which is what the person typing meant. Accepting
  a document is always <kbd>Ctrl</kbd><kbd>⏎</kbd>. A textarea keeps its own Enter.
- **Escape steps back exactly one level:** out of the field, then out of the document to its
  register. It never throws typing away without asking — an editor asks before it leaves, and
  a dialog with something typed in it asks in place of its own footer (`hasUnsavedInput`).
  A dialog that is already open owns Escape, and the recovery-codes screen has none at all.
- **Nothing is reachable only by keyboard.** Every binding has a visible control: a button
  that carries the keycap and `aria-keyshortcuts`, the box the key puts the cursor in, or the
  palette row that runs it.

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
- **Deleting always passes through a dialog that repeats the name of the thing**
  (`DeleteDialog`), and a refusal is shown in it rather than as a toast. Archiving is
  reversible and asks nothing.
- **A list of masters is drawn like a register:** a `ListToolbar` (search sized to its
  sentence, and "Show archived" centred beside it), the table in a card, a skeleton while it
  reads, and an empty state that says whether nothing exists yet or nothing matches.
- **No sample values as placeholders.** On an empty form a placeholder that looks like data
  reads as data. Hints say what goes in a box; a country is picked by name.
- **Identifiers are set in mono with a slashed zero** (`isIdentifier`, and
  `.ledger-table__code` in a table; a date is not an identifier). **Money is typed into
  a `MoneyField`,** which takes the currency symbol from the regime and hands back exactly
  what was typed — it never groups, rounds or parses.
- **Every screen ships an empty, a loading and an error state,** and a register loads as a
  skeleton at its real column widths, never behind a spinner. An empty register says which
  of two things it is: nothing yet (with the action that starts one), or nothing matching
  the filter (with the action that clears it).
- **A register row wears one badge,** the answer a reader scans for: Paid, Part paid or
  Overdue where there is a settlement to name, otherwise the document's status.
- **A search box is as wide as its placeholder** (`RegisterSearch`), so the sentence saying
  what it searches is never cut off.
- **Figures sit right in a column,** under a header that sits right too
  (`.ledger-table .ledger-table__figure`).

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
- **Opening the books takes a typed code, not a tick.** The last step of creating a company
  names one of the recovery codes and asks for it back; the tick box beside it carries a
  sentence worth reading, and is not the gate. People tick boxes to make screens go away.
- **Unlock failures are four different states**, not one "wrong passphrase" message: the
  passphrase does not fit, the file is not where it was, the vault beside it is missing, and
  the keys belong to another file. Each says its cause, then its fix, then offers only the
  actions that could fix it (`screens/lib/unlock-failures.ts`), and the passphrase field comes
  back only when the passphrase was the problem.
- **The welcome's four promises are facts.** No account, no subscription, no telemetry, works
  with the internet off. One that stops being true comes off the screen.
- **Issuing asks first, and saves first.** The button and <kbd>Ctrl</kbd><kbd>⏎</kbd> open a
  confirmation naming the party, the amount and the correction that follows (a credit note
  against an invoice). Unsaved edits are saved before it asks, so the amount confirmed is
  main's for exactly what will be numbered.
- **A registration number typed while creating a company is advisory.** It is checked as it
  is typed (`companies.checkRegistration`), which refuses nothing, and saved into Business
  details as the books open, where it is checked again. A save that fails says so and never
  holds the books shut.

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
