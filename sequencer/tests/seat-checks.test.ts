import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { record as rail } from '../../rails/record.ts'
import { record } from '../../store/files.ts'
import { addRule, type Db } from '../../store/index.ts'
import { planById, putPlan, type PlanRow } from '../../store/plans.ts'
import { addAccount, addTarget } from '../../store/targets.ts'
import type { Verdict } from '../../store/verdict.ts'
import type { Ran } from '../checks.ts'
import { live } from '../live.ts'
import { checked } from '../seat.ts'
import { srcDir } from '../workspace.ts'

const REPO = join(import.meta.dirname, '../..')

const DIFF = '--- a/ruby/lib/pay_kit/config.rb\n+++ b/ruby/lib/pay_kit/config.rb\n@@ -1,1 +1,1 @@\n+x\n'

function target(paths: string[], outcome: Verdict['outcome'] = 'pass', diff = DIFF): { db: Db; plan: PlanRow } {
  const db = fresh(join(import.meta.dirname, '../../schema'))
  addAccount(db, { id: 1, repo: 'acme/kit', measured_at: '2026-09-24', maintainers: 2, doors: 1, last_outsider_merge: '2026-09-24',
    open_pr_age_p50_days: 3, cross_repo_activity: 4, pulse: 'warm', evidence: 'https://github.com/acme/kit' })
  addTarget(db, { account_id: 1, repo: 'acme/kit', issue_no: 166, named_merger: 'ludo', state: 'ready',
    evidence_measured_at: '2026-09-24', evidence: 'https://github.com/acme/kit/issues/166' })
  putPlan(db, { id: 1, pipe_id: 1, target_id: 1, template: 'pr_path', state: 'running', queued_at: '2026-09-24', step: 0, retries: 0 })
  record(db, 1, paths.map((path) => ({ path, is_new: false })))
  addRule(db, { id: 'checks', kind: 'rail', path: 'rules/rails.yaml', content_hash: 'a'.repeat(64), loaded_at: '2026-09-24' })
  rail(db, join(import.meta.dirname, '../../rails/checks'), 1, { outcome, subject_digest: createHash('sha256').update(diff).digest('hex'),
    spans: [], origin_kind: 'rail', origin_ref: 'checks', message: '', defect_class: null }, 0)
  return { db, plan: planById(db, 1) }
}

function paykit(): string {
  const src = mkdtempSync(join(tmpdir(), 'cf-note-'))
  mkdirSync(join(src, 'ruby'))
  writeFileSync(join(src, 'ruby', 'Justfile'), 'install:\n    bundle install\n\nlint:\n    bundle exec standardrb\n\ntest:\n    x\n')
  return src
}

const KOTLIN = '--- a/kotlin/src/Runner.kt\n+++ b/kotlin/src/Runner.kt\n@@ -1,1 +1,1 @@\n+x\n'

const RUBY = ['install', 'lint', 'test'].map((r) => `- ruby | ruby | just --justfile Justfile ${r} | pass`).join('\n')

const UNGATED = '- none\n\nNo gate ran for:\n- ruby/lib/pay_kit/config.rb'

test('D1 a path no gate ran under is listed after the gates', () => {
  const { db, plan } = target(['ruby/lib/pay_kit/config.rb', 'kotlin/src/Runner.kt'], 'pass', DIFF + KOTLIN)
  expect(checked(db, REPO, plan, paykit(), DIFF + KOTLIN)).toEqual({ checks: `${RUBY}\n\nNo gate ran for:\n- kotlin/src/Runner.kt` })
  const npm = paykit()
  writeFileSync(join(npm, 'package.json'), '{}')
  expect(checked(db, REPO, { ...plan, origin: 'https://github.com/acme/kit/issues/1' }, npm, DIFF + KOTLIN)).toEqual({
    checks: '- typescript | . | every script the checkout names (npm, the whole suite) | pass\n\nNo gate ran for:\n- ruby/lib/pay_kit/config.rb\n- kotlin/src/Runner.kt',
  })
})

test('D2 outside reviewer told its language gates ran', () => {
  const { db, plan } = target(['ruby/lib/pay_kit/config.rb'])
  expect(checked(db, REPO, plan, paykit(), DIFF)).toEqual({ checks: RUBY })
})

