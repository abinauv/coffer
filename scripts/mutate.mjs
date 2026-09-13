#!/usr/bin/env node
/*
 * Coffer's mutation harness.
 *
 * WHAT IT IS FOR. docs/CONVENTIONS.md §6 says a passing test is not evidence until it
 * has failed. This is the thing that makes it fail: it edits one line of a source file,
 * runs the suite, puts the line back, and reports whether anything noticed.
 *
 * RUN IT AFTER `npm run format`, NEVER BEFORE. Every mutation is anchored on a literal
 * piece of text. Prettier moving a line break moves the anchor, and an anchor that no
 * longer matches is a mutation that never happened — which, before the anchor check
 * below existed, was silently reported as a clean result. Format first, then mutate.
 *
 *   node scripts/mutate.mjs --help
 *   node scripts/mutate.mjs --file <path> --anchor <text> --replace <text>
 *   node scripts/mutate.mjs --defs domain-money
 *   npm run mutate -- --defs domain-money
 *
 * WHY IT IS THIS PARANOID. The harness has been rebuilt from nothing by nearly every
 * batch, and it has failed in ten distinct ways, each of which produced a page of
 * confident output that was entirely fictional. They all had the same shape:
 *
 *   A RUN THAT NEVER STARTED LOOKS EXACTLY LIKE A RUN THAT CAUGHT NOTHING.
 *
 * The list, and where each one is now made impossible rather than merely unlikely:
 *
 *   1. PowerShell 5.1 `Get-Content`/`Set-Content` round-trips UTF-8 through the ANSI
 *      codepage: every em-dash in the file under test was corrupted and a BOM appeared.
 *      -> Nothing but Node's own `fs` touches a source file here, and the restore path
 *         is `fs.copyFileSync` of the original bytes, so no encoding is involved at all.
 *   2. `npx.cmd` through `spawnSync` fails with EINVAL on Windows, so no run ever
 *      started.  -> `process.execPath` runs `node_modules/vitest/vitest.mjs` directly.
 *   3. A lowercase drive letter as `cwd` — vitest treats `d:\...` and `D:\...` as
 *      different roots and the whole suite fails.  -> `normalisePath` upper-cases it.
 *   4. `--reporter=basic` does not exist in Vitest 4, so nothing ran and all 19
 *      mutations reported SURVIVED.  -> no reporter flag is passed, and the CONTROL run
 *      below refuses to continue unless a summary was actually parsed out of the output.
 *   5. Vitest writes its summary to stderr in some configurations; a harness reading
 *      stdout alone saw nothing and called every mutant — including the control — a
 *      module-load kill.  -> stdout and stderr are concatenated before parsing.
 *   6. Driving vitest from an Electron-as-node parent collected 0 tests in every file.
 *      -> the file count is compared against a baseline, and 0 files is a dead control.
 *   7. Prettier reformatting between runs deleted a canary's anchor.  -> the anchor
 *      check: not exactly one match is `ANCHOR?`, reported, never skipped.
 *   8. An interrupted run left a mutation in the source, and the next run snapshotted
 *      the mutated file as its original and made the mutation permanent.  -> the
 *      snapshot lives on DISK, and finding one from an earlier run is a refusal to
 *      start, not a warning. Restore happens in `finally` and on SIGINT/SIGTERM.
 *   9. A harness reading only the test count called the loudest possible kill a gap: a
 *      mutation that breaks module load prints `Test Files 1 failed` above
 *      `Tests 384 passed`, because the broken file collected nothing and so failed
 *      nothing.  -> the FILE count is read before the test count, and both are compared
 *      against a baseline taken before any mutation.
 *  10. Python's `write_text` translates `\n` to `\r\n` on Windows, converting a file to
 *      CRLF so every multi-line anchor stopped matching.  -> see 1; and a zero-match
 *      anchor says out loud when the file is CRLF and the anchor is not.
 *
 * THE TWO THINGS THAT MAKE THE REPORT BELIEVABLE, neither of which is optional:
 *
 *   CONTROL  A run with no mutation at all, before anything is touched. It must be
 *            green. If it is not, some test was already failing, or the run did not
 *            start, and every other figure in the report is noise. The harness reports
 *            BROKEN and stops. The control is also the BASELINE: the file and test
 *            counts everything afterwards is measured against.
 *   CANARY   A mutation that MUST be killed, anchored on something a test pins BY
 *            VALUE. It is the only proof that a kill was still possible at all. "By
 *            value" is the whole of it — a canary sitting on an error message no
 *            assertion reads survives, and reports a broken harness as a broken suite.
 *
 * EXIT CODES. 0 everything killed; 1 something survived; 2 the run was broken and the
 * numbers cannot be believed. So CI can use it without reading the page.
 *
 * This file has its own test. A tool that reports on your tests needs its own:
 *
 *   node --test scripts/mutate.test.mjs
 */

import process from 'node:process'
import console from 'node:console'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

