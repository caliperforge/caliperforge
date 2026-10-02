import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { record } from '../../store/files.ts'
import type { Db } from '../../store/index.ts'
import { PlanRow } from '../../store/plans.ts'
import { checked } from '../seat.ts'

const DIFF = '--- a/ruby/lib/pay_kit/config.rb\n+++ b/ruby/lib/pay_kit/config.rb\n@@ -1,1 +1,1 @@\n+x\n'

function target(paths: string[], outcome = 'pass', diff = DIFF): { db: Db; plan: PlanRow } {
  const db = fresh(join(import.meta.dirname, '../../schema'))
  db.prepare(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge,
    open_pr_age_p50_days, cross_repo_activity, pulse, evidence)
    VALUES (1, 'acme/kit', '2026-09-24', 2, 1, '2026-09-24', 3, 4, 'warm', 'https://github.com/acme/kit')`).run()
  db.prepare(`INSERT INTO targets (id, account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (1, 1, 'acme/kit', 166, 'ludo', 'ready', '2026-09-24', 'https://github.com/acme/kit/issues/166')`).run()
  db.prepare(`INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at) VALUES (1, 1, 1, 'pr_path', 'running', '2026-09-24')`).run()
  record(db, 1, paths.map((path) => ({ path, is_new: false })))
  db.prepare(`INSERT INTO rules (id, kind, path, content_hash, loaded_at) VALUES ('checks', 'rail', 'rules/rails.yaml', ?, '2026-09-24')`).run('a'.repeat(64))
  db.prepare(`INSERT INTO verdicts (gate, kind, subject_digest, plan, step, outcome, rail_id, origin_kind, origin_ref, tokens, seconds)
    VALUES ('pre_review', 'rail', ?, 1, 3, ?, 'checks', 'rail', 'checks', 0, 0)`).run(createHash('sha256').update(diff).digest('hex'), outcome)
  return { db, plan: PlanRow.parse(db.prepare('SELECT * FROM plans WHERE id = 1').get()) }
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

test('D6 no seat language and no gate, no section', () => {
  const { db, plan } = target(['docs/paykit-interface.md'])
  expect(checked(db, plan, paykit(), '--- a/docs/paykit-interface.md\n+++ b/docs/paykit-interface.md\n@@ -1,1 +1,1 @@\n+x\n')).toEqual({})
})
