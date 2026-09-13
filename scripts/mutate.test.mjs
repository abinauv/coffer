/*
 * The mutation harness's own test.
 *
 * docs/CONVENTIONS.md §6 argues that a passing test is not evidence until it has
 * failed, and then that a mutation harness is not evidence either until it has been
 * checked the same way — "a tool that reports on your tests needs its own". This is it.
 *
 *   node --test scripts/mutate.test.mjs
 *
 * It is `node:test` rather than vitest because `vitest.config.ts` collects only
 * `src/**`, and adding `scripts/` to it is a change to a file this task does not own.
 * Nothing here needs a test framework's cleverness: it asserts on the report object
 * `runCampaign` returns.
 *
 * WHAT IT PROVES, one case per historical failure that produced a confident lie:
 *
 *   - a killed CONTROL reports BROKEN and runs no mutation at all (failures 4, 5, 6)
 *   - a surviving CANARY reports BROKEN, even with every mutation "killed" (failure 4)
 *   - a zero-match ANCHOR is reported as ANCHOR?, never skipped (failures 7, 10)
 *   - a leftover snapshot REFUSES to start (failure 8)
 *   - the source is restored, byte for byte, after an exception mid-campaign
 *   - `Test Files 1 failed` above `Tests 384 passed` is a KILL (failure 9)
 *   - a summary that arrived only on stderr is still read (failure 5)
 *
 * Fixtures live under the OS temp directory. Nothing in src/ is touched.
 */

import process from 'node:process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import {
  SNAPSHOT_DIRNAME,
  checkAnchor,
  classify,
  combineStreams,
  countOccurrences,
  failedTestFiles,
  judgeControl,
  normalisePath,
  parseSummary,
  runCampaign,
  snapshotStore,
} from './mutate.mjs'

// ---------------------------------------------------------------------------
// Fixtures — a throwaway "repo" per test, under the OS temp directory
// ---------------------------------------------------------------------------

const roots = []

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

const SOURCE = [
  'export const RATE = 18',
  '',
  'export function label() {',
  "  return 'gst'",
  '}',
  '',
].join('\n')

function makeRepo() {
  const root = normalisePath(fs.mkdtempSync(path.join(os.tmpdir(), 'coffer-mutate-')))
  roots.push(root)
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}\n', 'utf8')
  fs.writeFileSync(path.join(root, 'thing.ts'), SOURCE, 'utf8')
  return root
}

/** The plan a campaign runs, pointed at the fixture repo. */
function planFor(root, overrides = {}) {
  return {
    root,
    snapshotDir: path.join(root, SNAPSHOT_DIRNAME),
    label: 'fixture',
    filters: ['thing'],
    project: null,
    timeout: 1000,
    canary: {
      name: 'canary',
      file: path.join(root, 'thing.ts'),
      anchor: 'export const RATE = 18',
      replace: 'export const RATE = 5',
      note: null,
    },
    mutations: [
      {
        name: 'label',
        file: path.join(root, 'thing.ts'),
        anchor: "return 'gst'",
        replace: "return 'vat'",
        note: null,
      },
    ],
    ...overrides,
  }
}

/** A vitest run that never happened, rendered the way vitest renders it. */
function summaryOf({ files = 2, filesFailed = 0, tests = 40, testsFailed = 0, stream = 'out' }) {
  const filesTail =
    filesFailed > 0
      ? `${filesFailed} failed | ${files - filesFailed} passed (${files})`
      : `${files} passed (${files})`
  const testsTail =
    testsFailed > 0
      ? `${testsFailed} failed | ${tests - testsFailed} passed (${tests})`
      : `${tests} passed (${tests})`
  const text = `\n RUN  v4.1.10\n\n Test Files  ${filesTail}\n      Tests  ${testsTail}\n`
  return stream === 'err' ? combineStreams('', text) : combineStreams(text, '')
}

const green = () => ({ exitCode: 0, output: summaryOf({}), error: null, timedOut: false })
const red = () => ({
  exitCode: 1,
  output: `${summaryOf({ filesFailed: 1, testsFailed: 3 })}\n FAIL  thing.test.ts > it works\n`,
  error: null,
  timedOut: false,
})

const silence = () => {}

// ---------------------------------------------------------------------------

describe('parsing what vitest printed', () => {
  it('reads the file line and the test line', () => {
    const summary = parseSummary(summaryOf({ files: 5, tests: 260 }))
    assert.equal(summary.ok, true)
    assert.equal(summary.files.total, 5)
    assert.equal(summary.tests.total, 260)
  })

  it('reads a summary that arrived only on stderr (failure 5)', () => {
    const summary = parseSummary(summaryOf({ files: 5, tests: 260, stream: 'err' }))
    assert.equal(summary.ok, true)
    assert.equal(summary.tests.total, 260)
  })

  it('says so rather than guessing when nothing parseable was printed', () => {
    const summary = parseSummary('EINVAL: spawn npx.cmd\n')
    assert.equal(summary.ok, false)
    assert.match(summary.reason, /no summary/)
  })

  it('names the test files that died', () => {
    assert.deepEqual(failedTestFiles(red().output), ['thing.test.ts'])
  })
})