/**
 * Where the on-disk snapshots live while a campaign is running.
 *
 * The name ends in `.local`, which `.gitignore` already covers, so a snapshot left by
 * an interrupted run is never committed — but it IS still there on disk, which is the
 * entire point: the next run finds it and refuses to start.
 */
export const SNAPSHOT_DIRNAME = '.mutation-snapshot.local'
const MANIFEST_NAME = 'snapshot.json'

/** Ten minutes. The control run uses it too, so a budget set too low kills the control. */
const DEFAULT_TIMEOUT_MS = 600_000

/* Built rather than written as a literal: an ESC in a regex literal trips
 * `no-control-regex`, and a disable comment for something this incidental reads worse
 * than one line of construction. */
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Absolute, and on Windows with an upper-case drive letter.
 *
 * Failure 3: vitest given `d:\local-erp\coffer` as its cwd resolved its config against
 * a path it considered different from the one the test files were discovered under, and
 * failed the entire suite — which is indistinguishable from a mutation nothing caught.
 */
export function normalisePath(target) {
  const resolved = path.resolve(target)
  if (process.platform === 'win32' && /^[a-z]:/.test(resolved)) {
    return resolved[0].toUpperCase() + resolved.slice(1)
  }
  return resolved
}

/** Repo-relative, forward slashes, for anything printed or compared. */
export function relativeTo(root, target) {
  return path.relative(root, target).split(path.sep).join('/')
}

/**
 * The directory holding `package.json`, walked up from a starting point.
 *
 * Deliberately not `process.cwd()`: the harness must behave the same whether it was
 * invoked from the repo root, from `scripts/`, or by an editor with a cwd of its own.
 */
export function findRepoRoot(startDir) {
  let dir = normalisePath(startDir)
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error(`No package.json above ${startDir}`)
    dir = parent
  }
}

// ---------------------------------------------------------------------------
// Reading vitest's output
// ---------------------------------------------------------------------------

export function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, '')
}

/**
 * One stream, because the summary is not reliably on either one.
 *
 * Failure 5: a harness reading stdout alone reported every mutant, control included, as
 * a module-load kill, because that particular vitest wrote its summary to stderr.
 */
export function combineStreams(stdout, stderr) {
  return `${stdout ?? ''}\n${stderr ?? ''}`
}

function lastMatch(text, pattern) {
  let found = null
  for (const match of text.matchAll(pattern)) found = match
  return found
}

function parseCounts(tail) {
  const counts = { failed: 0, passed: 0, skipped: 0, todo: 0, total: 0 }
  for (const match of tail.matchAll(/(\d+)\s+(failed|passed|skipped|todo)/g)) {
    counts[match[2]] = Number(match[1])
  }
  const total = /\((\d+)\)\s*$/.exec(tail.trim())
  counts.total = total
    ? Number(total[1])
    : counts.failed + counts.passed + counts.skipped + counts.todo
  return counts
}

/**
 * Pull the `Test Files` and `Tests` lines out of a combined vitest run.
 *
 * `ok: false` means no summary was printed at all, which is never a clean result — see
 * `classify`. The last occurrence of each line wins, because a test's own console output
 * can contain anything.
 */
export function parseSummary(rawOutput) {
  const text = stripAnsi(rawOutput ?? '')
  const filesLine = lastMatch(text, /^[ \t]*Test Files[ \t]+(.+)$/gm)
  const testsLine = lastMatch(text, /^[ \t]*Tests[ \t]+(.+)$/gm)
  if (filesLine === null || testsLine === null) {
    const reason = /No test files found/.test(text)
      ? 'vitest found no test files'
      : 'vitest printed no summary'
    return { ok: false, reason, files: null, tests: null }
  }
  return {
    ok: true,
    reason: null,
    files: parseCounts(filesLine[1]),
    tests: parseCounts(testsLine[1]),
  }
}