test('D3 no pass on this diff lists no gate; mode none gates', () => {
  const red = target(['ruby/lib/pay_kit/config.rb'], 'refuse')
  expect(checked(red.db, REPO, red.plan, paykit(), DIFF)).toEqual({ checks: UNGATED })
  const { db, plan } = target(['ruby/lib/pay_kit/config.rb'], 'pass', `${DIFF}+y\n`)
  expect(checked(db, REPO, plan, paykit(), DIFF)).toEqual({ checks: UNGATED })
  const ours = target(['ruby/lib/pay_kit/config.rb'])
  expect(checked(ours.db, REPO, { ...ours.plan, origin: 'https://github.com/acme/kit/issues/1' }, paykit(), DIFF)).toEqual({ checks: RUBY })
})

const LEAK = '--- a/tests/test_smoke_leak.py\n+++ b/tests/test_smoke_leak.py\n@@ -1,1 +1,1 @@\n+x\n'

/** A fuzz-bench plan whose last `checks` row is `outcome` on the LEAK diff, and its checkout. */
function bench(outcome: Verdict['outcome']): { db: Db; plan: PlanRow; src: string } {
  const { db, plan } = target(['smoke/check_leak.py', 'tests/test_smoke_leak.py'], outcome, LEAK)
  const src = mkdtempSync(join(tmpdir(), 'cf-note-'))
  mkdirSync(join(src, 'tests'))
  writeFileSync(join(src, 'tests', 'test_smoke_leak.py'), '')
  return { db, src, plan: { ...plan, target_id: null, lane: 'bench', seat: 'solidity_specialist', origin: 'https://github.com/caliperforge/fuzz-bench/issues/1' } }
}

const FORGE = '- solidity | . | forge build | pass\n- solidity | . | forge test | pass\n- python | . | python3 -m pytest -m not live tests/test_smoke_leak.py | pass'

const PAIR = '- finish | . | python3 bench/run_pair.py targets/euler-earn-m01.yml suites/euler-m01'

test('1181a D4 a green fuzz-bench plan lists its python gates', () => {
  const { db, plan, src } = bench('pass')
  expect(checked(db, REPO, plan, src, LEAK)).toEqual({ checks: `${FORGE}\n${PAIR} | skipped` })
})

test('1225 D7 the finish row passes once run_pair.py is there', () => {
  const { db, plan, src } = bench('pass')
  mkdirSync(join(src, 'bench'))
  writeFileSync(join(src, 'bench', 'run_pair.py'), '')
  expect(checked(db, REPO, plan, src, LEAK)).toEqual({ checks: `${FORGE}\n${PAIR} | pass` })
})

test('1181b D4 a red-rail bench plan lists no finish row', () => {
  const { db, plan, src } = bench('refuse')
  expect(checked(db, REPO, plan, src, LEAK)).toEqual({ checks: '- none\n\nNo gate ran for:\n- tests/test_smoke_leak.py' })
})

const SCRIPT = '--- a/main.ts\n+++ b/main.ts\n@@ -1,1 +1,1 @@\n+x\n'

test('1156b D7 a green site plan lists its tsc gate', () => {
  const { db, plan } = target(['main.ts'], 'pass', SCRIPT)
  const src = mkdtempSync(join(tmpdir(), 'cf-note-'))
  writeFileSync(join(src, 'tsconfig.json'), '{}')
  const site: PlanRow = { ...plan, target_id: null, lane: 'site', seat: 'web_specialist', origin: 'https://github.com/caliperforge/site/issues/1' }
  expect(checked(db, REPO, site, src, SCRIPT)).toEqual({ checks: '- typescript | . | npm exec --no -- tsc --noEmit | pass' })
})

const CHARTS = '--- a/charts.js\n+++ b/charts.js\n@@ -1,1 +1,1 @@\n+x\n'

test('1333 D5 a green site plan lists its node --test gate', () => {
  const { db, plan } = target(['charts.js'], 'pass', CHARTS)
  const src = mkdtempSync(join(tmpdir(), 'cf-note-'))
  mkdirSync(join(src, 'tests'))
  writeFileSync(join(src, 'tests', 'charts.test.js'), '')
  const site: PlanRow = { ...plan, target_id: null, lane: 'site', seat: 'web_specialist', origin: 'https://github.com/caliperforge/site/issues/1' }
  expect(checked(db, REPO, site, src, CHARTS)).toEqual({ checks: '- web | . | node --test tests/charts.test.js | pass' })
})

