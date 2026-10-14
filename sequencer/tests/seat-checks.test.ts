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
import { checked } from '../seat.ts'

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
  expect(checked(db, plan, paykit(), DIFF + KOTLIN)).toEqual({ checks: `${RUBY}\n\nNo gate ran for:\n- kotlin/src/Runner.kt` })
  const npm = paykit()
  writeFileSync(join(npm, 'package.json'), '{}')
  expect(checked(db, { ...plan, origin: 'https://github.com/acme/kit/issues/1' }, npm, DIFF + KOTLIN)).toEqual({
    checks: '- typescript | . | every script the checkout names (npm, the whole suite) | pass\n\nNo gate ran for:\n- ruby/lib/pay_kit/config.rb\n- kotlin/src/Runner.kt',
  })
})

test('D2 outside reviewer told its language gates ran', () => {
  const { db, plan } = target(['ruby/lib/pay_kit/config.rb'])
  expect(checked(db, plan, paykit(), DIFF)).toEqual({ checks: RUBY })
})

test('D3 no pass on this diff, or mode none, lists no gate', () => {
  const red = target(['ruby/lib/pay_kit/config.rb'], 'refuse')
  expect(checked(red.db, red.plan, paykit(), DIFF)).toEqual({ checks: UNGATED })
  const { db, plan } = target(['ruby/lib/pay_kit/config.rb'], 'pass', `${DIFF}+y\n`)
  expect(checked(db, plan, paykit(), DIFF)).toEqual({ checks: UNGATED })
  const ours = target(['ruby/lib/pay_kit/config.rb'])
  expect(checked(ours.db, { ...ours.plan, origin: 'https://github.com/acme/kit/issues/1' }, paykit(), DIFF)).toEqual({ checks: UNGATED })
})

const LEAK = '--- a/tests/test_smoke_leak.py\n+++ b/tests/test_smoke_leak.py\n@@ -1,1 +1,1 @@\n+x\n'

test('1181a D4 a green fuzz-bench plan lists its python gates', () => {
  const { db, plan } = target(['smoke/check_leak.py', 'tests/test_smoke_leak.py'], 'pass', LEAK)
  const src = mkdtempSync(join(tmpdir(), 'cf-note-'))
  mkdirSync(join(src, 'tests'))
  writeFileSync(join(src, 'tests', 'test_smoke_leak.py'), '')
  const bench: PlanRow = { ...plan, target_id: null, lane: 'bench', seat: 'solidity_specialist', origin: 'https://github.com/caliperforge/fuzz-bench/issues/1' }
  const env = 'uv run --no-project --with ruff --with pyright --with pytest'
  expect(checked(db, bench, src, LEAK)).toEqual({ checks: ['ruff check', 'pyright', 'python -m pytest']
    .map((c) => `- python | . | ${env} ${c} tests/test_smoke_leak.py | pass`).join('\n') })
})

test('D6 no seat language and no gate, no section', () => {
  const { db, plan } = target(['docs/paykit-interface.md'])
  expect(checked(db, plan, paykit(), '--- a/docs/paykit-interface.md\n+++ b/docs/paykit-interface.md\n@@ -1,1 +1,1 @@\n+x\n')).toEqual({})
})
