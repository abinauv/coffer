# Getting started

> From a clone to a running window, and where your first change belongs.
> Read [`CONVENTIONS.md`](./CONVENTIONS.md) before you write code, and
> [`ARCHITECTURE.md`](./ARCHITECTURE.md) when you want to know why something is the
> shape it is.

---

## 1. What you need

|                  |                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Node             | 22 LTS or newer. `package.json` sets `engines.node: >=22`, and `.nvmrc` says 22 — the version CI and every release build use. |
| npm              | Whatever ships with your Node.                                                                                                |
| A compiler       | No. Nothing in this repo is compiled from C or C++ — see §3. If something asks you for one, read §6 before installing it.     |
| A GPU, a display | For `npm run dev`, yes: it opens a real window.                                                                               |

Windows, macOS and Linux are all supported for development.

## 2. Clone and run

```bash
git clone https://github.com/abinauv/coffer.git
cd coffer
npm ci --ignore-scripts                  # install without compiling anything
node node_modules/electron/install.js    # the Electron download --ignore-scripts skipped
npm run native:check                     # prove the prebuilt native modules load
npm run dev
```

`npm run dev` builds all three processes, starts a Vite dev server for the renderer on
port 5173, and launches Electron against it. A window appears. Editing a renderer file
hot-reloads; editing a main or preload file restarts the Electron process.

**Install with `--ignore-scripts`.** A plain `npm ci` — or `npm install` on a fresh clone —
fails with a page of `node-gyp` output demanding a C++ compiler for a binary that is
already on disk. §6 explains why, and why the three lines above are the fix.

If no window appears, read §6 before anything else. Two of the traps there produce a
build that looks entirely successful.

## 3. What `npm install` actually does

`postinstall` runs `node scripts/native-modules.mjs`. It **verifies**; it does not
compile or rebuild anything, and it takes under a second:

```
[native] node:
[native]   runtime node on win32-x64 (node 22.20.0, node-api 10)
[native]   ok   better-sqlite3-multiple-ciphers — keyed round-trip via chacha20, file is not plaintext
[native]   ok   @node-rs/argon2 — argon2id hash and verify (m=19456,t=2,p=1)
```

The `node-api 10` on that line is the whole point: the binaries are ABI-stable, so one
file satisfies Node 22, Node 24 and Electron 43 without a recompile. Which is what makes
the `npm ci` behaviour in §6 a trap rather than a requirement — the compiler it asks for
would produce a binary the tarball already contains.

Coffer has two native dependencies — `better-sqlite3-multiple-ciphers` for the encrypted
database and `@node-rs/argon2` for the passphrase. Both are Node-API addons and both ship
prebuilt binaries, so one binary satisfies Node and Electron alike. There is no
`electron-rebuild` step, no `node-gyp`, and no toolchain requirement.
`electron-builder.yml` sets `npmRebuild: false` for the same reason.

What can still go wrong is a binary that is simply absent — `npm install --omit=optional`,
a half-extracted cache, or a platform with no published prebuild. That is what the script
catches. If it fails it re-fetches the two packages once and checks again, then prints
what to try by hand. Set `COFFER_SKIP_NATIVE_CHECK=1` to skip it entirely on an offline
mirror.

## 4. The scripts

Every one of these is in `package.json`. Grouped by when you reach for them.

### While working

|                      |                                                                  |
| -------------------- | ---------------------------------------------------------------- |
| `npm run dev`        | Build all three processes and launch Electron with HMR.          |
| `npm run test:watch` | Vitest in watch mode. `npm test -- --watch` does the same thing. |
| `npm run format`     | Prettier, writing in place.                                      |
| `npm run mutate`     | Break a rule on purpose and check that something fails.          |

### Before you push

|                        |                                                                                |
| ---------------------- | ------------------------------------------------------------------------------ |
| `npm run verify`       | **The gate.** typecheck → lint → format:check → test → test:scripts, in order. |
| `npm run typecheck`    | `typecheck:node` then `typecheck:web` — two separate projects.                 |
| `npm run lint`         | ESLint over the repo.                                                          |
| `npm test`             | Vitest, one pass.                                                              |
| `npm run test:scripts` | `node --test scripts/mutate.test.mjs` — the mutation harness's own tests.      |
| `npm run coverage`     | Vitest with v8 coverage.                                                       |

`npm run verify` runs all five checks. Note that it includes `format:check`, so a file
Prettier would reflow fails the gate — run `npm run format` first.

`npm run lint` is plain `eslint .`, which exits 0 on warnings. That is deliberate rather
than an oversight: locally a warning should be visible without stopping you mid-change,
and CI runs `npm run lint -- --max-warnings 0` so it cannot be ignored where it counts.

