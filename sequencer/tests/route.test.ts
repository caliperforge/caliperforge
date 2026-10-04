import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { authority } from '../../rails/authority/index.ts'
import { record } from '../../store/files.ts'
import type { Db } from '../../store/index.ts'
import { PlanRow } from '../../store/plans.ts'
import { builder, languageOfSeat } from '../../templates/pr-path.ts'
import { BRIEF_FILES, fenceFor, languageFor, languageOfPath, majority } from '../route.ts'

const schema = join(import.meta.dirname, '../../schema')

/** A stranger's monorepo: it has a kotlin/ folder whatever the job touches. */
function monorepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-route-'))
  mkdirSync(join(dir, 'kotlin'))
  return dir
}

function world(): { db: Db; target: PlanRow; ours: PlanRow; hooks: PlanRow } {
  const db = fresh(schema)
  db.prepare(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge,
    open_pr_age_p50_days, cross_repo_activity, pulse, evidence)
    VALUES (1, 'acme/kit', '2026-09-21', 2, 1, '2026-09-21', 3, 4, 'warm', 'https://github.com/acme/kit')`).run()
  db.prepare(`INSERT INTO targets (id, account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (1, 1, 'acme/kit', 166, 'ludo', 'ready', '2026-09-21', 'https://github.com/acme/kit/issues/166')`).run()
  db.prepare(`INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at) VALUES (1, 1, 1, 'pr_path', 'running', '2026-09-21')`).run()
  db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin)
    VALUES (2, 1, 'pr_path', 'running', '2026-09-21', 'machine', 'typescript_specialist', 'https://github.com/caliperforge/caliperforge/issues/1')`).run()
  db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin)
    VALUES (3, 1, 'pr_path', 'running', '2026-09-21', 'uniswap', 'python_specialist', 'https://github.com/caliperforge/v4-hook-index/issues/1')`).run()
  const row = (id: number): PlanRow => PlanRow.parse(db.prepare('SELECT * FROM plans WHERE id = ?').get(id))
  return { db, target: row(1), ours: row(2), hooks: row(3) }
}

const listed = (paths: string[]) => paths.map((path) => ({ path, is_new: false }))

test('a ruby and lua tie beside kotlin/ picks the first listed', () => {
  const w = world()
  record(w.db, 1, listed(['ruby/lib/pay_kit/config.rb', 'lua/pay_kit/internal/config.lua']))
  expect(builder(languageFor(w.db, w.target, monorepo()))).toBe('ruby_specialist')
})

test('ruby source, its test and a doc go to the ruby seat', () => {
  const w = world()
  record(w.db, 1, listed(['ruby/lib/pay_kit/config.rb', 'docs/paykit-interface.md', 'ruby/test/pay_kit/config_test.rb']))
  expect(builder(languageFor(w.db, w.target, monorepo()))).toBe('ruby_specialist')
})

test('rust with ts-rs output beside it goes to the rust seat', () => {
  const w = world()
  record(w.db, 1, listed(['crates/types/src/types.rs', 'crates/core/src/types.rs', 'crates/core/src/rpc/surfnet_cheatcodes.rs',
    'crates/sdk-node/surfpool-sdk/kit/types/api.ts', 'crates/sdk-node/surfpool-sdk/kit/generated/methods.ts',
    'crates/sdk-node/surfpool-sdk/kit/generated/index.ts', 'crates/sdk-node/surfpool-sdk/kit/generated/MintUpdate.ts']))
  expect(builder(languageFor(w.db, w.target, monorepo()))).toBe('rust_specialist')
})

test('docs only or a seatless language falls to the outside seat', () => {
  const w = world()
  record(w.db, 1, listed(['docs/paykit-interface.md', 'README.md']))
  expect(builder(languageFor(w.db, w.target, monorepo()))).toBe('outside_specialist')
  record(w.db, 1, listed(['typescript/packages/mpp/src/config.ts']))
  expect(builder(languageFor(w.db, w.target, monorepo()))).toBe('outside_specialist')
})

test('the most non-test files win; tests count only when alone', () => {
  expect(majority(['python/tests/test_config.py', 'python/tests/test_env.py', 'go/config.go'])).toBe('go')
  expect(majority(['ruby/test/pay_kit/config_test.rb'])).toBe('ruby')
  expect(majority(['go/a.go', 'php/src/A.php', 'php/src/B.php'])).toBe('php')
  expect(majority(['lua/pay_kit/a.lua', 'go/a.go'])).toBe('lua')
  expect(majority(['swift/Tests/A/B.swift', 'swift/Tests/A/C.swift', 'go/a.go'])).toBe('go')
})

test('a path reads by name, then folder; docs and fixtures by none', () => {
  expect(['crates/x/Cargo.toml', 'python/pyproject.toml', 'ruby/Gemfile', 'go/go.mod', 'php/composer.json', 'lua/pay-kit-dev-1.rockspec']
    .map(languageOfPath)).toEqual(['rust', 'python', 'ruby', 'go', 'php', 'lua'])
  expect(languageOfPath('programs/escrow/Xargo.toml')).toBe('rust')
  expect(languageOfPath('go/testdata/vector.json')).toBeNull()
  expect(languageOfPath('ruby/README.md')).toBeNull()
})

test('a change wholly under kotlin/ still goes to the kotlin seat', () => {
  const w = world()
  record(w.db, 1, [{ path: 'kotlin/src/main/kotlin/Types.kt', is_new: false }])
  expect(builder(languageFor(w.db, w.target, monorepo()))).toBe('kotlin_specialist')
})

test('D5 kotlin beside a doc and swift get their own seats', () => {
  const w = world()
  record(w.db, 1, listed(['kotlin/runner/src/main/kotlin/Main.kt', 'README.md']))
  expect(builder(languageFor(w.db, w.target, monorepo()))).toBe('kotlin_specialist')
  record(w.db, 1, listed(['swift/Sources/PayKit/Memo.swift']))
  expect(builder(languageFor(w.db, w.target, monorepo()))).toBe('swift_specialist')
  expect(['kotlin/build.gradle.kts', 'swift/Package.swift'].map(languageOfPath)).toEqual(['kotlin', 'swift'])
})

test('our own plans stay with the typescript seat', () => {
  const w = world()
  expect(builder(languageFor(w.db, w.ours, monorepo()))).toBe('typescript_specialist')
})

test('an empty repo of ours goes to the plan\'s seat', () => {
  const w = world()
  const empty = mkdtempSync(join(tmpdir(), 'cf-route-'))
  expect(builder(languageFor(w.db, w.hooks, empty))).toBe('python_specialist')
  expect(languageFor(w.db, w.hooks, empty, false)).toBeNull()
})

test('our repo with a language goes by tree, not the plan\'s seat', () => {
  const w = world()
  const dir = mkdtempSync(join(tmpdir(), 'cf-route-'))
  writeFileSync(join(dir, 'Cargo.toml'), '')
  expect(builder(languageFor(w.db, w.hooks, dir))).toBe('rust_specialist')
})

test('our empty repo with no seat falls to the default builder', () => {
  const w = world()
  expect(builder(languageFor(w.db, { ...w.hooks, seat: null }, mkdtempSync(join(tmpdir(), 'cf-route-'))))).toBe('typescript_specialist')
})

test('a seat no language builds with has no language', () => {
  expect(languageOfSeat('brief_writer')).toBeNull()
  expect(languageOfSeat(null)).toBeNull()
  expect(languageOfSeat('python_specialist')).toBe('python')
  expect(languageOfSeat('web_specialist')).toBe('web')
})

test('the brief-files fence is the brief; any other, the manifest', () => {
  const w = world()
  record(w.db, 1, [{ path: 'ruby/lib/pay_kit/config.rb', is_new: false }])
  expect(fenceFor(w.db, 1, [BRIEF_FILES])).toEqual(['ruby/lib/pay_kit/config.rb'])
  expect(fenceFor(w.db, 2, ['kotlin'])).toEqual(['kotlin'])
})

const SWIFT = ['Atelier', 'AtelierTests', 'Atelier.xcodeproj', 'swift']

test('D1 an outside plan fences kotlin and swift to the brief', () => {
  const w = world()
  record(w.db, 1, listed(['harness/protocol-runners/kotlin.json']))
  expect(fenceFor(w.db, 1, ['kotlin'])).toEqual(['harness/protocol-runners/kotlin.json'])
  record(w.db, 1, listed(['Package.swift']))
  expect(fenceFor(w.db, 1, SWIFT)).toEqual(['Package.swift'])
})

test('D2 an internal plan keeps the manifest\'s fence', () => {
  const w = world()
  expect(fenceFor(w.db, 2, ['kotlin'])).toEqual(['kotlin'])
  expect(fenceFor(w.db, 2, SWIFT)).toEqual(SWIFT)
})

test('D3 an empty manifest stays empty on an outside plan', () => {
  const w = world()
  record(w.db, 1, listed(['Package.swift']))
  expect(fenceFor(w.db, 1, [])).toEqual([])
})

test('D4 authority refuses an unlisted kotlin/ path', () => {
  const w = world()
  record(w.db, 1, listed(['harness/protocol-runners/kotlin.json']))
  const hunk = (path: string) => `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n+x\n`
  const root = join(import.meta.dirname, '../..')
  expect(authority(root, 'kotlin_specialist', hunk('kotlin/Other.kt'), false, fenceFor(w.db, 1, ['kotlin'])))
    .toMatchObject({ outcome: 'refuse', spans: ['kotlin/Other.kt:1 authority.write_paths'] })
})