const PY = '--- a/tools/x/a.py\n+++ b/tools/x/a.py\n@@ -1,1 +1,1 @@\n+x\n'

const UV = ['sync --all-extras', 'tool run ruff check', 'run --with pyright pyright', 'run --no-sync pytest'].map((c) => `- python | tools/x | uv ${c} | pass`)

test('1898 D5 a python-only kernel plan lists no npm tests', () => {
  const { db, plan } = target(['tools/x/a.py'], 'pass', PY)
  const src = mkdtempSync(join(tmpdir(), 'cf-note-'))
  mkdirSync(join(src, 'tools', 'x'), { recursive: true })
  writeFileSync(join(src, 'package.json'), '{}')
  writeFileSync(join(src, 'tools', 'x', 'pyproject.toml'), '')
  writeFileSync(join(src, 'tools', 'x', 'a.py'), '')
  const kernel = { ...plan, target_id: null, origin: 'https://github.com/caliperforge/caliperforge/issues/1' }
  expect(checked(db, REPO, kernel, src, PY)).toEqual({
    checks: ['- typescript | . | every script the checkout names (npm, no tests: the diff sits in its python subprojects) | pass', ...UV].join('\n'),
  })
})

const LIVE = 'tools/a.test.ts'

const TS = `--- a/${LIVE}\n+++ b/${LIVE}\n@@ -1,1 +1,1 @@\n+x\n`

/** A green kernel plan on TS with its gated test in the checkout, the step 3 rows, and a live run of `diff` that returned `ran`. */
function lives(ran: Ran, diff = TS): { db: Db; root: string; plan: PlanRow; src: string; rows: string | undefined } {
  const { db, plan } = target([LIVE], 'pass', TS)
  const root = mkdtempSync(join(tmpdir(), 'cf-live-'))
  const src = srcDir(root, 1)
  writeFileSync(join(src, 'package.json'), '{}')
  mkdirSync(join(src, 'tools'))
  writeFileSync(join(src, LIVE), "test.runIf(process.env.CF_BENCH_LIVE === '1')('x', () => {})\n")
  const kernel = { ...plan, target_id: null, origin: 'https://github.com/caliperforge/caliperforge/issues/1' }
  const rows = checked(db, root, kernel, src, TS).checks
  live(root, kernel, diff, () => ran)
  return { db, root, plan: kernel, src, rows }
}

const COMMAND = `CF_BENCH_LIVE=1 npm exec -- vitest run ${LIVE}`

test('2022 D2 a green live run is listed after the step 3 rows', () => {
  const { db, root, plan, src, rows } = lives({ ok: true, output: 'green' })
  expect(checked(db, root, plan, src, TS)).toEqual({ checks: `${String(rows)}\n- live | . | ${COMMAND} | pass` })
})

test('2022 D3 a capped live run fails with its last 80 lines', () => {
  const output = [...Array(100).keys()].map((i) => `line ${String(i)}`)
  const { db, root, plan, src, rows } = lives({ ok: false, code: '1', output: output.join('\n'), capped: true })
  expect(checked(db, root, plan, src, TS)).toEqual({
    checks: `${String(rows)}\n- live | . | ${COMMAND} | fail\n\nLive run output:\n\n${output.slice(-80).join('\n')}`,
  })
})

test('2022 D6 a live run of another diff adds no row', () => {
  const { db, root, plan, src, rows } = lives({ ok: true, output: 'green' }, `${TS}+y\n`)
  expect(checked(db, root, plan, src, TS)).toEqual({ checks: rows })
})

test('D6 no seat language and no gate, no section', () => {
  const { db, plan } = target(['docs/paykit-interface.md'])
  expect(checked(db, REPO, plan, paykit(), '--- a/docs/paykit-interface.md\n+++ b/docs/paykit-interface.md\n@@ -1,1 +1,1 @@\n+x\n')).toEqual({})
})