Coverage thresholds are enforced on three directories only: `domain/`, `regimes/` and
`security/`, at 90% lines, 90% functions and 85% branches (`vitest.config.ts`). Those are
where correctness lives. The rest of the codebase is not measured.

### Mutation testing

`npm run mutate` is the harness that answers "would anything have noticed?" — coverage
says a line ran, not that a test would fail if it changed.

```bash
npm run mutate -- --defs domain-money             # a recorded campaign
npm run mutate -- --defs domain-money --dry-run   # anchors only, no tests
npm run mutate -- --file src/main/domain/money/scale.ts \
                  --anchor '  money: 2,' --replace '  money: 3,'
```

Campaigns live in `scripts/mutations/`, and the difference between a definitions file and
a one-off is the difference between evidence and a claim: a file is a run somebody else
can repeat. The exit code carries the verdict — 0 everything killed, 1 something
survived, 2 the run was broken. Every campaign needs a control that changes nothing and a
canary that must die; `CONVENTIONS.md` §6 is why, with the ten ways this harness has
printed a full page of confident and entirely fictional results.

Run it **after** `npm run format`. Prettier reflowing a file silently deletes an anchor.

### Packaging and release

|                         |                                                              |
| ----------------------- | ------------------------------------------------------------ |
| `npm run build`         | electron-vite production build into `out/`. No installer.    |
| `npm start`             | Run the last `npm run build` output, without a dev server.   |
| `npm run build:win`     | Build, then `electron-builder --win --publish never`.        |
| `npm run build:mac`     | The same for macOS.                                          |
| `npm run build:linux`   | The same for Linux.                                          |
| `npm run native:check`  | Verify the native binaries load under plain Node.            |
| `npm run native:verify` | Also load them inside a real Electron main process.          |
| `npm run checksums`     | SHA-256 every artefact in a directory into `SHA256SUMS.txt`. |
| `npm run icon`          | Redraw the committed `build/icon.png` from the mark.         |
| `npm run brand:assets`  | Render the README banner and the social preview.             |

`native:verify` is the check that matters before a release, because a binary that loads
under Node can still be the wrong one for Electron:

```
[native] electron main process:
[native]   runtime electron-main on win32-x64 (node 24.18.1, electron 43.4.0, node-api 10)
[native]   ok   better-sqlite3-multiple-ciphers — keyed round-trip via chacha20, file is not plaintext
```

`npm run checksums` takes a directory and defaults to `dist`:

```bash
node scripts/checksums.mjs dist
```

It writes the format `sha256sum -c` accepts. CI runs it over the collected release
artefacts, which is where the published `SHA256SUMS.txt` comes from.

## 5. How the three-process build fits together

`electron.vite.config.ts` declares three builds from one config, and they have genuinely
different rules.

```
src/main/index.ts      →  out/main/index.js       ESM,  Node, externalised deps
src/preload/index.ts   →  out/preload/index.js    CJS,  sandboxed, externalised deps
src/renderer/index.html→  out/renderer/           ESM,  browser, everything bundled
```

**main** is the privileged process. It owns the database, the filesystem, crypto, and all
business logic. `externalizeDepsPlugin()` keeps `better-sqlite3-multiple-ciphers` and
`@node-rs/argon2` out of the bundle — they are loaded from `node_modules` at runtime,
because a native `.node` binary cannot be bundled.

**preload** is the only thing that touches both sides. It exposes exactly one object,
`window.coffer`, and nothing else. See `src/preload/index.ts`: three imports and one
`contextBridge.exposeInMainWorld` call.

**renderer** is React, and is untrusted for correctness. It never computes money. Every
total it shows was calculated in main and sent across.

The window is created with `sandbox: true`, `contextIsolation: true` and
`nodeIntegration: false` (`src/main/index.ts`). None of those three is negotiable, and
none of them is the right thing to change when the preload misbehaves.

### The IPC contract

`src/shared/ipc.ts` declares `CofferApi` and is the single source of truth. The renderer
proxy is generated from it: `api.companies.list()` dispatches to the channel
`companies:list` with no wiring in between.

Two runtime consequences, because a TypeScript interface does not exist at runtime:

- `src/main/ipc/surface.ts` holds `API_SURFACE`, a runtime enumeration of the contract.
  Its type is mapped over `CofferApi`, so adding a method to the contract **fails to
  compile** until it is listed there too.
- `assertApiSurfaceComplete` runs at startup, before any window exists. A contract method
  with no handler behind it crashes the app at boot rather than at click time.

## 6. Four traps that cost hours

The first stops you before anything is built. The next two produce a build that reports
success and an app that does not work. The fourth produces a test that fails for a reason
that has nothing to do with the code under it. None of the four prints anything pointing
at the cause.

### `npm ci` compiles a native module that is already in the tarball

