import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { record } from '../../store/files.ts'
import type { Db } from '../../store/index.ts'
import { checks, mode, npm, type Ran, type Run } from '../checks.ts'
import { ciFeatures, formatLine, recipes } from '../gates.ts'
import { tick } from '../index.ts'
import { narrow } from '../rails.ts'
import { get } from '../workspace.ts'
import { GREEN, NAPPING, pkg, RED, TIMEOUT } from './bases.ts'
import { approve, CARRIED, internalPlan, ours, plan, stub, watched, world, type World } from './world.ts'

const ID = 2

const BOUND = '   × a lap 1066ms\n     → expected 1066 to be less than 1000\n'
const ASSERTED = ' FAIL x.test.ts > a call\nAssertionError: expected "hi" to be "ho"\n'
const SILENT = ' FAIL x.test.ts > a call\n'

const SLOW = 30000

const ONE = { 'package.json': pkg({ test: 'vitest run' }) }

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-checks-'))
  for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), body)
  return dir
}

/** A shell answering each call in turn, so a retry of the same command meets the next answer. */
function replies(...answers: Ran[]): { run: Run; seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    run: (args) => {
      seen.push(args.join(' '))
      return answers[seen.length - 1] ?? { ok: true, output: '' }
    },
  }
}

/** The shell the checks are given: every command it was asked for, and a non-zero exit for the one `red` names. */
function recorder(red?: string): { run: Run; seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    run: (args) => {
      const command = args.join(' ')
      seen.push(command)
      return command === red ? { ok: false, code: '2', output: 'boom' } : { ok: true, output: '' }
    },
  }
}

/** Our own repo carrying the scripts, so the plan's checkout is the one the checks run in. */
function mine(files: Record<string, string>): World {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root, files)
  internalPlan(w.db, w.root, ID)
  return w
}

/** The row `proof()` reads for `tests_pass`: the last `pre_review` verdict the lap wrote. */
function last(db: Db, plan: number): unknown {
  return db.prepare(`SELECT gate, kind, step, outcome, rail_id, origin_kind, origin_ref, tokens, seconds
    FROM verdicts WHERE plan = ? ORDER BY id DESC LIMIT 1`).get(plan)
}

test('the three scripts run in order and stop at the first non-zero exit, which the failure names', () => {
  const all = recorder('run lint')
  const src = tree({ 'package.json': pkg({ typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'vitest run' }) })
  expect(checks(src, all.run)).toEqual({ script: 'lint', command: 'npm run lint', code: '2', output: 'boom', retried: false })
  expect(all.seen).toEqual(['run typecheck', 'run lint'])

  const some = recorder()
  expect(checks(tree({ 'package.json': pkg({ test: 'vitest run', build: 'tsc' }) }), some.run)).toBeNull()
  expect(some.seen).toEqual(['run test'])
})

test('a checkout whose lint exits non-zero is back on step 2 with the command and its output, and no reviewer fired', async () => {
  const w = mine(RED)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))

  const fired = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(fired).toMatchObject({ plan: ID, step: 3, name: 'rails', outcome: 'refuse', spans: ['checks:lint'] })
  expect(fired?.note).toBe('npm run lint exit 3')
  expect(plan(w.db, ID).step).toBe(2)
  expect(w.db.prepare('SELECT 1 FROM runs WHERE plan = ? AND step > 3').all(ID)).toEqual([])
  expect(get(w.root, ID, 'refusal.md')).toContain('npm run lint')
  expect(get(w.root, ID, 'refusal.md')).toContain('lint is red')
  expect(last(w.db, ID)).toEqual({
    gate: 'pre_review', kind: 'rail', step: 3, outcome: 'refuse', rail_id: 'checks',
    origin_kind: 'rail', origin_ref: 'checks', tokens: 0, seconds: 0,
  })
}, SLOW)

