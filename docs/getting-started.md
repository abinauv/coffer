# Getting started

> From a clone to a running window, and where your first change belongs.
> Read [`CONVENTIONS.md`](./CONVENTIONS.md) before you write code, and
> [`ARCHITECTURE.md`](./ARCHITECTURE.md) when you want to know why something is the
> shape it is.

---

## 1. What you need

|                  |                                                              |
| ---------------- | ------------------------------------------------------------ |
| Node             | 22 LTS or newer. `package.json` sets `engines.node: >=22`.   |
| npm              | Whatever ships with your Node.                               |
| A compiler       | No. Nothing in this repo is compiled from C or C++ — see §3. |
| A GPU, a display | For `npm run dev`, yes: it opens a real window.              |

Windows, macOS and Linux are all supported for development.

## 2. Clone and run

```bash
git clone https://github.com/abinauv/coffer.git
cd coffer
npm install
npm run dev
```

`npm run dev` builds all three processes, starts a Vite dev server for the renderer on
port 5173, and launches Electron against it. A window appears. Editing a renderer file
hot-reloads; editing a main or preload file restarts the Electron process.

If no window appears, read §6 before anything else. Both of the traps there produce a
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

### Before you push

|                     |                                                                      |
| ------------------- | -------------------------------------------------------------------- |
| `npm run verify`    | **The gate.** typecheck → lint → format:check → test, in that order. |
| `npm run typecheck` | `typecheck:node` then `typecheck:web` — two separate projects.       |
| `npm run lint`      | ESLint over the repo.                                                |
| `npm test`          | Vitest, one pass.                                                    |
| `npm run coverage`  | Vitest with v8 coverage.                                             |

`npm run verify` runs all four checks. Note that it includes `format:check`, so a file
Prettier would reflow fails the gate — run `npm run format` first.

Coverage thresholds are enforced on three directories only: `domain/`, `regimes/` and
`security/`, at 90% lines, 90% functions and 85% branches (`vitest.config.ts`). Those are
where correctness lives. The rest of the codebase is not measured.

### Packaging and release

|                         |                                                               |
| ----------------------- | ------------------------------------------------------------- |
| `npm run build`         | electron-vite production build into `out/`. No installer.     |
| `npm start`             | Run the last `npm run build` output, without a dev server.    |
| `npm run build:win`     | Build, then `electron-builder --win --publish never`.         |
| `npm run build:mac`     | The same for macOS.                                           |
| `npm run build:linux`   | The same for Linux.                                           |
| `npm run native:check`  | Verify the native binaries load under plain Node.             |
| `npm run native:verify` | Also load them inside a real Electron main process.           |
| `npm run checksums`     | SHA-256 every artefact in a directory into `SHA256SUMS.txt`.  |
| `npm run icon`          | Regenerate `build/icon.png` from `scripts/generate-icon.mjs`. |

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

## 6. Two traps that cost hours

Both of these produce a build that reports success and an app that does not work. Neither
prints anything pointing at the cause.

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

## 7. Where a new feature goes

The layout on disk today:

```
src/
├── branding.ts            product name, ids, paths, URLs. The only place they appear.
├── shared/                types + the IPC contract. Imported by all three processes.
│   ├── ipc.ts             CofferApi — the contract
│   ├── dto.ts             the shapes that cross IPC
│   └── scalars.ts         DecimalString, Timestamp, DateString
├── main/
│   ├── index.ts           bootstrap, window, quit
│   ├── companies/         registry, create/open/close/backup/restore
│   ├── db/                connection, migration runner, migrations, Kysely typings
│   ├── domain/            PURE. money/ and time/ so far.
│   ├── regimes/           types.ts + in-gst/ — the internationalisation seam
│   ├── security/          argon2, DEK, vault, recovery codes, sealed box
│   └── ipc/               registry, boundary, validators, handlers/
├── preload/
└── renderer/src/          React: components/, screens/, store/, lib/, styles/
```

`ARCHITECTURE.md` §5 shows more directories than this — `domain/ledger/`,
`db/repos/`, `services/`. Those arrive with Phase 1 and later. What is above is what
exists.

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