`npm ci` — and `npm install` on a fresh clone, or after deleting `node_modules` — fails
part way through, and what it prints is a wall of `node-gyp`:

```
npm error gyp ERR! find VS You need to install the latest version of Visual Studio
npm error gyp ERR! find VS including the "Desktop development with C++" workload.
npm error gyp ERR! stack Error: Could not find any Visual Studio installation to use
npm error gyp ERR! cwd …\node_modules\better-sqlite3-multiple-ciphers
npm error gyp ERR! node -v v24.19.0
```

**This reads exactly like a broken dependency and is not one.** Nothing here needs
compiling. `better-sqlite3-multiple-ciphers` carries its binaries in its own tarball —
eight of them, one per platform and architecture, Node-API so that the same file
satisfies Node 22, Node 24 and Electron alike:

```
node_modules/better-sqlite3-multiple-ciphers/prebuilds/
  darwin-arm64.node   linux-arm64.node      linuxmusl-arm64.node   win32-arm64.node
  darwin-x64.node     linux-x64.node        linuxmusl-x64.node     win32-x64.node
```

The package has a `binding.gyp` and no install script of its own, so `npm ci` reaches for
its default build step and starts compiling SQLite from source before it has looked in
`prebuilds/` at all. The toolchain it then asks for is a toolchain this project has never
needed (§3), and installing one only makes the wrong thing succeed slowly.

The fix is to tell it not to:

```bash
npm ci --ignore-scripts
node node_modules/electron/install.js
node scripts/native-modules.mjs --no-repair
```

The first line installs everything and runs no lifecycle script, so the prebuilds land
untouched. That also skips **Electron's own** install script, which is what downloads the
Electron binary — without the second line `node_modules/electron/dist` is empty and
`npm run dev` has nothing to launch. The third is the `postinstall` check run by hand, in
verify-only mode — it loads both native modules and does a keyed round-trip, which is the
thing you actually wanted proved:

```
[native] node:
[native]   runtime node on win32-x64 (node 24.19.0, node-api 10)
[native]   ok   better-sqlite3-multiple-ciphers — keyed round-trip via chacha20, file is not plaintext
[native]   ok   @node-rs/argon2 — argon2id hash and verify (m=19456,t=2,p=1)
```

Measured on Node 24.19.0 with npm 11.17.0 and node-gyp 12.4.0, and again on Node 22.23.2
with npm 10.9.8, where `npm install` on a fresh clone failed in exactly the same way. In a
tree whose `node_modules` already exists, `npm install` does not do this, which is why the
trap is invisible until the first clean clone.

### A sandboxed preload must be CommonJS

`electron.vite.config.ts` forces `format: 'cjs'` for the preload build, and this is not a
style preference. A sandboxed preload is not a real ES module context — Electron loads it
with a restricted CommonJS-ish loader. An `.mjs` preload dies on `Cannot use import
statement outside a module`, `contextBridge` never runs, and `window.coffer` is silently
`undefined`. The renderer then looks broken with no error anywhere near the preload.

The fix is never to set `sandbox: false`. Check that `out/preload/index.js` starts with
`"use strict"; const electron = require("electron");` — if it starts with `import`, the
output format is wrong.

### `ELECTRON_RUN_AS_NODE=1` starts Electron with no window

Some editors, terminals and agent harnesses export this variable. With it set, the
Electron binary runs as plain Node: no Chromium, no `app`, no window. `npm run dev`
builds all three processes, prints `starting electron app...`, and then:

```
import { app, shell, ipcMain, BrowserWindow, dialog } from "electron";
                              ^^^^^^^^^^^^^
SyntaxError: The requested module 'electron' does not provide an export named 'BrowserWindow'
```

That message is the symptom, not a bug in `src/main/index.ts`. Check for it first:

```bash
echo "[$ELECTRON_RUN_AS_NODE]"    # should print []
unset ELECTRON_RUN_AS_NODE
```

`scripts/native-modules.mjs` deletes the variable from the environment of every child it
spawns, for exactly this reason — otherwise its Electron check would quietly downgrade to
a Node check and pass when it should not.

### Prettier formats the HTML inside an `html` tagged template

`src/main/services/pdf/escape.ts` exports an `html` tag, and Prettier recognises it: the
markup inside one of those templates is reformatted as HTML, which is why
`invoice-template.ts` reads as a page rather than as string soup. It is a real benefit and
it has one consequence nobody expects the first time.

**A byte-for-byte assertion on a fragment built by `html` is an assertion about
Prettier's line width.** Add a class name, and the formatter rewraps an attribute, and a
test that has nothing to do with your change goes red on whitespace. The failure diff
looks like a rendering bug.