/** The test files vitest named on a FAIL line, so the report can say which ones died. */
export function failedTestFiles(rawOutput) {
  const found = new Set()
  for (const line of stripAnsi(rawOutput ?? '').split(/\r?\n/)) {
    if (!/\bFAIL\b/.test(line)) continue
    for (const match of line.matchAll(/([\w@./\\-]+\.(?:test|spec)\.[cm]?[jt]sx?)/g)) {
      found.add(match[1].split('\\').join('/'))
    }
  }
  return [...found]
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * KILLED / SURVIVED / BROKEN for one run, against the baseline the control produced.
 *
 * The order of the checks is the point, not an implementation detail.
 *
 * FILE COUNT FIRST (failures 9 and 6). A mutation that breaks module load fails a whole
 * FILE without failing a single TEST — the file collected nothing, so nothing in it
 * could fail. `Test Files 1 failed | 8 passed` sits directly above `Tests 384 passed`,
 * and a harness reading the second line calls the loudest kill in the batch a gap.
 *
 * THEN THE TOTALS, AGAINST A BASELINE. Tests that stopped being collected are tests
 * that disappeared, and a suite that observes less than it did is not a suite that found
 * nothing wrong. Any deviation in either direction is a kill: the mutation changed what
 * the suite could see.
 *
 * NO SUMMARY IS NEVER SURVIVED. If vitest printed nothing parseable and exited non-zero,
 * the run collapsed — that is a kill. If it printed nothing parseable and exited zero,
 * something is wrong with the harness itself, and the honest answer is BROKEN.
 */
export function classify(baseline, run) {
  if (run.error) {
    return { verdict: 'BROKEN', reason: `vitest did not start: ${run.error}` }
  }
  if (run.timedOut) {
    return { verdict: 'KILLED', reason: `vitest was killed after the ${run.timeout}ms budget` }
  }
  const summary = run.summary
  if (!summary.ok) {
    return run.exitCode === 0
      ? { verdict: 'BROKEN', reason: `${summary.reason} and still exited 0 — unreadable` }
      : { verdict: 'KILLED', reason: `the run collapsed before any summary (exit ${run.exitCode})` }
  }

  const before = baseline.summary
  const after = summary

  if (after.files.failed > 0) {
    return { verdict: 'KILLED', reason: `Test Files ${after.files.failed} failed` }
  }
  if (after.files.total !== before.files.total) {
    return {
      verdict: 'KILLED',
      reason: `test files collected ${before.files.total} -> ${after.files.total}`,
    }
  }
  if (after.tests.total !== before.tests.total) {
    return {
      verdict: 'KILLED',
      reason: `tests collected ${before.tests.total} -> ${after.tests.total}`,
    }
  }
  if (after.tests.failed > 0) {
    return { verdict: 'KILLED', reason: `Tests ${after.tests.failed} failed` }
  }
  if (after.tests.passed !== before.tests.passed) {
    return {
      verdict: 'KILLED',
      reason: `tests passing ${before.tests.passed} -> ${after.tests.passed}`,
    }
  }
  if (run.exitCode !== 0) {
    return { verdict: 'KILLED', reason: `vitest exited ${run.exitCode} with a clean summary` }
  }
  return { verdict: 'SURVIVED', reason: 'file and test counts match the baseline, nothing failed' }
}

/** The control has a stricter bar than "not killed": it has to prove a run happened. */
export function judgeControl(run) {
  if (run.error) return { ok: false, why: `vitest did not start: ${run.error}` }
  if (run.timedOut) return { ok: false, why: `vitest exceeded the ${run.timeout}ms budget` }
  if (!run.summary.ok) return { ok: false, why: `${run.summary.reason} (exit ${run.exitCode})` }
  const { files, tests } = run.summary
  if (files.total === 0) return { ok: false, why: 'no test files were collected' }
  if (tests.total === 0) return { ok: false, why: 'no tests were collected' }
  if (files.failed > 0) return { ok: false, why: `${files.failed} test file(s) already failing` }
  if (tests.failed > 0) return { ok: false, why: `${tests.failed} test(s) already failing` }
  if (run.exitCode !== 0) return { ok: false, why: `vitest exited ${run.exitCode}` }
  return { ok: true, why: 'the suite is green and the run reached a summary' }
}

// ---------------------------------------------------------------------------
// The anchor
// ---------------------------------------------------------------------------

export function countOccurrences(haystack, needle) {
  if (needle === '') return 0
  let count = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}

const collapse = (text) => text.replace(/\s+/g, ' ')

/**
 * Exactly one match, or it is `ANCHOR?` and it is reported.
 *
 * Failure 7: prettier moved a line break between two runs, an anchor stopped matching,
 * and the mutation quietly did not happen. It reported `ANCHOR? (matched 0x)` only
 * because this check existed — otherwise it would have read as a survivor, which is the
 * same page a genuinely untested rule produces. Zero matches and two matches are both
 * broken: two means the mutation is not the one that was written down.
 */
export function checkAnchor(text, anchor, replace) {
  if (typeof anchor !== 'string' || anchor === '') {
    return { ok: false, matches: 0, note: 'the anchor is empty' }
  }
  if (anchor === replace) {
    return { ok: false, matches: 0, note: 'the replacement is identical to the anchor — a no-op' }
  }
  const matches = countOccurrences(text, anchor)
  if (matches === 1) return { ok: true, matches: 1, note: null }
  if (matches > 1) {
    return { ok: false, matches, note: `matched ${matches}x — the anchor is not unique` }
  }
  if (text.includes('\r\n') && !anchor.includes('\r\n')) {
    return { ok: false, matches: 0, note: 'matched 0x — the file is CRLF and the anchor is LF' }
  }
  if (collapse(text).includes(collapse(anchor))) {
    return {
      ok: false,
      matches: 0,
      note: 'matched 0x — it matches ignoring whitespace; run `npm run format` and re-take it',
    }
  }
  return { ok: false, matches: 0, note: 'matched 0x — the text is not in the file' }
}

// ---------------------------------------------------------------------------
// Snapshots, on disk
// ---------------------------------------------------------------------------

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/**
 * Originals copied byte-for-byte to disk, plus a manifest.
 *
 * Failure 8: an interrupted run does not execute its `finally`, and a harness holding
 * its originals in memory loses them with the process. The next run then snapshotted an
 * already-mutated file as its original and restored the mutation permanently. So: the
 * snapshot is a file, restoring is `copyFileSync` of the original bytes (no encoding is
 * involved anywhere on that path), and finding a manifest at startup is a refusal to
 * begin rather than a warning nobody reads.
 */
export function snapshotStore(dir) {
  const manifestPath = path.join(dir, MANIFEST_NAME)

  const readManifest = () => JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  return {
    dir,
    manifestPath,

    exists: () => fs.existsSync(manifestPath),
    read: readManifest,

    /** Copy first, write the manifest last: a half-taken snapshot must not look whole. */
    take(files) {
      fs.mkdirSync(dir, { recursive: true })
      const entries = files.map((file, index) => {
        const absolute = normalisePath(file)
        const bytes = fs.readFileSync(absolute)
        const copy = `${String(index).padStart(2, '0')}-${path.basename(absolute)}.orig`
        fs.copyFileSync(absolute, path.join(dir, copy))
        return { file: absolute, copy, sha256: sha256(bytes), bytes: bytes.length }
      })
      fs.writeFileSync(
        manifestPath,
        `${JSON.stringify({ takenAt: new Date().toISOString(), entries }, null, 2)}\n`,
        'utf8',
      )
      return entries
    },

    /** What is on disk right now, against what was snapshotted. Writes nothing. */
    verify() {
      return readManifest().entries.map((entry) => ({
        file: entry.file,
        identical:
          fs.existsSync(entry.file) && sha256(fs.readFileSync(entry.file)) === entry.sha256,
      }))
    },

    restoreOne(file) {
      const absolute = normalisePath(file)
      const entry = readManifest().entries.find((candidate) => candidate.file === absolute)
      if (!entry) throw new Error(`No snapshot for ${absolute}`)
      fs.copyFileSync(path.join(dir, entry.copy), absolute)
      return sha256(fs.readFileSync(absolute)) === entry.sha256
    },

    restore() {
      return readManifest().entries.map((entry) => {
        fs.copyFileSync(path.join(dir, entry.copy), entry.file)
        return {
          file: entry.file,
          identical: sha256(fs.readFileSync(entry.file)) === entry.sha256,
        }
      })
    },

    clear() {
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// Editing a file — Node's own fs, explicit utf8, and nothing else
// ---------------------------------------------------------------------------

export function readSource(file) {
  return fs.readFileSync(file, 'utf8')
}

/**
 * Splice the replacement in at the single anchor match.
 *
 * `fs.writeFileSync(file, text, 'utf8')` does not translate line endings and does not
 * add a BOM (failures 1 and 10 were both a different tool doing exactly that). The
 * restore path never comes back through here — it copies the original bytes.
 */
export function applyMutation(file, anchor, replace) {
  const original = readSource(file)
  const at = original.indexOf(anchor)
  if (at === -1) throw new Error(`Anchor not found in ${file}`)
  const mutated = original.slice(0, at) + replace + original.slice(at + anchor.length)
  fs.writeFileSync(file, mutated, 'utf8')
  return mutated
}

// ---------------------------------------------------------------------------
// Running vitest
// ---------------------------------------------------------------------------

export function vitestEntry(root) {
  const entry = path.join(root, 'node_modules', 'vitest', 'vitest.mjs')
  if (!fs.existsSync(entry)) {
    throw new Error(`vitest is not installed: expected ${entry}. Run \`npm install\`.`)
  }
  return entry
}

/**
 * Spawn vitest as a child of THIS node.
 *
 * `process.execPath`, never `npx` (failure 2: `npx.cmd` through `spawnSync` fails with
 * EINVAL on Windows and every run failed to start) and never an Electron binary
 * (failure 6: it collected 0 tests in every file). No `--reporter` flag: `basic` does
 * not exist in Vitest 4 and passing it meant no run ever started while all 19 mutations
 * reported SURVIVED (failure 4). The default reporter is what `npm test` already uses.
 */
export function makeVitestRunner(plan) {
  const args = [plan.vitestEntry, 'run', ...plan.filters]
  if (plan.project) args.push('--project', plan.project)

  return () => {
    const result = spawnSync(process.execPath, args, {
      cwd: plan.root,
      encoding: 'utf8',
      timeout: plan.timeout,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0' },
    })
    return {
      exitCode: result.status,
      output: combineStreams(result.stdout, result.stderr),
      error: result.error ? result.error.message : null,
      timedOut: result.signal === 'SIGTERM' && result.status === null,
      timeout: plan.timeout,
    }
  }
}

// ---------------------------------------------------------------------------
// The campaign
// ---------------------------------------------------------------------------

const banner = (out, text) => {
  out('')
  out(text)
  out('-'.repeat(Math.max(text.length, 40)))
}

function describeCounts(summary) {
  if (!summary.ok) return summary.reason
  const part = (counts) =>
    [
      counts.failed ? `${counts.failed} failed` : null,
      counts.passed ? `${counts.passed} passed` : null,
      counts.skipped ? `${counts.skipped} skipped` : null,
    ]
      .filter(Boolean)
      .join(' | ')
  return `files ${part(summary.files)} (${summary.files.total}), tests ${part(summary.tests)} (${summary.tests.total})`
}

/**
 * Run the control, then the canary, then every mutation, one at a time.
 *
 * `options.runSuite` is injectable so that `mutate.test.mjs` can drive the decision
 * logic — which is where all ten historical failures lived — without paying for a real
 * vitest start per case. The default is the real thing.
 */
export async function runCampaign(plan, options = {}) {
  const out = options.out ?? ((line) => console.log(line))
  const runSuite = options.runSuite ?? makeVitestRunner(plan)
  const store = snapshotStore(plan.snapshotDir)

  if (store.exists()) {
    let listed = []
    try {
      listed = store.read().entries.map((entry) => entry.file)
    } catch {
      /* An unreadable manifest is still a leftover, and still a refusal. */
    }
    banner(out, 'BROKEN — a snapshot from an earlier run is still on disk')
    out(`  ${relativeTo(plan.root, store.dir)}`)
    for (const file of listed) out(`  holds the original of ${relativeTo(plan.root, file)}`)
    out('')
    out('  That run was interrupted, so a source file is probably still mutated. Taking a')
    out('  fresh snapshot now would record the MUTATED file as the original and make the')
    out('  mutation permanent. Restore it first:')
    out('')
    out('      node scripts/mutate.mjs --restore')
    return { status: 'BROKEN', exitCode: 2, reason: 'leftover snapshot', results: [] }
  }

  const files = [...new Set([plan.canary, ...plan.mutations].filter(Boolean).map((m) => m.file))]
  for (const file of files) {
    if (!fs.existsSync(file)) throw new Error(`No such file to mutate: ${file}`)
  }

  const run = (context) => {
    const raw = runSuite(context)
    return {
      ...raw,
      summary: parseSummary(raw.output),
      failed: failedTestFiles(raw.output),
    }
  }

  const onSignal = (signal, code) => () => {
    try {
      if (store.exists()) {
        store.restore()
        store.clear()
      }
    } catch {
      /* Nothing useful is left to do while dying; the manifest stays for --restore. */
    }
    out(`\n${signal} — sources restored from the snapshot.`)
    process.exit(code)
  }
  const onInt = onSignal('SIGINT', 130)
  const onTerm = onSignal('SIGTERM', 143)
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)

  store.take(files)

  try {
    banner(out, `CONTROL — no mutation, and it must survive`)
    const controlRun = run({ kind: 'control', name: 'control' })
    const control = judgeControl(controlRun)
    out(`  ${describeCounts(controlRun.summary)}`)
    out(`  CONTROL ${control.ok ? 'SURVIVED' : 'KILLED'} — ${control.why}`)
    if (!control.ok) {
      out('')
      out('  Every other figure this harness could print depends on the control being')
      out('  green, so there are none. Fix the suite (or the harness) and run it again.')
      for (const file of controlRun.failed) out(`    failing: ${file}`)
      return {
        status: 'BROKEN',
        exitCode: 2,
        reason: `control killed: ${control.why}`,
        results: [],
      }
    }

    const baseline = controlRun
    const results = []

    const attempt = (mutation, kind) => {
      const source = readSource(mutation.file)
      const anchor = checkAnchor(source, mutation.anchor, mutation.replace)
      if (!anchor.ok) {
        return {
          kind,
          name: mutation.name,
          file: relativeTo(plan.root, mutation.file),
          verdict: 'ANCHOR?',
          reason: anchor.note,
          failed: [],
          summary: null,
        }
      }
      applyMutation(mutation.file, mutation.anchor, mutation.replace)
      let outcome
      try {
        const mutantRun = run({ kind, name: mutation.name, mutation })
        outcome = { ...classify(baseline, mutantRun), run: mutantRun }
      } finally {
        store.restoreOne(mutation.file)
      }
      return {
        kind,
        name: mutation.name,
        file: relativeTo(plan.root, mutation.file),
        verdict: outcome.verdict,
        reason: outcome.reason,
        failed: outcome.run.failed,
        summary: outcome.run.summary,
        note: mutation.note ?? null,
      }
    }

    let canary = null
    if (plan.canary) {
      banner(out, 'CANARY — a mutation a test pins by value, and it must be killed')
      canary = attempt(plan.canary, 'canary')
      results.push(canary)
      out(`  ${canary.verdict.padEnd(9)} ${canary.name}`)
      out(`            ${canary.reason}`)
      if (canary.failed.length > 0) out(`            died in: ${canary.failed.join(', ')}`)
      if (canary.verdict !== 'KILLED') {
        out('')
        out('  The canary is the only proof a kill was possible at all. It was not killed,')
        out('  so nothing below can be read as evidence of anything. Check that the tests')
        out('  selected actually cover the file, and that the canary sits on a value an')
        out('  assertion reads — not on a message nothing looks at.')
        return {
          status: 'BROKEN',
          exitCode: 2,
          reason: `canary ${canary.verdict}`,
          results,
          baseline,
        }
      }
    }

    banner(out, `MUTATIONS — ${plan.mutations.length}`)
    let index = 0
    for (const mutation of plan.mutations) {
      index += 1
      const result = attempt(mutation, 'mutation')
      results.push(result)
      const counts = result.summary?.ok
        ? `files ${result.summary.files.total}/${baseline.summary.files.total}, tests ${result.summary.tests.total}/${baseline.summary.tests.total}`
        : ''
      out(`  ${String(index).padStart(2)}. ${result.verdict.padEnd(9)} ${result.name}`)
      out(`      ${result.reason}${counts ? `  [${counts}]` : ''}`)
      if (result.failed.length > 0) out(`      died in: ${result.failed.join(', ')}`)
    }

    const mutants = results.filter((result) => result.kind === 'mutation')
    const killed = mutants.filter((result) => result.verdict === 'KILLED')
    const survived = mutants.filter((result) => result.verdict === 'SURVIVED')
    const anchorless = results.filter((result) => result.verdict === 'ANCHOR?')
    const broken = results.filter((result) => result.verdict === 'BROKEN')

    /* No canary was supplied AND nothing was killed: this run proves nothing at all.
     * A kill anywhere in the set is itself proof that a kill was possible; with none,
     * the page is exactly the page a harness that never started would print. */
    const provenByKill = killed.length > 0 || canary?.verdict === 'KILLED'
    const unproven = survived.length > 0 && !provenByKill

    const verification = store.verify()
    const drifted = verification.filter((entry) => !entry.identical)
    if (drifted.length > 0) store.restore()
    store.clear()

    banner(out, 'SUMMARY')
    out(
      `  ${mutants.length} mutation(s): ${killed.length} killed, ${survived.length} survived, ` +
        `${anchorless.length} anchor?, ${broken.length} broken`,
    )
    out(`  control  SURVIVED`)
    out(`  canary   ${canary ? canary.verdict : 'none supplied'}`)
    out(`  baseline files ${baseline.summary.files.total}, tests ${baseline.summary.tests.total}`)
    if (drifted.length === 0) {
      out(`  sources  ${verification.length} file(s) byte-identical to their snapshots`)
    } else {
      for (const entry of drifted) {
        out(`  sources  RESTORED ${relativeTo(plan.root, entry.file)} — it had drifted`)
      }
    }

    if (survived.length > 0) {
      out('')
      out('  SURVIVED — no test in the selected set observed these:')
      for (const result of survived) {
        out(`    ${result.name}  (${result.file})`)
        if (result.note) out(`      ${result.note}`)
      }
    }
    if (anchorless.length > 0) {
      out('')
      out('  ANCHOR? — these mutations did not happen and are not results:')
      for (const result of anchorless) out(`    ${result.name}  ${result.reason}`)
    }
    if (unproven) {
      out('')
      out('  BROKEN — nothing was killed and no canary was supplied, so this run cannot')
      out('  tell a suite that caught nothing from a suite that never ran. Add a canary:')
      out('  --canary-anchor <text a test pins by value> --canary-replace <text>')
    }

    const status =
      broken.length > 0 || anchorless.length > 0 || unproven
        ? 'BROKEN'
        : survived.length > 0
          ? 'SURVIVED'
          : 'CLEAN'
    const exitCode = status === 'BROKEN' ? 2 : status === 'SURVIVED' ? 1 : 0
    out('')
    out(`  ${status}`)
    return { status, exitCode, results, baseline, canary, control }
  } finally {
    if (store.exists()) {
      const restored = store.restore()
      store.clear()
      const bad = restored.filter((entry) => !entry.identical)
      for (const entry of bad) out(`  RESTORE FAILED for ${entry.file}`)
    }
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
  }
}

// ---------------------------------------------------------------------------
// Mutation definitions
// ---------------------------------------------------------------------------

function requireString(value, what, where) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${where}: \`${what}\` must be a non-empty string`)
  }
  return value
}