describe('the verdict', () => {
  const baseline = { summary: parseSummary(summaryOf({ files: 9, tests: 384 })), exitCode: 0 }

  it('a broken module load is a KILL, not a gap (failure 9)', () => {
    /* The exact shape: one file failed to collect, so it failed no tests, and the Tests
     * line reports 384 passed above it. Reading the Tests line alone says SURVIVED. */
    const output = `\n Test Files  1 failed | 8 passed (9)\n      Tests  384 passed (384)\n`
    const verdict = classify(baseline, {
      exitCode: 1,
      output,
      error: null,
      summary: parseSummary(output),
      failed: [],
    })
    assert.equal(verdict.verdict, 'KILLED')
    assert.match(verdict.reason, /Test Files 1 failed/)
  })

  it('tests that stopped being collected are a KILL', () => {
    const output = `\n Test Files  8 passed (8)\n      Tests  340 passed (340)\n`
    const verdict = classify(baseline, {
      exitCode: 0,
      output,
      error: null,
      summary: parseSummary(output),
      failed: [],
    })
    assert.equal(verdict.verdict, 'KILLED')
    assert.match(verdict.reason, /test files collected 9 -> 8/)
  })

  it('a run that never started is never SURVIVED (failures 2, 4)', () => {
    const dead = classify(baseline, {
      exitCode: null,
      output: '',
      error: 'spawnSync npx.cmd EINVAL',
      summary: parseSummary(''),
      failed: [],
    })
    assert.equal(dead.verdict, 'BROKEN')

    const collapsed = classify(baseline, {
      exitCode: 1,
      output: 'Error: Unknown reporter "basic"',
      error: null,
      summary: parseSummary('Error: Unknown reporter "basic"'),
      failed: [],
    })
    assert.equal(collapsed.verdict, 'KILLED')
  })

  it('SURVIVED requires everything to match the baseline', () => {
    const output = `\n Test Files  9 passed (9)\n      Tests  384 passed (384)\n`
    const verdict = classify(baseline, {
      exitCode: 0,
      output,
      error: null,
      summary: parseSummary(output),
      failed: [],
    })
    assert.equal(verdict.verdict, 'SURVIVED')
  })

  it('a control that collected nothing is not a green control (failure 6)', () => {
    const output = `\n Test Files  0 passed (0)\n      Tests  0 passed (0)\n`
    const judged = judgeControl({ exitCode: 0, output, error: null, summary: parseSummary(output) })
    assert.equal(judged.ok, false)
    assert.match(judged.why, /no test files/)
  })
})

describe('the anchor check', () => {
  it('accepts exactly one match and nothing else', () => {
    assert.equal(checkAnchor('a b a', 'b', 'c').ok, true)
    assert.equal(checkAnchor('a b a', 'a', 'c').ok, false)
    assert.equal(checkAnchor('a b a', 'z', 'c').ok, false)
  })

  it('explains a zero match caused by CRLF (failure 10)', () => {
    const crlf = SOURCE.split('\n').join('\r\n')
    const check = checkAnchor(crlf, "export function label() {\n  return 'gst'", 'x')
    assert.equal(check.ok, false)
    assert.match(check.note, /CRLF/)
  })

  it('explains a zero match caused by reformatting (failure 7)', () => {
    const check = checkAnchor('const a =\n  1', 'const a = 1', 'const a = 2')
    assert.match(check.note, /ignoring whitespace/)
  })

  it('refuses a replacement identical to the anchor, which always survives', () => {
    assert.equal(checkAnchor('a b a', 'b', 'b').ok, false)
  })

  it('counts non-overlapping occurrences', () => {
    assert.equal(countOccurrences('aaaa', 'aa'), 2)
    assert.equal(countOccurrences('abc', ''), 0)
  })
})