Compare with the whitespace collapsed, or — better, and what the template's own tests do —
read the value out of the structure rather than out of the string. `escape.test.ts` says
so at the point where it does the former, and `invoice-template.test.ts` is the latter.
The same reasoning applies to any tag name Prettier embeds: `css`, `graphql`, `sql`.

## 7. Where a new feature goes

The layout on disk today:

```
src/
├── branding.ts            product name, ids, paths, URLs. The only place they appear.
├── shared/                types + the IPC contract. Imported by all three processes.
│   ├── ipc.ts             CofferApi — the contract. Twelve groups.
│   ├── dto.ts             the shapes that cross IPC
│   ├── documents.ts       the five trade-document kinds, as data
│   ├── receipts.ts        the four voucher kinds, as data
│   └── scalars.ts         DecimalString, Timestamp, DateString
├── main/
│   ├── index.ts           bootstrap, window, quit
│   ├── books/             which database is open, and under which regime
│   ├── companies/         registry, create/open/recover/close, backup/restore
│   ├── db/                connection, migration runner, migrations/ (0001–0022),
│   │                      schema.ts (20 tables), repos/ (one per aggregate)
│   ├── domain/            PURE. money/ time/ ledger/ documents/ receipts/
│   │                      inventory/ reports/
│   ├── regimes/           types.ts + in-gst/ — the internationalisation seam
│   ├── security/          argon2, DEK, vault, recovery codes, sealed box
│   ├── services/          pdf/ and importers/{csv,xml,zoho,tally}/ — built,
│   │                      tested, and not yet reachable over IPC
│   ├── ledger/ parties/ items/ units/ documents/ receipts/ numbering/
│   │   company-profile/ regime/    one service per IPC group
│   └── ipc/               registry, boundary, validators, handlers/
├── preload/
└── renderer/src/          React: components/, screens/, store/, lib/, styles/
```

`ARCHITECTURE.md` §5 is the same tree with the reasoning attached, and it marks the three
things that are still only planned: `main/app/`, `services/excel/` and
`services/mailer/`. Backup is not among them — it lives in `companies/`, where the vault
paths are.

**`services/` is the one part of this tree you cannot reach by clicking.** `pdf/` renders
an invoice to HTML and the four importers parse CSV and Tally XML; all of it is pure, all
of it is tested against fixtures, and none of it has an IPC group or a caller outside
`services/`. If you go looking for the screen that prints an invoice, there is not one
yet.

Decide where your change goes by asking what it is:

| What you are adding                         | Where it goes                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| Arithmetic on money, dates or periods       | `src/main/domain/`. No I/O, no `node:*`, no `electron` — ESLint enforces this.   |
| Anything GST-specific                       | `src/main/regimes/in-gst/`. If you are about to type `cgst` anywhere else, stop. |
| A new table                                 | A new migration in `src/main/db/migrations/`, plus its typing in `db/schema.ts`. |
| Something the renderer must be able to call | A method on `CofferApi`, then `API_SURFACE`, then a handler. See below.          |
| A screen                                    | `src/renderer/src/screens/`. It displays; it does not calculate.                 |
| Key handling                                | `src/main/security/`. It is a leaf module and stays one.                         |

### Adding an IPC endpoint, in full

1. Add the method to its group in `CofferApi` (`src/shared/ipc.ts`).
2. Add any DTOs to `src/shared/dto.ts`. Money crosses as a decimal string.
3. Add the method name to `API_SURFACE` in `src/main/ipc/surface.ts`. Typecheck fails
   until you do.
4. Register a handler in `src/main/ipc/handlers/<group>.ts`. Validate the input with the
   helpers in `src/main/ipc/validate.ts`, call the service, return `ok(...)`.

The renderer then calls `api.<group>.<method>(...)` with no further wiring. Never write a
bare `ipcRenderer.invoke` anywhere.

Handlers own the boundary, not the behaviour. The service throws; the boundary in
`src/main/ipc/registry.ts` maps the error onto a `Result` envelope with a stable code.

## 8. Tests

Co-located: `posting-engine.ts` sits beside `posting-engine.test.ts`. Vitest picks up
`src/**/*.test.{ts,tsx}` and runs in a `node` environment.

Anything touching money, tax or posting uses **golden fixtures** — JSON in a
`__fixtures__/` folder beside the code. There are already fixtures for rounding,
allocation, percentage, storage, calendar dates, fiscal years, GSTIN validation,
tax splits and amount-in-words. Changing a rounding rule must break a test. That is the
point of them, not an inconvenience.

The whole suite runs in under ten seconds, so there is no reason not to run it.

## 9. Before you open a pull request

```bash
npm run format
npm run verify
```

Commits are conventional and signed off:

```bash
git commit -s -m "feat(ledger): add reversal entries"
```

The rest — what a good PR looks like, what will be rejected — is in
[`CONTRIBUTING.md`](../CONTRIBUTING.md).