test('a checkout whose scripts all exit zero is on step 4 with a pass row for `proof()` to read', async () => {
  const w = mine(GREEN)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))

  const fired = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(fired).toMatchObject({ plan: ID, step: 3, name: 'rails', outcome: 'pass' })
  expect(plan(w.db, ID).step).toBe(4)
  expect(last(w.db, ID)).toEqual({
    gate: 'pre_review', kind: 'rail', step: 3, outcome: 'pass', rail_id: 'checks',
    origin_kind: null, origin_ref: null, tokens: 0, seconds: 0,
  })
}, SLOW)

test('a timeout-only failure runs the command once more, and the second run is the one that settles it', () => {
  const twice = replies({ ok: false, code: '1', output: TIMEOUT }, { ok: true, output: '' })
  expect(checks(tree(ONE), twice.run)).toBeNull()
  expect(twice.seen).toEqual(['run test', 'run test'])
})

test('an assertion failure is refused on the first run and never retried', () => {
  const once = replies({ ok: false, code: '1', output: ASSERTED }, { ok: true, output: '' })
  expect(checks(tree(ONE), once.run))
    .toEqual({ script: 'test', command: 'npm run test', code: '1', output: ASSERTED, retried: false })
  expect(once.seen).toEqual(['run test'])
})

test('a failure the output does not account for as load is refused on the first run', () => {
  for (const output of [`${TIMEOUT}${ASSERTED}`, SILENT]) {
    const shell = replies({ ok: false, code: '1', output }, { ok: true, output: '' })
    expect(checks(tree(ONE), shell.run)).toMatchObject({ command: 'npm run test', code: '1', retried: false })
    expect(shell.seen).toEqual(['run test'])
  }
})

test('load-only on both runs is refused with the second run, and the note names the retry', async () => {
  const both = replies({ ok: false, code: '1', output: TIMEOUT }, { ok: false, code: '7', output: BOUND })
  expect(checks(tree(ONE), both.run))
    .toEqual({ script: 'test', command: 'npm run test', code: '7', output: BOUND, retried: true })

  const w = mine(NAPPING)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))

  const fired = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(fired).toMatchObject({ plan: ID, step: 3, outcome: 'refuse', spans: ['checks:test'] })
  expect(fired?.note).toBe('npm run test exit 1 after one retry')
  expect(get(w.root, ID, 'refusal.md')).toContain('after one retry')
  expect(last(w.db, ID)).toMatchObject({ outcome: 'refuse', rail_id: 'checks', origin_ref: 'x.test.ts > a lap' })
}, SLOW)

test('#77: a narrow list runs the tests it can reach, and only in place of a vitest suite', () => {
  const some = recorder()
  const src = tree({ 'package.json': pkg({ typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'vitest run' }) })
  expect(checks(src, some.run, ['store/plans.ts', 'store/lanes.ts'])).toBeNull()
  expect(some.seen).toEqual(['run typecheck', 'run lint', 'exec -- vitest related --run store/plans.ts store/lanes.ts'])

  const whole = recorder()
  expect(checks(src, whole.run, [])).toBeNull()
  expect(whole.seen).toEqual(['run typecheck', 'run lint', 'run test'])

  const jest = recorder()
  expect(checks(tree({ 'package.json': pkg({ test: 'jest' }) }), jest.run, ['a.ts'])).toBeNull()
  expect(jest.seen).toEqual(['run test'])
})

test('#77: a narrow run that fails is still named by the script, not by the last path it was given', () => {
  const red = recorder('exec -- vitest related --run store/plans.ts')
  const src = tree({ 'package.json': pkg({ test: 'vitest run' }) })
  expect(checks(src, red.run, ['store/plans.ts'])).toMatchObject({ script: 'test', code: '2' })
})

const HASH = '0'.repeat(64)