describe('a campaign', () => {
  it('reports BROKEN when the CONTROL is killed, and mutates nothing', async () => {
    const root = makeRepo()
    const calls = []
    const report = await runCampaign(planFor(root), {
      out: silence,
      runSuite: (context) => {
        calls.push(context.kind)
        return red()
      },
    })

    assert.equal(report.status, 'BROKEN')
    assert.equal(report.exitCode, 2)
    assert.match(report.reason, /control killed/)
    assert.deepEqual(calls, ['control'], 'it must stop before touching a source file')
    assert.equal(fs.readFileSync(path.join(root, 'thing.ts'), 'utf8'), SOURCE)
  })

  it('reports BROKEN when the CANARY survives, however clean the rest looks', async () => {
    const root = makeRepo()
    const calls = []
    const report = await runCampaign(planFor(root), {
      out: silence,
      runSuite: (context) => {
        calls.push(context.kind)
        return green() // the canary survives — which is the harness failing, not the suite
      },
    })

    assert.equal(report.status, 'BROKEN')
    assert.equal(report.exitCode, 2)
    assert.match(report.reason, /canary SURVIVED/)
    assert.deepEqual(calls, ['control', 'canary'], 'no mutation runs after a live canary')
  })

  it('reports a zero-match anchor as ANCHOR? rather than skipping it', async () => {
    const root = makeRepo()
    const plan = planFor(root)
    plan.mutations = [
      {
        name: 'moved-by-prettier',
        file: path.join(root, 'thing.ts'),
        anchor: 'export const RATE =\n  18',
        replace: 'export const RATE = 5',
        note: null,
      },
    ]

    const report = await runCampaign(plan, {
      out: silence,
      runSuite: (context) => (context.kind === 'control' ? green() : red()),
    })

    const result = report.results.find((entry) => entry.name === 'moved-by-prettier')
    assert.ok(result, 'the mutation must appear in the report, not vanish from it')
    assert.equal(result.verdict, 'ANCHOR?')
    assert.match(result.reason, /matched 0x/)
    assert.equal(report.status, 'BROKEN')
    assert.equal(report.exitCode, 2)
  })

  it('refuses to start when a snapshot from an earlier run is still on disk', async () => {
    const root = makeRepo()
    const plan = planFor(root)

    /* Exactly the state an interrupted run leaves: a snapshot of the pristine file, and
     * a source file still carrying the mutation. */
    const store = snapshotStore(plan.snapshotDir)
    store.take([path.join(root, 'thing.ts')])
    fs.writeFileSync(path.join(root, 'thing.ts'), SOURCE.replace('18', '99'), 'utf8')

    let ran = 0
    const report = await runCampaign(plan, {
      out: silence,
      runSuite: () => {
        ran += 1
        return green()
      },
    })

    assert.equal(report.status, 'BROKEN')
    assert.equal(report.exitCode, 2)
    assert.equal(report.reason, 'leftover snapshot')
    assert.equal(ran, 0)
    /* And it must not have overwritten the snapshot with the mutated file: the original
     * is still recoverable, which is the whole reason it refused. */
    assert.deepEqual(
      store.verify().map((entry) => entry.identical),
      [false],
    )
    store.restore()
    assert.equal(fs.readFileSync(path.join(root, 'thing.ts'), 'utf8'), SOURCE)
  })

  it('restores the source byte-for-byte after an exception mid-campaign', async () => {
    const root = makeRepo()
    const plan = planFor(root)
    const before = fs.readFileSync(path.join(root, 'thing.ts'))

    await assert.rejects(
      runCampaign(plan, {
        out: silence,
        runSuite: (context) => {
          if (context.kind === 'control') return green()
          throw new Error('the machine caught fire')
        },
      }),
      /caught fire/,
    )

    assert.deepEqual(fs.readFileSync(path.join(root, 'thing.ts')), before)
    assert.equal(fs.existsSync(plan.snapshotDir), false, 'the snapshot is cleared once restored')
  })

  it('reports KILLED and SURVIVED per mutation, and verifies the source afterwards', async () => {
    const root = makeRepo()
    const plan = planFor(root)
    plan.mutations = [
      { name: 'seen', file: path.join(root, 'thing.ts'), anchor: "'gst'", replace: "'vat'" },
      { name: 'unseen', file: path.join(root, 'thing.ts'), anchor: 'label', replace: 'name' },
    ]

    const report = await runCampaign(plan, {
      out: silence,
      runSuite: (context) =>
        context.kind === 'control' || context.name === 'unseen' ? green() : red(),
    })

    const verdicts = Object.fromEntries(report.results.map((r) => [r.name, r.verdict]))
    assert.equal(verdicts.canary, 'KILLED')
    assert.equal(verdicts.seen, 'KILLED')
    assert.equal(verdicts.unseen, 'SURVIVED')
    assert.equal(report.status, 'SURVIVED')
    assert.equal(report.exitCode, 1)
    assert.equal(fs.readFileSync(path.join(root, 'thing.ts'), 'utf8'), SOURCE)
    assert.equal(fs.existsSync(plan.snapshotDir), false)
  })

  it('says which test files died', async () => {
    const root = makeRepo()
    const report = await runCampaign(planFor(root), {
      out: silence,
      runSuite: (context) => (context.kind === 'control' ? green() : red()),
    })
    const canary = report.results.find((entry) => entry.kind === 'canary')
    assert.deepEqual(canary.failed, ['thing.test.ts'])
  })

  it('calls a run with no canary and no kill BROKEN, not clean', async () => {
    const root = makeRepo()
    const plan = planFor(root, { canary: null })

    const report = await runCampaign(plan, { out: silence, runSuite: () => green() })

    assert.equal(report.status, 'BROKEN')
    assert.equal(report.exitCode, 2)
  })
})

describe('paths', () => {
  it('upper-cases a Windows drive letter, which vitest treats as a different root', () => {
    if (process.platform !== 'win32') return
    assert.equal(normalisePath('d:/local-erp/coffer'), normalisePath('D:/local-erp/coffer'))
    assert.match(normalisePath('d:/local-erp/coffer'), /^D:/)
  })
})
