import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { authority } from '../../rails/authority/index.ts'
import { refuse } from '../../runner/index.ts'
import { record } from '../../store/files.ts'
import type { Db } from '../../store/index.ts'
import { planById, putPlan, type PlanRow } from '../../store/plans.ts'
import { addAccount, putTarget } from '../../store/targets.ts'
import { at, builder, languageOfSeat } from '../../templates/pr-path.ts'
import { BRIEF_FILES, fenceFor, languageFor, languageOfPath, languageOfSpan, majority } from '../route.ts'

const schema = join(import.meta.dirname, '../../schema')

/** A stranger's monorepo: it has a kotlin/ folder whatever the job touches. */
function monorepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-route-'))
  mkdirSync(join(dir, 'kotlin'))
  return dir
}

function world(): { db: Db; target: PlanRow; ours: PlanRow; hooks: PlanRow; web: PlanRow } {
  const db = fresh(schema)
  addAccount(db, { id: 1, repo: 'acme/kit', measured_at: '2026-09-21', maintainers: 2, doors: 1, last_outsider_merge: '2026-09-21',
    open_pr_age_p50_days: 3, cross_repo_activity: 4, pulse: 'warm', evidence: 'https://github.com/acme/kit' })
  putTarget(db, { id: 1, account_id: 1, repo: 'acme/kit', issue_no: 166, named_merger: 'ludo', state: 'ready',
    evidence_measured_at: '2026-09-21', evidence: 'https://github.com/acme/kit/issues/166' })
  const running = { pipe_id: 1, target_id: null, template: 'pr_path', state: 'running', queued_at: '2026-09-21', step: 0, retries: 0 } as const
  putPlan(db, { ...running, id: 1, target_id: 1 })
  putPlan(db, { ...running, id: 2, lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/caliperforge/issues/1' })
  putPlan(db, { ...running, id: 3, lane: 'uniswap', seat: 'python_specialist', origin: 'https://github.com/caliperforge/v4-hook-index/issues/1' })
  putPlan(db, { ...running, id: 4, lane: 'atelier', seat: 'swift_specialist', origin: 'https://github.com/caliperforge/atelier-web/issues/1' })
  const row = (id: number): PlanRow => planById(db, id)
  return { db, target: row(1), ours: row(2), hooks: row(3), web: row(4) }
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
    .map((path) => languageOfPath(path))).toEqual(['rust', 'python', 'ruby', 'go', 'php', 'lua'])
  expect(languageOfPath('programs/escrow/Xargo.toml')).toBe('rust')
  expect(languageOfPath('go/testdata/vector.json')).toBeNull()
  expect(languageOfPath('ruby/README.md')).toBeNull()
})

test('D5 a span reads by its path, TypeScript included', () => {
  expect(['swift/Sources/x.swift:10', 'x.test.ts a lap (timeout)', 'checks:test', 'base:stale', 'text:12', 'step-2.handback.md']
    .map(languageOfSpan)).toEqual(['swift', 'typescript', null, null, null, null])
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
  expect(['kotlin/build.gradle.kts', 'swift/Package.swift'].map((path) => languageOfPath(path))).toEqual(['kotlin', 'swift'])
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

test('760b D2 an atelier-web plan on app.js builds on web', () => {
  const w = world()
  record(w.db, 4, listed(['public/app.js']))
  const language = languageFor(w.db, w.web, mkdtempSync(join(tmpdir(), 'cf-route-')))
  expect(language).toBe('web')
  expect([at(2, language).runs, at(4, language).seat]).toEqual(['web_specialist', 'web_specialist'])
})

test('1108a D3 a design_lead plan on DESIGN.md builds on web', () => {
  const w = world()
  record(w.db, 4, listed(['DESIGN.md', 'design/tickets/a.md']))
  expect(languageFor(w.db, { ...w.web, seat: 'design_lead' }, mkdtempSync(join(tmpdir(), 'cf-route-')))).toBe('web')
})

test('760b D3 web paths stay unclaimed outside atelier-web', () => {
  const w = world()
  expect(languageOfPath('public/app.js')).toBeNull()
  record(w.db, 1, listed(['public/app.js', 'index.html']))
  expect(builder(languageFor(w.db, w.target, monorepo()))).toBe('outside_specialist')
  record(w.db, 3, listed(['public/app.js']))
  expect(builder(languageFor(w.db, w.hooks, mkdtempSync(join(tmpdir(), 'cf-route-'))))).toBe('python_specialist')
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

test('1033 D1 D2 a listed test admits its test folder only', () => {
  const w = world()
  record(w.db, 1, listed(['python/src/pkg/config.py', 'python/tests/test_allowlist.py']))
  const fence = fenceFor(w.db, 1, [BRIEF_FILES])
  expect(fence).toEqual(['python/src/pkg/config.py', 'python/tests/test_allowlist.py', 'python/tests'])
  const src = mkdtempSync(join(tmpdir(), 'cf-route-'))
  expect(refuse(src, fence, 'python/tests/allowlist_generator.py')).toBeNull()
  for (const path of ['python/conftest.py', 'python/src/pkg/other.py']) {
    expect(refuse(src, fence, path)).toMatchObject({ origin_ref: 'seat.write_paths' })
  }
  record(w.db, 1, listed(['tests/unit/tests/test_a.py']))
  expect(fenceFor(w.db, 1, [BRIEF_FILES])).toEqual(['tests/unit/tests/test_a.py', 'tests'])
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