/** A step-2 run row, which is all `narrow` reads to tell a first build from a rebuild. */
function built(w: World, at: number): void {
  w.db.prepare(`INSERT OR IGNORE INTO rules (id, kind, path, content_hash, loaded_at)
    VALUES ('typescript_specialist', 'card', 'rules/roster.yaml', ?, '2026-09-22T00:00:00.000Z')`).run(HASH)
  w.db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort,
    input_tokens, cache_tokens, output_tokens, seconds, exit, transcript_path)
    VALUES (1, 2, 'typescript_specialist', ?, 'anthropic-api', 'm', 'low', 0, 0, 0, 0, 0, ?)`)
    .run(HASH, `step-2.${String(at)}.transcript.jsonl`)
}

test('#77: the first build is judged by the whole suite; a rebuild by what its own files reach', () => {
  const w = world()
  const row = plan(w.db, 1)
  record(w.db, 1, [{ path: 'store/plans.ts', is_new: false }, { path: 'store/lanes.ts', is_new: false }])

  expect(narrow(w.db, row)).toEqual([])
  built(w, 1)
  expect(narrow(w.db, row)).toEqual([])
  built(w, 2)
  expect(narrow(w.db, row)).toEqual(['store/plans.ts', 'store/lanes.ts'])

  record(w.db, 1, [])
  expect(narrow(w.db, row)).toEqual([])
})

test('a checkout with no package.json runs no command', () => {
  const none = recorder()
  expect(checks(tree({ 'readme.md': '# no scripts here\n' }), none.run)).toBeNull()
  expect(none.seen).toEqual([])
})

test('npm ci runs for a lock file with no node_modules, and its own failure refuses the same way', () => {
  const files = { 'package.json': pkg({ test: 'vitest run' }), 'package-lock.json': '{}' }
  const fresh = recorder('ci')
  expect(checks(tree(files), fresh.run)).toEqual({ script: 'ci', command: 'npm ci', code: '2', output: 'boom', retried: false })
  expect(fresh.seen).toEqual(['ci'])

  const installed = recorder()
  const dir = tree(files)
  mkdirSync(join(dir, 'node_modules'))
  expect(checks(dir, installed.run)).toBeNull()
  expect(installed.seen).toEqual(['run test'])
})

test('a plan on a target runs none of the stranger\'s scripts and passes step 3 as before', async () => {
  const w = world('warm', undefined, RED)
  approve(w.db, w.target)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))

  const fired = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, w.plan)))[0]
  expect(fired).toMatchObject({ plan: w.plan, step: 3, name: 'rails', outcome: 'pass' })
  expect(plan(w.db, w.plan).step).toBe(4)
  expect(w.db.prepare("SELECT 1 FROM verdicts WHERE plan = ? AND rail_id = 'checks'").all(w.plan)).toEqual([])
}, SLOW)

test('D1 an xcode checkout runs xcodebuild test with its derived data inside', () => {
  const src = tree({})
  mkdirSync(join(src, 'Atelier.xcodeproj'))
  mkdirSync(join(src, '.git', 'info'), { recursive: true })
  const bins: string[] = []
  const seen: string[] = []
  const run: Run = (...[args, , bin]) => { bins.push(bin ?? 'npm'); seen.push(args.join(' ')); return { ok: true, output: '' } }
  expect(mode(src)).toBe('xcodebuild')
  expect(checks(src, run)).toBeNull()
  expect(bins).toEqual(['xcodebuild'])
  expect(seen).toEqual(["-project Atelier.xcodeproj -scheme Atelier -destination platform=macOS -derivedDataPath .cf-derived test"])
  expect(readFileSync(join(src, '.git', 'info', 'exclude'), 'utf8')).toContain('.cf-derived/')
})

test('D1 a red xcodebuild names its command', () => {
  const src = tree({})
  mkdirSync(join(src, 'Atelier.xcodeproj'))
  const run: Run = () => ({ ok: false, code: '65', output: '** TEST FAILED **' })
  expect(checks(src, run)).toMatchObject({ script: 'test', code: '65', command: expect.stringMatching(/^xcodebuild -project Atelier\.xcodeproj/) as string })
})

test('an xcodebuild run whose test runner hung runs once more, and the second run settles it', () => {
  const src = tree({})
  mkdirSync(join(src, 'Atelier.xcodeproj'))
  const twice = replies({ ok: false, code: '65', output: 'The test runner hung before establishing connection.\n** TEST FAILED **' }, { ok: true, output: '' })
  expect(checks(src, twice.run)).toBeNull()
  expect(twice.seen).toHaveLength(2)
})

test('an xcodebuild failure without the hung line is refused on the first run', () => {
  const src = tree({})
  mkdirSync(join(src, 'Atelier.xcodeproj'))
  const once = replies({ ok: false, code: '65', output: '** TEST FAILED **' }, { ok: true, output: '' })
  expect(checks(src, once.run)).toMatchObject({ code: '65', retried: false })
  expect(once.seen).toHaveLength(1)
})

/** A step 3 checks lock another plan's tick left, naming `pid`. */
function locked(w: World, pid: number): string {
  const path = join(w.root, '.cf', 'checks.lock')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ plan: 9, pid, taken_at: new Date().toISOString() }))
  return path
}

test('a checks lock a live tick holds leaves step 3 held on it, with no checks run or recorded', async () => {
  const w = mine(GREEN)
  locked(w, process.ppid)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))

  const fired = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(fired).toMatchObject({ plan: ID, step: 3, name: 'rails', note: 'checks wait: plan 9 is running its tests' })
  expect(plan(w.db, ID).step).toBe(3)
  expect(w.db.prepare("SELECT 1 FROM verdicts WHERE plan = ? AND rail_id = 'checks'").all(ID)).toEqual([])
}, SLOW)

test('a checks lock whose holder is gone is taken over, and no lock is left after a pass or a refusal', async () => {
  for (const [scripts, step] of [[GREEN, 4], [RED, 2]] as const) {
    const w = mine(scripts)
    const path = locked(w, spawnSync('/usr/bin/true').pid)
    for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, stub(CARRIED))
    expect(plan(w.db, ID).step).toBe(step)
    expect(existsSync(path)).toBe(false)
  }
}, SLOW)

test('D2 a package.json checkout runs npm as before', () => {
  expect(mode(tree(ONE))).toBe('npm')
})

test('D3 a kotlin checkout runs gradle check', () => {
  const src = tree({})
  mkdirSync(join(src, 'kotlin'))
  const bins: string[] = []
  const seen: string[] = []
  const run: Run = (...[args, , bin]) => { bins.push(bin ?? 'npm'); seen.push(args.join(' ')); return { ok: true, output: '' } }
  expect(mode(src)).toBe('gradle')
  expect(checks(src, run)).toBeNull()
  expect([bins, seen]).toEqual([['gradle'], ['-p kotlin check']])
})

test('D4 the rails note names the mode', async () => {
  const w = mine(GREEN)
  const notes: string[] = []
  for (let at = 0; at < 4; at += 1) notes.push(...(await tick(w.db, w.root, stub(CARRIED))).filter((f) => f.name === 'rails').map((f) => f.note))
  expect(notes).toContain('pre-review: six rails pass; checks ran npm')
})

function nested(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-gates-'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  return dir
}

function heard(ran: Ran = { ok: true, output: '' }): { run: Run; calls: string[] } {
  const calls: string[] = []
  const run: Run = (args, cwd, bin) => { calls.push(`${bin ?? 'npm'} ${args.join(' ')} @${cwd}`); return ran }
  return { run, calls }
}

const JUST = 'install:\n    bundle install\n\ntest:\n    bundle exec ruby -Itest test/run.rb\n\nfmt:\n    bundle exec standardrb --fix\n\nlint:\n    bundle exec standardrb\n'

test('#204 an outside ruby plan runs its Justfile gates in ruby/, never npm at the root', () => {
  const src = nested({ 'package.json': pkg({ test: 'vitest run' }), 'ruby/Justfile': JUST, 'ruby/Gemfile': '', 'ruby/lib/pay_kit/config.rb': '' })
  const { run, calls } = heard()
  expect(checks(src, run, [], { language: 'ruby', files: ['docs/x.md', 'ruby/lib/pay_kit/config.rb'] })).toBeNull()
  const at = join(src, 'ruby')
  expect(calls).toEqual([`just --justfile Justfile install @${at}`, `just --justfile Justfile lint @${at}`, `just --justfile Justfile test @${at}`])
})

test('#192 an outside rust plan runs the fmt check its CI runs, then only the crates it touched', () => {
  const src = nested({
    'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
    'crates/core/Cargo.toml': '[package]\nname = "surfpool-core"\nversion = "0.1.0"\n',
    'crates/types/Cargo.toml': '[package]\nname = "surfpool-types"\n',
    '.github/workflows/rust.yml': 'jobs:\n  fmt:\n    steps:\n      - name: Run Cargo fmt\n        run: cargo +nightly fmt --all -- --check\n',
  })
  const { run, calls } = heard()
  const files = ['crates/types/src/types.rs', 'crates/core/src/rpc/a.rs', 'crates/core/src/b.rs', 'crates/sdk-node/kit/generated/index.ts']
  expect(checks(src, run, [], { language: 'rust', files })).toBeNull()
  expect(calls).toEqual([`cargo +nightly fmt --all -- --check @${src}`, `cargo test -p surfpool-types -p surfpool-core @${src}`])
})

test('#192 with no fmt line in the workflows, rust falls back to cargo fmt --all -- --check at the workspace', () => {
  const src = nested({ 'rust/Cargo.toml': '[workspace]\n', 'rust/crates/kit/Cargo.toml': '[package]\nname = "pay-kit"\n' })
  const { run, calls } = heard()
  expect(checks(src, run, [], { language: 'rust', files: ['rust/crates/kit/src/lib.rs'] })).toBeNull()
  const at = join(src, 'rust')
  expect(calls).toEqual([`cargo fmt --all -- --check @${at}`, `cargo test -p pay-kit @${at}`])
})

test('#192 a red format check refuses with the diff, named by folder', () => {
  const src = nested({ 'Cargo.toml': '[package]\nname = "x"\n' })
  const { run } = heard({ ok: false, code: '1', output: 'Diff in src/lib.rs at line 3' })
  expect(checks(src, run, [], { language: 'rust', files: ['src/lib.rs'] }))
    .toEqual({ script: 'format', command: 'cargo fmt --all -- --check', code: '1', output: 'Diff in src/lib.rs at line 3', retried: false })
})

test('#204 a go folder with no Justfile runs gofmt, vet and test raw; gofmt printing a file is a failure', () => {
  const src = nested({ 'go/go.mod': 'module x\n', 'go/config.go': '' })
  const { run, calls } = heard({ ok: true, output: 'config.go\n' })
  expect(checks(src, run, [], { language: 'go', files: ['go/config.go'] }))
    .toMatchObject({ script: 'format', command: 'gofmt -s -l . (in go/)', code: '1', output: 'config.go\n' })
  expect(calls).toEqual([`gofmt -s -l . @${join(src, 'go')}`])
})

test('#204 a recipe the Justfile does not define is not run', () => {
  const src = nested({ 'lua/Justfile': 'test:\n    luajit tests/run.lua\n', 'lua/pay-kit-dev-1.rockspec': '', 'lua/pay_kit/a.lua': '' })
  const { run, calls } = heard()
  expect(checks(src, run, [], { language: 'lua', files: ['lua/pay_kit/a.lua'] })).toBeNull()
  expect(calls).toEqual([`just --justfile Justfile test @${join(src, 'lua')}`])
})

test('#204 the recipe reader skips assignments and settings, and takes recipes with parameters', () => {
  const src = nested({ 'Justfile': 'set shell := ["bash", "-uc"]\nuv_run := "uv run"\n\ndefault:\n    @just --list\n\ntest-cover gate="90":\n    x\n\n@lint:\n    y\n' })
  expect([...(recipes(join(src, 'Justfile')) ?? [])]).toEqual(['default', 'test-cover', 'lint'])
  expect(formatLine(src)).toEqual(['fmt', '--all', '--', '--check'])
})

test('#204 rust tests take the features their CI test line names, less a service it starts, on the crates that declare them', () => {
  const src = nested({
    'Cargo.toml': '[workspace]\n',
    'crates/core/Cargo.toml': '[package]\nname = "surfpool-core"\n\n[features]\ndefault = ["sqlite"]\npostgres = []\nignore_tests_ci = []\n\n[dependencies]\n',
    'crates/types/Cargo.toml': '[package]\nname = "surfpool-types"\n\n[features]\ndefault = []\n',
    '.github/workflows/rust.yml': 'jobs:\n  build:\n    services:\n      postgres:\n        image: postgres:15\n    steps:\n'
      + '      - run: cargo test --all --verbose --features "postgres,ignore_tests_ci"\n',
  })
  expect(ciFeatures(src)).toEqual(['ignore_tests_ci'])
  const { run, calls } = heard()
  expect(checks(src, run, [], { language: 'rust', files: ['crates/types/src/types.rs', 'crates/core/src/types.rs'] })).toBeNull()
  expect(calls[1]).toBe(`cargo test -p surfpool-types -p surfpool-core --features surfpool-core/ignore_tests_ci @${src}`)
})

const BINDINGS = 'jobs:\n  bindings:\n    steps:\n      - name: Verify committed bindings are up to date\n        run: |\n'
  + '          node crates/sdk-node/scripts/generate-kit-types.js\n          git diff --exit-code\n'

function surfpool(sdk: string): string {
  return nested({
    'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
    'crates/core/Cargo.toml': '[package]\nname = "surfpool-core"\nversion = "0.1.0"\n',
    '.github/workflows/rust.yml': 'jobs:\n  fmt:\n    steps:\n      - name: Run Cargo fmt\n        run: cargo +nightly fmt --all -- --check\n',
    '.github/workflows/sdk.yml': sdk,
  })
}

test('#221 an outside rust plan stages, runs the bindings generator its CI runs, then diffs, at the root', () => {
  const src = surfpool(BINDINGS)
  const { run, calls } = heard()
  expect(checks(src, run, [], { language: 'rust', files: ['crates/core/src/a.rs'] })).toBeNull()
  expect(calls).toEqual([`cargo +nightly fmt --all -- --check @${src}`, `cargo test -p surfpool-core @${src}`, `git add -A @${src}`,
    `node crates/sdk-node/scripts/generate-kit-types.js @${src}`, `git diff --exit-code @${src}`])
})

test('#221 a red diff after regenerating refuses with the diff', () => {
  const src = surfpool(BINDINGS)
  const run: Run = (...[args, , bin]) => `${bin ?? 'npm'} ${args.join(' ')}` === 'git diff --exit-code' ? { ok: false, code: '1', output: '-a\n+b' } : { ok: true, output: '' }
  expect(checks(src, run, [], { language: 'rust', files: ['crates/core/src/a.rs'] }))
    .toEqual({ script: 'diff', command: 'git diff --exit-code', code: '1', output: '-a\n+b', retried: false })
})

test('#221 a diff step with no generator, or one needing a shell, adds no gate', () => {
  const src = surfpool('jobs:\n  a:\n    steps:\n      - run: |\n          cd x && node gen.js\n          git diff --exit-code\n      - run: git diff --exit-code\n')
  const { run, calls } = heard()
  expect(checks(src, run, [], { language: 'rust', files: ['crates/core/src/a.rs'] })).toBeNull()
  expect(calls).toEqual([`cargo +nightly fmt --all -- --check @${src}`, `cargo test -p surfpool-core @${src}`])
})

test('a program that never starts is named', () => {
  expect(npm(['--version'], tmpdir(), 'cf-no-such-bin')).toEqual({ ok: false, code: '127', output: expect.stringMatching(/^cf-no-such-bin: spawnSync cf-no-such-bin ENOENT/) as string })
})