function normaliseMutation(entry, root, where) {
  requireString(entry?.name, 'name', where)
  requireString(entry?.file, 'file', where)
  requireString(entry?.anchor, 'anchor', where)
  if (typeof entry.replace !== 'string') {
    throw new Error(`${where}: \`replace\` must be a string (it may be empty, to delete)`)
  }
  return {
    name: entry.name,
    file: normalisePath(path.resolve(root, entry.file)),
    anchor: entry.anchor,
    replace: entry.replace,
    note: entry.note ?? null,
  }
}

/**
 * Load a definitions module — this is what turns "I mutation-tested it" into something
 * a reviewer can re-run. A definitions file WITHOUT a canary is rejected: a recorded
 * campaign with no proof that a kill was possible is a recorded fiction.
 */
export async function loadDefinitions(specifier, root) {
  const direct = path.resolve(root, specifier)
  const candidates = [
    direct,
    `${direct}.mjs`,
    path.join(root, 'scripts', 'mutations', `${specifier}.mjs`),
    path.join(root, 'scripts', 'mutations', specifier),
  ]
  const file = candidates.find(
    (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
  )
  if (!file) {
    throw new Error(
      `No mutation definitions found for "${specifier}". Tried:\n  ${candidates.join('\n  ')}`,
    )
  }

  const module = await import(pathToFileURL(file).href)
  const defs = module.default ?? module
  const where = relativeTo(root, file)

  requireString(defs?.name, 'name', where)
  if (!Array.isArray(defs.tests) || defs.tests.length === 0) {
    throw new Error(`${where}: \`tests\` must be a non-empty array of vitest path filters`)
  }
  if (!Array.isArray(defs.mutations) || defs.mutations.length === 0) {
    throw new Error(`${where}: \`mutations\` must be a non-empty array`)
  }
  if (!defs.canary) {
    throw new Error(
      `${where}: a \`canary\` is required. It is the only proof a kill was possible at ` +
        `all — anchor it on something a test pins BY VALUE. See docs/CONVENTIONS.md §6.`,
    )
  }

  return {
    label: defs.name,
    definitionsFile: where,
    filters: defs.tests,
    project: defs.project ?? null,
    canary: normaliseMutation(defs.canary, root, `${where} canary`),
    mutations: defs.mutations.map((entry, index) =>
      normaliseMutation(entry, root, `${where} mutations[${String(index)}]`),
    ),
  }
}

/** `src/renderer/...` runs under the renderer project; everything else under main. */
function projectFor(relativeFile) {
  return relativeFile.startsWith('src/renderer/') ? 'renderer' : 'main'
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `
Coffer mutation harness — break a rule on purpose and check that something fails.

  Run it AFTER \`npm run format\`, never before: mutations are anchored on literal text
  and prettier moving a line break is a mutation that silently does not happen.

USAGE
  node scripts/mutate.mjs --file <path> --anchor <text> --replace <text>
  node scripts/mutate.mjs --defs <name|path>
  node scripts/mutate.mjs --list
  node scripts/mutate.mjs --restore

ONE-OFF
  --file <path>          the source file to mutate
  --anchor <text>        the exact text to replace; it must appear EXACTLY once
  --replace <text>       what to put in its place (may be empty, to delete)
  --name <label>         what to call it in the report        (default: the anchor)
  --canary-anchor <text> a second mutation that MUST be killed
  --canary-replace <t>   ...its replacement
  --canary-file <path>   ...in a different file               (default: --file)

RECORDED CAMPAIGN
  --defs <name|path>     a definitions module; a bare name resolves under
                         scripts/mutations/<name>.mjs
  --only <name>          run just this mutation (repeatable); the control and the
                         canary always run
  --list                 list the definitions files that exist

COMMON
  --tests <filter>       vitest path filter, repeatable
                         (default: the directory of --file, or the defs file's list)
  --project <name>       vitest project: main | renderer   (default: inferred)
  --dry-run              check every anchor and print the plan; run no tests
  --json <path>          also write the machine-readable report there
  --timeout <ms>         per-run budget                     (default: ${String(DEFAULT_TIMEOUT_MS)})
  --restore              restore a snapshot left by an interrupted run, then exit
  --help                 this

VERDICTS
  KILLED     a test noticed. The rule is tested.
  SURVIVED   nothing noticed. Either the rule is untested, or the mutation is
             equivalent — decide which, and say so.
  ANCHOR?    the text did not appear exactly once, so the mutation never happened.
             Not a result. Re-take the anchor after \`npm run format\`.
  BROKEN     the control was killed, the canary survived, or a run did not start.
             No figure in the report can be believed.

EXIT   0 everything killed   1 something survived   2 broken
`

export async function main(argv, options = {}) {
  const out = options.out ?? ((line) => console.log(line))
  const root = options.root ?? findRepoRoot(path.dirname(fileURLToPath(import.meta.url)))

  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        help: { type: 'boolean', short: 'h' },
        file: { type: 'string' },
        anchor: { type: 'string' },
        replace: { type: 'string' },
        name: { type: 'string' },
        note: { type: 'string' },
        'canary-file': { type: 'string' },
        'canary-anchor': { type: 'string' },
        'canary-replace': { type: 'string' },
        defs: { type: 'string' },
        only: { type: 'string', multiple: true },
        tests: { type: 'string', multiple: true },
        project: { type: 'string' },
        list: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        json: { type: 'string' },
        timeout: { type: 'string' },
        restore: { type: 'boolean' },
      },
    }))
  } catch (error) {
    out(`${error.message}\n`)
    out(USAGE)
    return 2
  }

  if (values.help || argv.length === 0) {
    out(USAGE)
    return values.help ? 0 : 2
  }

  const snapshotDir = path.join(root, SNAPSHOT_DIRNAME)

  if (values.restore) {
    const store = snapshotStore(snapshotDir)
    if (!store.exists()) {
      out('No snapshot to restore — nothing was left behind.')
      return 0
    }
    const restored = store.restore()
    store.clear()
    for (const entry of restored) {
      out(`${entry.identical ? 'restored' : 'FAILED  '} ${relativeTo(root, entry.file)}`)
    }
    return restored.every((entry) => entry.identical) ? 0 : 2
  }

  if (values.list) {
    const dir = path.join(root, 'scripts', 'mutations')
    const found = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')) : []
    out(found.length === 0 ? 'No definitions files in scripts/mutations/.' : 'Definitions:')
    for (const file of found) out(`  ${file.replace(/\.mjs$/, '')}   (scripts/mutations/${file})`)
    return 0
  }

  let plan
  if (values.defs) {
    const defs = await loadDefinitions(values.defs, root)
    const wanted = values.only ? new Set(values.only) : null
    const chosen = wanted
      ? defs.mutations.filter((mutation) => wanted.has(mutation.name))
      : defs.mutations
    if (wanted && chosen.length === 0) {
      out(`No mutation named ${[...wanted].join(', ')} in ${defs.definitionsFile}.`)
      return 2
    }
    plan = { ...defs, mutations: chosen, filters: values.tests ?? defs.filters }
  } else if (values.file) {
    if (typeof values.anchor !== 'string' || typeof values.replace !== 'string') {
      out('--file needs both --anchor and --replace.\n')
      out(USAGE)
      return 2
    }
    const file = normalisePath(path.resolve(root, values.file))
    const rel = relativeTo(root, file)
    const canaryAnchor = values['canary-anchor']
    plan = {
      label: values.name ?? rel,
      definitionsFile: null,
      filters: values.tests ?? [path.posix.dirname(rel)],
      project: values.project ?? projectFor(rel),
      canary:
        typeof canaryAnchor === 'string'
          ? normaliseMutation(
              {
                name: 'canary',
                file: values['canary-file'] ?? values.file,
                anchor: canaryAnchor,
                replace: values['canary-replace'] ?? '',
              },
              root,
              '--canary-*',
            )
          : null,
      mutations: [
        normaliseMutation(
          {
            name: values.name ?? values.anchor.trim().slice(0, 60),
            file: values.file,
            anchor: values.anchor,
            replace: values.replace,
            note: values.note,
          },
          root,
          '--file/--anchor/--replace',
        ),
      ],
    }
  } else {
    out('Nothing to do: pass --file/--anchor/--replace, or --defs.\n')
    out(USAGE)
    return 2
  }

  if (values.project) plan.project = values.project
  plan.root = root
  plan.snapshotDir = snapshotDir
  plan.timeout = values.timeout ? Number(values.timeout) : DEFAULT_TIMEOUT_MS
  plan.vitestEntry = values['dry-run'] ? null : vitestEntry(root)

  out(`Coffer mutation harness — ${plan.label}`)
  out(`  repo      ${root}`)
  out(`  tests     ${plan.filters.join(' ')}`)
  out(`  project   ${plan.project ?? '(all)'}`)
  if (plan.definitionsFile) out(`  defs      ${plan.definitionsFile}`)
  out(`  run this AFTER \`npm run format\`, never before`)

  if (values['dry-run']) {
    banner(out, 'DRY RUN — anchors only, no tests')
    let bad = 0
    for (const mutation of [plan.canary, ...plan.mutations].filter(Boolean)) {
      const check = checkAnchor(readSource(mutation.file), mutation.anchor, mutation.replace)
      if (!check.ok) bad += 1
      out(`  ${check.ok ? 'ok     ' : 'ANCHOR?'} ${mutation.name}`)
      out(`          ${relativeTo(root, mutation.file)}${check.ok ? '' : ` — ${check.note}`}`)
    }
    out('')
    out(
      bad === 0 ? '  every anchor matches exactly once' : `  ${String(bad)} anchor(s) do not match`,
    )
    return bad === 0 ? 0 : 2
  }

  const report = await runCampaign(plan, { out })

  if (values.json) {
    const target = path.resolve(root, values.json)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(
      target,
      `${JSON.stringify({ label: plan.label, ...report, baseline: undefined }, null, 2)}\n`,
      'utf8',
    )
    out(`  report    ${relativeTo(root, target)}`)
  }

  return report.exitCode
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  normalisePath(process.argv[1]) === normalisePath(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(`\nmutate: ${error.message}`)
      process.exitCode = 2
    },
  )
}
