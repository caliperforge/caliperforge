import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { record } from '../../store/files.ts'
import type { Db } from '../../store/index.ts'
import { PlanRow } from '../../store/plans.ts'
import { builder } from '../../templates/pr-path.ts'
import { BRIEF_FILES, fenceFor, languageFor } from '../route.ts'

const schema = join(import.meta.dirname, '../../schema')

/** A stranger's monorepo: it has a kotlin/ folder whatever the job touches. */
function monorepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-route-'))
  mkdirSync(join(dir, 'kotlin'))
  return dir
}

function world(): { db: Db; target: PlanRow; ours: PlanRow } {
  const db = fresh(schema)
  db.prepare(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge,
    open_pr_age_p50_days, cross_repo_activity, pulse, evidence)
    VALUES (1, 'acme/kit', '2026-09-21', 2, 1, '2026-09-21', 3, 4, 'warm', 'https://github.com/acme/kit')`).run()
  db.prepare(`INSERT INTO targets (id, account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (1, 1, 'acme/kit', 166, 'ludo', 'ready', '2026-09-21', 'https://github.com/acme/kit/issues/166')`).run()
  db.prepare(`INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at) VALUES (1, 1, 1, 'pr_path', 'running', '2026-09-21')`).run()
  db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin)
    VALUES (2, 1, 'pr_path', 'running', '2026-09-21', 'machine', 'typescript_specialist', 'https://github.com/caliperforge/caliperforge/issues/1')`).run()
  const row = (id: number): PlanRow => PlanRow.parse(db.prepare('SELECT * FROM plans WHERE id = ?').get(id))
  return { db, target: row(1), ours: row(2) }
}

test('a ruby and lua change in a repo with a kotlin folder goes to the outside seat', () => {
  const w = world()
  record(w.db, 1, [{ path: 'ruby/lib/pay_kit/config.rb', is_new: false }, { path: 'lua/pay_kit/internal/config.lua', is_new: false }])
  expect(builder(languageFor(w.db, w.target, monorepo()))).toBe('outside_specialist')
})

test('a change wholly under kotlin/ still goes to the kotlin seat', () => {
  const w = world()
  record(w.db, 1, [{ path: 'kotlin/src/main/kotlin/Types.kt', is_new: false }])
  expect(builder(languageFor(w.db, w.target, monorepo()))).toBe('kotlin_specialist')
})

test('our own plans stay with the typescript seat', () => {
  const w = world()
  expect(builder(languageFor(w.db, w.ours, monorepo()))).toBe('typescript_specialist')
})

test('the brief-files fence is the brief\'s paths; any other fence is the manifest\'s', () => {
  const w = world()
  record(w.db, 1, [{ path: 'ruby/lib/pay_kit/config.rb', is_new: false }])
  expect(fenceFor(w.db, 1, [BRIEF_FILES])).toEqual(['ruby/lib/pay_kit/config.rb'])
  expect(fenceFor(w.db, 1, ['kotlin'])).toEqual(['kotlin'])
})
