import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { unread } from '../../cli/inbox.ts'
import { checked } from '../../rails/checks/index.ts'
import { addRun } from '../../store/brief.ts'
import { decisions } from '../../store/decisions.ts'
import { runRows } from '../../store/events.ts'
import { filesOf, listed, record } from '../../store/files.ts'
import { addRule, type Db } from '../../store/index.ts'
import { dropPlan, pipeOf } from '../../store/plans.ts'
import { profile } from '../../store/profile.ts'
import { refusalRows, WHY } from '../../store/refusals.ts'
import { verdictRows } from '../../store/verdict.ts'
import { checks, excluded, finish, mode, network, npm, type Ran, type Run } from '../checks.ts'
import { ciFeatures, formatLine, type Outside, recipes } from '../gates.ts'
import { tick } from '../index.ts'
import { capped, faulted, narrow, offline } from '../rails.ts'
import { streak } from '../refusal.ts'
import { get, put, srcDir } from '../workspace.ts'
import { ATELIER, BROKEN, GREEN, GREETED, NAPPING, ORPHANED, pkg, RED, TIMEOUT } from './bases.ts'
import { approve, built as edited, CARRIED, internalPlan, ours, plan, stub, watched, world, type World } from './world.ts'

const ID = 2

const BOUND = '   × a lap 1066ms\n     → expected 1066 to be less than 1000\n'
const ASSERTED = ' FAIL x.test.ts > a call\nAssertionError: expected "hi" to be "ho"\n'
const SILENT = ' FAIL x.test.ts > a call\n'

const SLOW = 30000

const ONE = { 'package.json': pkg({ test: 'vitest run' }) }

const THREE = { 'package.json': pkg({ typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'vitest run' }) }

const REPO = join(import.meta.dirname, '..', '..')

const OWN = profile(REPO, 'caliperforge/caliperforge')?.commands ?? {}

const APP = profile(REPO, 'caliperforge/atelier')?.commands ?? {}

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
  dropPlan(w.db, 1)
  ours(w.root, files)
  internalPlan(w.db, w.root, ID)
  return w
}

/** The row `proof()` reads for `tests_pass`: the last `pre_review` verdict the lap wrote. */
function last(db: Db, plan: number): unknown {
  const row = verdictRows(db, plan).at(-1)
  return row && { gate: row.gate, kind: row.kind, step: row.step, outcome: row.outcome, rail_id: row.rail_id,
    origin_kind: row.origin_kind, origin_ref: row.origin_ref, tokens: row.tokens, seconds: row.seconds }
}

test('three scripts run in order and stop at the first failure', () => {
  const all = recorder('run lint')
  const src = tree({ 'package.json': pkg({ typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'vitest run' }) })
  expect(checks(src, OWN, all.run)).toEqual({ script: 'lint', command: 'npm run lint', code: '2', output: 'boom', tests: [], retried: false })
  expect(all.seen).toEqual(['run typecheck', 'run lint'])

  const some = recorder()
  expect(checks(tree({ 'package.json': pkg({ test: 'vitest run', build: 'tsc' }) }), OWN, some.run)).toBeNull()
  expect(some.seen).toEqual(['run test'])
})

test('a red lint goes back to step 2 with its output, no reviewer', async () => {
  const w = mine(RED)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))

  const fired = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(fired).toMatchObject({ plan: ID, step: 3, name: 'rails', outcome: 'refuse', spans: ['checks:lint'] })
  expect(fired?.note).toBe('npm run lint exit 3')
  expect(plan(w.db, ID).step).toBe(2)
  expect(runRows(w.db).filter((r) => r.plan === ID && r.step > 3)).toEqual([])
  expect(get(w.root, ID, 'refusal.md')).toContain('npm run lint')
  expect(get(w.root, ID, 'refusal.md')).toContain('lint is red')
  expect(last(w.db, ID)).toEqual({
    gate: 'pre_review', kind: 'rail', step: 3, outcome: 'refuse', rail_id: 'checks',
    origin_kind: 'rail', origin_ref: 'checks', tokens: 0, seconds: 0,
  })
}, SLOW)

test('green scripts move to step 4 with a pass row for `proof()`', async () => {
  const w = mine(GREEN)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))

  const fired = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(fired).toMatchObject({ plan: ID, step: 3, name: 'rails', outcome: 'pass' })
  expect(plan(w.db, ID).step).toBe(4)
  expect(last(w.db, ID)).toEqual({
    gate: 'pre_review', kind: 'rail', step: 3, outcome: 'pass', rail_id: 'checks',
    origin_kind: null, origin_ref: null, tokens: 0, seconds: 0,
  })
  expect(fired?.note).toBe('pre-review: six rails pass; checks ran npm')
}, SLOW)

const CALLS = { ...ONE, 'a.test.ts': "import { test } from 'vitest'\n\ntest('a call', () => {})\n", 'b.test.ts': "\ntest('a lap', () => {})\n" }
const CALL = ' FAIL a.test.ts > a call\nAssertionError: expected "hi" to be "ho"\n'
const LAP = ' FAIL b.test.ts > a lap\nError: Test timed out in 5000ms.\n'

test('D1 a failure names tests by file:line and marks timeouts', () => {
  const once = replies({ ok: false, code: '1', output: `${CALL}${LAP}${CALL}` }, { ok: true, output: '' })
  expect(checks(tree(CALLS), OWN, once.run)).toMatchObject({ tests: ['a.test.ts:3 a call', 'b.test.ts:2 a lap (timeout)'], retried: false })
  expect(once.seen).toEqual(['run test'])
})

test('D2 a timeout-only failure re-runs only the files it names', () => {
  const twice = replies({ ok: false, code: '1', output: LAP }, { ok: true, output: '' })
  expect(checks(tree(CALLS), OWN, twice.run)).toBeNull()
  expect(twice.seen).toEqual(['run test', 'exec -- vitest run b.test.ts'])
})

test('D3 a red files-only re-run refuses under the first command', () => {
  const output = ' FAIL b.test.ts > a lap\nAssertionError: expected 1 to be 2\n'
  const twice = replies({ ok: false, code: '1', output: LAP }, { ok: false, code: '1', output })
  expect(checks(tree(CALLS), OWN, twice.run))
    .toEqual({ script: 'test', command: 'npm run test', code: '1', output, tests: ['b.test.ts:2 a lap'], retried: true })
})

test('D4 load, a hung runner or non-vitest re-runs the command', () => {
  const xcode = tree({})
  mkdirSync(join(xcode, 'Atelier.xcodeproj'))
  const hung = 'The test runner hung before establishing connection.\n'
  for (const [src, output, given] of [[tree(ONE), BOUND, OWN], [xcode, hung, APP], [tree({ 'package.json': pkg({ test: 'jest' }) }), LAP, OWN]] as const) {
    const twice = replies({ ok: false, code: '1', output }, { ok: true, output: '' })
    expect(checks(src, given, twice.run)).toBeNull()
    expect(twice.seen[1]).toBe(twice.seen[0])
  }
})

test('a non-load failure is refused on the first run', () => {
  for (const output of [`${TIMEOUT}${ASSERTED}`, SILENT]) {
    const shell = replies({ ok: false, code: '1', output }, { ok: true, output: '' })
    expect(checks(tree(ONE), OWN, shell.run)).toMatchObject({ command: 'npm run test', code: '1', retried: false })
    expect(shell.seen).toEqual(['run test'])
  }
})

test('load-only twice refuses on the second run, noting the retry', async () => {
  const both = replies({ ok: false, code: '1', output: TIMEOUT }, { ok: false, code: '7', output: BOUND })
  expect(checks(tree(ONE), OWN, both.run))
    .toEqual({ script: 'test', command: 'npm run test', code: '7', output: BOUND, tests: [], retried: true })

  const w = mine(NAPPING)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))

  const fired = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(fired).toMatchObject({ plan: ID, step: 3, outcome: 'refuse', spans: ['checks:test', 'x.test.ts a lap (timeout)'] })
  expect(fired?.note).toBe('npm run test exit 1 after one retry')
  expect(get(w.root, ID, 'refusal.md')).toContain('after one retry')
  expect(get(w.root, ID, 'refusal.md')).toContain('  - checks:test\n  - x.test.ts a lap (timeout)\n')
  expect(last(w.db, ID)).toMatchObject({ outcome: 'refuse', rail_id: 'checks', origin_ref: 'x.test.ts > a lap' })
}, SLOW)

/** A plan of `files` refused once at step 3, after its build changed `src/hello.ts`; its file list before that lap, and the lap. */
async function reddened(files: Record<string, string>): Promise<{ w: World; before: string[]; fired: Awaited<ReturnType<typeof tick>>[number] | undefined }> {
  const w = mine(files)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))
  edited(w.root, ID, 'export const two = (): number => 2')
  const before = filesOf(w.db, ID).map((f) => f.path)
  return { w, before, fired: (await tick(w.db, w.root, stub(CARRIED)))[0] }
}

test('#191 D1 a red unlisted test on changed code joins the job', async () => {
  const { w, before, fired } = await reddened(BROKEN)
  expect(fired?.note).toBe("npm run test exit 1; added to this job's files: src/tests/hello.test.ts")
  expect(plan(w.db, ID)).toMatchObject({ step: 2 })
  expect(plan(w.db, ID).state).not.toBe('blocked_on_ceo')
  expect(filesOf(w.db, ID).map((f) => f.path)).toEqual([...before, 'src/tests/hello.test.ts'])
  expect(get(w.root, ID, 'refusal.md')).toContain('src/tests/hello.test.ts')
  expect(decisions(w.db, ID)).toEqual([])
}, SLOW)

test('#191 D2 a red unlisted test on unchanged code is refused', async () => {
  const { w, before, fired } = await reddened(ORPHANED)
  expect(fired).toMatchObject({ outcome: 'refuse', spans: ['checks:test', 'src/tests/hello.test.ts:3 says hi'] })
  expect(fired?.note).toBe('npm run test exit 1')
  expect(filesOf(w.db, ID).map((f) => f.path)).toEqual(before)
}, SLOW)

/** A plan whose build removed the `greets with hi` block, with `ruling` in its `rulings.md` where one is given, and its step-3 lap. */
async function ungreeted(ruling?: string): Promise<{ w: World; fired: Awaited<ReturnType<typeof tick>>[number] | undefined }> {
  const w = mine(GREETED)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))
  listed(w.db, ID, 'src/tests/hello.test.ts')
  writeFileSync(join(srcDir(w.root, ID), 'src/tests/hello.test.ts'), 'export {}\n')
  if (ruling !== undefined) put(w.root, ID, 'rulings.md', ruling)
  return { w, fired: (await tick(w.db, w.root, stub(CARRIED)))[0] }
}

test('#628 D1 a removed test named in rulings.md passes', async () => {
  const { w, fired } = await ungreeted("- the 'greets with hi' test goes\n")
  expect(fired).toMatchObject({ plan: ID, step: 3, name: 'rails', outcome: 'pass' })
  expect(plan(w.db, ID).step).toBe(4)
}, SLOW)

test('#628 D2 D3 a removed test no ruling names is refused', async () => {
  for (const ruling of [undefined, "- the 'greets with bye' test goes\n"]) {
    const { w, fired } = await ungreeted(ruling)
    expect(fired).toMatchObject({ plan: ID, step: 3, outcome: 'refuse', spans: ['src/tests/hello.test.ts:1 test.weakened.removed'] })
    expect(fired?.note.startsWith('test-weakened: ')).toBe(true)
    expect(plan(w.db, ID).step).toBe(2)
  }
}, SLOW)

test('#77: a narrow list runs reachable tests, only for vitest', () => {
  const some = recorder()
  const src = tree({ 'package.json': pkg({ typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'vitest run' }) })
  expect(checks(src, OWN, some.run, ['store/plans.ts', 'store/lanes.ts'])).toBeNull()
  expect(some.seen).toEqual(['run typecheck', 'run lint', 'exec -- vitest related --run store/plans.ts store/lanes.ts'])

  const whole = recorder()
  expect(checks(src, OWN, whole.run, [])).toBeNull()
  expect(whole.seen).toEqual(['run typecheck', 'run lint', 'run test'])

  const jest = recorder()
  expect(checks(tree({ 'package.json': pkg({ test: 'jest' }) }), OWN, jest.run, ['a.ts'])).toBeNull()
  expect(jest.seen).toEqual(['run test'])
})

test('#77: a failed narrow run is named by the script, not a path', () => {
  const red = recorder('exec -- vitest related --run store/plans.ts')
  const src = tree({ 'package.json': pkg({ test: 'vitest run' }) })
  expect(checks(src, OWN, red.run, ['store/plans.ts'])).toMatchObject({ script: 'test', code: '2' })
})

const HASH = '0'.repeat(64)

/** A step-2 run row, which is all `narrow` reads to tell a first build from a rebuild. */
function built(w: World, at: number): void {
  addRun(w.db, {
    plan: 1, step: 2, seat: 'typescript_specialist', rule_hash: HASH, provider: 'anthropic-api', model: 'm', effort: 'low',
    input_tokens: 0, cache_write_tokens: null, cache_write_1h_tokens: null, cache_read_tokens: 0, output_tokens: 0,
    seconds: 0, exit: 0, at: '2026-09-22T00:00:00.000Z', transcript_path: `step-2.${String(at)}.transcript.jsonl`, cost_usd: null,
  })
}

test('#77: first build runs the suite; a rebuild what it reaches', () => {
  const w = world()
  addRule(w.db, { id: 'typescript_specialist', kind: 'card', path: 'rules/roster.yaml', content_hash: HASH, loaded_at: '2026-09-22T00:00:00.000Z' })
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
  expect(checks(tree({ 'readme.md': '# no scripts here\n' }), OWN, none.run)).toBeNull()
  expect(none.seen).toEqual([])
})

const BENCH = profile(REPO, 'caliperforge/fuzz-bench')?.commands ?? {}

const FOUNDRY = { 'foundry.toml': '[profile.default]\n' }

/** A shell recording each program, its args and where it ran, exiting non-zero for the `program args` that `red` names. */
function binned(red?: string): { run: Run; bins: string[]; seen: string[]; cwds: string[] } {
  const bins: string[] = []
  const seen: string[] = []
  const cwds: string[] = []
  const run: Run = (...[args, cwd, bin = 'npm']) => {
    bins.push(bin)
    seen.push(args.join(' '))
    cwds.push(cwd)
    return `${bin} ${args.join(' ')}` === red ? { ok: false, code: '1', output: 'boom' } : { ok: true, output: '' }
  }
  return { run, bins, seen, cwds }
}

test('1157b D1 fuzz-bench runs forge build, test, then pytest', () => {
  const src = tree(FOUNDRY)
  const green = binned()
  expect(checks(src, BENCH, green.run)).toBeNull()
  expect([green.bins, green.seen]).toEqual([['forge', 'forge', 'python3'], ['build', 'test', '-m pytest -m not live']])
  expect(new Set(green.cwds)).toEqual(new Set([src]))
})

test('1157b D2 a red forge test or pytest refuses naming it', () => {
  for (const [red, script, seen] of [['forge test', 'test', ['build', 'test']], ['python3 -m pytest -m not live', 'pytest', ['build', 'test', '-m pytest -m not live']]] as const) {
    const shell = binned(red)
    const failed = checks(tree(FOUNDRY), BENCH, shell.run)
    expect(failed).toMatchObject({ script, command: red, code: '1' })
    expect(shell.seen).toEqual(seen)
    expect(checked(failed, '').message.startsWith(red)).toBe(true)
  }
})

const SUBPROJECT = { ...ONE, 'tools/x/pyproject.toml': '[project]\nname = "x"\n', 'tools/x/a.py': '' }

const UV = ['sync --all-extras', 'tool run ruff check', 'run --with pyright pyright', 'run --no-sync pytest']

test('1854 D1 a pyproject folder runs its uv gates before npm', () => {
  const src = nested(SUBPROJECT)
  const green = binned()
  expect(checks(src, OWN, green.run, [], null, ['tools/x/a.py'])).toBeNull()
  expect([green.bins, green.seen]).toEqual([['uv', 'uv', 'uv', 'uv', 'npm'], [...UV, 'run test']])
  expect(green.cwds).toEqual([...UV.map(() => join(src, 'tools/x')), src])
})

test('1854 D2 a red pyright refuses before any npm script', () => {
  const shell = binned('uv run --with pyright pyright')
  expect(checks(nested(SUBPROJECT), OWN, shell.run, [], null, ['tools/x/a.py']))
    .toMatchObject({ script: 'typecheck', command: 'uv run --with pyright pyright (in tools/x/)', code: '1' })
  expect(shell.bins).toEqual(['uv', 'uv', 'uv'])
})

test('1854 D3 no uv gate without a subproject or the file', () => {
  for (const files of [{ 'tools/x/a.py': '' }, { 'pyproject.toml': '', 'tools/x/a.py': '' }, { 'tools/x/pyproject.toml': '' }]) {
    const shell = binned()
    expect(checks(nested({ ...ONE, ...files }), OWN, shell.run, [], null, ['tools/x/a.py'])).toBeNull()
    expect(shell.bins).toEqual(['npm'])
  }
})

const SITE = profile(REPO, 'caliperforge/site')?.commands ?? {}

const PAGE = { 'index.html': '<h1>hi</h1>\n', 'stats.json': '{"n": 1}\n' }

const TYPED = { ...PAGE, 'tsconfig.json': '{}\n' }

const TOUCHED = Object.keys(TYPED)

test('1156b D2 a site with tsconfig.json runs tsc alone', () => {
  const green = binned()
  expect(checks(tree(TYPED), SITE, green.run, [], null, TOUCHED)).toBeNull()
  expect([green.bins, green.seen]).toEqual([['npm'], ['exec --no -- tsc --noEmit']])
})

test('1156b D3 a malformed touched JSON refuses before any run', () => {
  const shell = binned()
  const failed = checks(tree({ ...TYPED, 'stats.json': '{"n": }\n' }), SITE, shell.run, [], null, TOUCHED)
  expect(failed).toMatchObject({ script: 'json', command: 'JSON.parse stats.json', code: '1' })
  expect(shell.seen).toEqual([])
  expect(checked(failed, '').message).toBe('JSON.parse stats.json exit 1')
})

test('1156b D4 a site without tsconfig.json runs no command', () => {
  const none = binned()
  expect(checks(tree(PAGE), SITE, none.run, [], null, TOUCHED)).toBeNull()
  expect(none.seen).toEqual([])
})

test('1156b D5 untouched or deleted bad JSON does not refuse', () => {
  const src = tree({ ...TYPED, 'stats.json': '{' })
  expect(checks(src, SITE, binned().run, [], null, ['index.html', 'gone.json'])).toBeNull()
})

/** A tree of `files` with each of `tests` written empty under its `tests/` folder. */
function tested(files: Record<string, string>, tests: string[]): string {
  const src = tree(files)
  mkdirSync(join(src, 'tests'))
  for (const name of tests) writeFileSync(join(src, 'tests', name), '')
  return src
}

const NODE_TEST = 'node --test tests/charts.test.js'

test('1333 D1 a site runs node --test after tsc', () => {
  const src = tested(TYPED, ['charts.test.js', 'helpers.js'])
  const green = binned()
  expect(checks(src, SITE, green.run)).toBeNull()
  expect([green.bins, green.seen]).toEqual([['npm', 'node'], ['exec --no -- tsc --noEmit', '--test tests/charts.test.js']])
  expect(new Set(green.cwds)).toEqual(new Set([src]))
})

test('1333 D2 a red node --test refuses as checks:test', () => {
  const failed = checks(tested(PAGE, ['charts.test.js']), SITE, binned(NODE_TEST).run, [], null, TOUCHED)
  expect(failed).toEqual({ script: 'test', command: NODE_TEST, code: '1', output: 'boom', tests: [], retried: false })
  expect(checked(failed, '').message).toBe(`${NODE_TEST} exit 1`)
})

test('1333 D3 a site with no .test.js under tests/ runs none', () => {
  for (const src of [tree(PAGE), tested(PAGE, ['helpers.js'])]) {
    const none = binned()
    expect(checks(src, SITE, none.run, [], null, TOUCHED)).toBeNull()
    expect(none.seen).toEqual([])
  }
})

test('1333 D4 a profile without node_test runs no node --test', () => {
  for (const repo of ['caliperforge', 'atelier-web', 'fuzz-bench']) {
    const shell = binned()
    const given = profile(REPO, `caliperforge/${repo}`)?.commands ?? {}
    checks(tested(FOUNDRY, ['x.test.js']), given, shell.run, [], null, ['tests/x.test.js'])
    expect(shell.seen.filter((args) => args.startsWith('--test'))).toEqual([])
  }
})

const LODGE = profile(REPO, 'caliperforge/earth-lodge-site')?.commands ?? {}

const ASTRO = { 'package.json': pkg({ verify: 'astro build && wrangler pages functions build', build: 'astro build' }),
  'package-lock.json': '{}', 'app.js': '' }

test('1456 D4 earth-lodge-site runs node --check and --test only', () => {
  const green = binned()
  expect(checks(tested(ASTRO, ['booking.test.js', 'helpers.js']), LODGE, green.run, [], null, ['app.js'])).toBeNull()
  expect([green.bins, green.seen]).toEqual([['node', 'node'], ['--check app.js', '--test tests/booking.test.js']])
})

test('1456 D5 a red node --check or --test names its script', () => {
  for (const [red, script] of [['node --check app.js', 'node'], ['node --test tests/booking.test.js', 'test']]) {
    const failed = checks(tested(ASTRO, ['booking.test.js', 'helpers.js']), LODGE, binned(red).run, [], null, ['app.js'])
    expect(failed).toMatchObject({ script, command: red, code: '1' })
  }
})

test('1456 D6 a site with tsc and a bare lock runs ci, then tsc', () => {
  const green = binned()
  expect(checks(tree({ ...TYPED, 'package.json': pkg({}), 'package-lock.json': '{}' }), SITE, green.run, [], null, TOUCHED)).toBeNull()
  expect([green.bins, green.seen]).toEqual([['npm', 'npm'], ['ci', 'exec --no -- tsc --noEmit']])
})

const EULER = profile(REPO, 'caliperforge/fuzz-bench')?.finish ?? {}

test('1181b D1 D2 finish runs in order and stops at the first red', () => {
  const src = tree(FOUNDRY)
  const entries = { a: ['node', '-e', 'x'], b: ['node', 'b'] }
  const green = recorder()
  expect(finish(src, entries, green.run)).toBeNull()
  expect(green.seen).toEqual(['-e x', 'b'])

  const red = recorder('-e x')
  expect(finish(src, entries, red.run))
    .toEqual({ script: 'finish', command: 'node -e x', code: '2', output: 'boom', tests: [], retried: false })
  expect(red.seen).toEqual(['-e x'])
})

const PAIR = 'bench/run_pair.py targets/euler-earn-m01.yml suites/euler-m01'

test('1225 D2 finish skips an entry whose script is missing', () => {
  const none = recorder()
  expect(finish(tree(FOUNDRY), EULER, none.run)).toBeNull()
  expect(none.seen).toEqual([])
})

test('1225 D3 finish runs run_pair.py once it is there', () => {
  const src = tree(FOUNDRY)
  mkdirSync(join(src, 'bench'))
  writeFileSync(join(src, 'bench', 'run_pair.py'), '')
  const green = recorder()
  expect(finish(src, EULER, green.run)).toBeNull()
  expect(green.seen).toEqual([PAIR])
  expect(finish(src, EULER, recorder(PAIR).run))
    .toEqual({ script: 'finish', command: `python3 ${PAIR}`, code: '2', output: 'boom', tests: [], retried: false })
})

test('1225 D5 pytest runs the changed .py files that exist', () => {
  const src = tree(FOUNDRY)
  for (const dir of ['bench', 'tests']) mkdirSync(join(src, dir))
  for (const path of ['bench/run_pair.py', 'tests/test_run_pair.py']) writeFileSync(join(src, path), '')
  const touched = ['bench/run_pair.py', 'tests/test_run_pair.py', 'README.md', 'gone.py']
  const pytest = '-m pytest -m not live bench/run_pair.py tests/test_run_pair.py'
  const green = binned()
  expect(checks(src, BENCH, green.run, [], null, touched)).toBeNull()
  expect(green.seen).toEqual(['build', 'test', pytest])
  expect(checks(src, BENCH, binned(`python3 ${pytest}`).run, [], null, touched)).toMatchObject({ script: 'pytest', command: `python3 ${pytest}` })
})

test('1402 D2 pytest deselects live tests before the touched paths', () => {
  const src = tree(FOUNDRY)
  mkdirSync(join(src, 'tests'))
  const touched = ['tests/test_a.py', 'tests/test_b.py']
  for (const path of touched) writeFileSync(join(src, path), '')
  const argv: string[][] = []
  const run: Run = (...[args, , bin]) => {
    if (bin === 'python3') argv.push(args)
    return { ok: true, output: '' }
  }
  expect(checks(src, BENCH, run, [], null, touched)).toBeNull()
  expect(argv).toEqual([['-m', 'pytest', '-m', 'not live', ...touched]])
  const [python3 = []] = argv
  expect(python3.indexOf('not live')).toBeLessThan(python3.indexOf('tests/test_a.py'))
})

test('1181b D6 no finish entries run nothing', () => {
  const none = recorder()
  expect(finish(tree(FOUNDRY), {}, none.run)).toBeNull()
  expect(none.seen).toEqual([])
})

/** Our own plan at step 3 with `argv` as its profile's one finish entry. */
async function finished(argv: string): Promise<{ w: World; fired: Awaited<ReturnType<typeof tick>>[number] | undefined }> {
  const w = mine(GREEN)
  appendFileSync(join(w.root, 'profiles', 'caliperforge', 'caliperforge.yml'), `finish: { x: ${argv} }\n`)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))
  return { w, fired: (await tick(w.db, w.root, stub(CARRIED)))[0] }
}

test('1181b D2 a red finish entry refuses at step 3', async () => {
  const { w, fired } = await finished("[node, -e, 'process.exit(4)']")
  expect(fired).toMatchObject({ plan: ID, step: 3, outcome: 'refuse', spans: ['checks:finish'], note: 'node -e process.exit(4) exit 4' })
  expect(plan(w.db, ID).step).toBe(2)
  expect(last(w.db, ID)).toMatchObject({ outcome: 'refuse', rail_id: 'checks' })
}, SLOW)

test('1181b D1 a green finish entry reaches step 4', async () => {
  const { w } = await finished("[node, -e, 'process.exit(0)']")
  expect(plan(w.db, ID).step).toBe(4)
}, SLOW)

const RPC = 'error: RPC failed; HTTP 400 curl 22'

const OFFLINE = [RPC, "fatal: expected 'packfile'", 'fatal: unable to access: Could not resolve host: github.com', 'read: Connection reset by peer',
  'Failed to connect to github.com port 443', 'curl 56 Recv failure', 'ssh: connect to host github.com port 22: Operation timed out']

test('1271 D1 network() names the failed line, or null', () => {
  for (const line of OFFLINE) expect(network(`Cloning into 'x'...\n  ${line}\n`)).toBe(line)
  for (const output of [ASSERTED, '', 'syntax error: unexpected EOF']) expect(network(output)).toBeNull()
})

test('1271 D2 a network failure blips, staying on step 3', async () => {
  const { w, fired } = await finished(`[node, -e, 'process.stderr.write("${RPC}"); process.exit(128)']`)
  expect(fired).toMatchObject({ plan: ID, step: 3, outcome: 'refuse', spans: ['checks:network'] })
  expect(fired?.note.endsWith(`exit 128: the host's network failed: ${RPC}`)).toBe(true)
  expect(plan(w.db, ID)).toMatchObject({ step: 3, state: 'running' })
  expect(refusalRows(w.db, ID)).toEqual([])
  expect(streak(w.db, ID)).toBeNull()
  expect(verdictRows(w.db, ID).filter((v) => v.rail_id === 'checks')).toEqual([])

  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
  expect(plan(w.db, ID).state).toBe('blocked_on_ceo')
  expect(get(w.root, ID, 'refusal.md')).toContain('RPC failed; HTTP 400')
  expect(get(w.root, ID, 'refusal.md')).toContain(WHY.blips)
}, SLOW)

test('1271 D4 a check naming a red test is never a blip', () => {
  const failure = { script: 'test', command: 'npm run test', code: '128', retried: false }
  expect(offline({ ...failure, output: `${CALL}Could not resolve host: github.com\n`, tests: ['a.test.ts:3 a call'] })).toBeNull()
  expect(offline({ ...failure, output: ASSERTED, tests: [] })).toBeNull()
  expect(offline({ ...failure, output: `${RPC}\n`, tests: [] }))
    .toMatchObject({ outcome: 'refuse', blip: true, spans: ['checks:network'], note: `npm run test exit 128: the host's network failed: ${RPC}` })
})

test('1271 D5 a passing check printing a network line moves on', async () => {
  const { w } = await finished("[node, -e, 'process.stdout.write(\"Could not resolve host\")']")
  expect(plan(w.db, ID).step).toBe(4)
}, SLOW)

test('npm ci runs for a lock without node_modules, and can refuse', () => {
  const files = { 'package.json': pkg({ test: 'vitest run' }), 'package-lock.json': '{}' }
  const fresh = recorder('ci')
  expect(checks(tree(files), OWN, fresh.run)).toEqual({ script: 'ci', command: 'npm ci', code: '2', output: 'boom', tests: [], retried: false })
  expect(fresh.seen).toEqual(['ci'])

  const installed = recorder()
  const dir = tree(files)
  mkdirSync(join(dir, 'node_modules'))
  expect(checks(dir, OWN, installed.run)).toBeNull()
  expect(installed.seen).toEqual(['run test'])
})

test('a target plan runs no stranger scripts and passes step 3', async () => {
  const w = world('warm', undefined, RED)
  approve(w.db, w.target)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))

  const fired = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, w.plan)))[0]
  expect(fired).toMatchObject({ plan: w.plan, step: 3, name: 'rails', outcome: 'pass' })
  expect(plan(w.db, w.plan).step).toBe(4)
  expect(verdictRows(w.db, w.plan).filter((v) => v.rail_id === 'checks')).toEqual([])
}, SLOW)

const XCODEBUILD = '-project Atelier.xcodeproj -scheme Atelier -destination platform=macOS -derivedDataPath .cf-derived -test-timeouts-enabled YES -default-test-execution-time-allowance 60 -maximum-test-execution-time-allowance 60 test'

test('D1 xcode runs xcodebuild test with its derived data inside', () => {
  const src = tree({})
  mkdirSync(join(src, 'Atelier.xcodeproj'))
  mkdirSync(join(src, '.git', 'info'), { recursive: true })
  const bins: string[] = []
  const seen: string[] = []
  const run: Run = (...[args, , bin]) => { bins.push(bin ?? 'npm'); seen.push(args.join(' ')); return { ok: true, output: '' } }
  expect(mode(src)).toBe('xcodebuild')
  expect(checks(src, APP, run)).toBeNull()
  expect(bins).toEqual(['xcodebuild'])
  expect(seen).toEqual([XCODEBUILD])
  expect(readFileSync(join(src, '.git', 'info', 'exclude'), 'utf8')).toContain('.cf-derived/')
})

test('D1 excluded keeps each line once across a missing newline', () => {
  const src = tree({})
  mkdirSync(join(src, '.git', 'info'), { recursive: true })
  writeFileSync(join(src, '.git', 'info', 'exclude'), '# local')
  excluded(src)
  excluded(src)
  expect(readFileSync(join(src, '.git', 'info', 'exclude'), 'utf8')).toBe('# local\n.cf-derived/\n__pycache__/\n.gradle/\nbuild/\ntarget/\nuv.lock\nfoundry.lock\n')
})

test('the caliperforge and atelier profiles run the same commands', () => {
  const some = recorder()
  expect(checks(tree(THREE), OWN, some.run)).toBeNull()
  expect(some.seen).toEqual(['run typecheck', 'run lint', 'run test'])

  const bins: string[] = []
  const seen: string[] = []
  const run: Run = (...[args, , bin]) => { bins.push(bin ?? 'npm'); seen.push(args.join(' ')); return { ok: true, output: '' } }
  expect(checks(xcode(), APP, run)).toBeNull()
  expect([bins, seen]).toEqual([['xcodebuild'], [XCODEBUILD]])
})

test('760b D4 node checks each touched .js on disk, then npm', () => {
  const src = tree({ 'package.json': pkg({ test: 'node --test' }) })
  mkdirSync(join(src, 'public'))
  writeFileSync(join(src, 'public', 'app.js'), 'export {}\n')
  const touched = ['public/app.js', 'README.md', 'gone.js']
  const green = recorder()
  expect(checks(src, { node: ['--check'], npm: ['test'] }, green.run, [], null, touched)).toBeNull()
  expect(green.seen).toEqual(['--check public/app.js', 'run test'])

  const red = recorder('--check public/app.js')
  expect(checks(src, { node: ['--check'], npm: ['test'] }, red.run, [], null, touched))
    .toEqual({ script: 'node', command: 'node --check public/app.js', code: '2', output: 'boom', tests: [], retried: false })
  expect(red.seen).toEqual(['--check public/app.js'])
})

test('commands left out of the profile are not run', () => {
  const none = recorder()
  expect(checks(xcode(), {}, none.run)).toBeNull()
  expect(none.seen).toEqual([])

  const lint = recorder()
  expect(checks(tree(THREE), { npm: ['lint'] }, lint.run)).toBeNull()
  expect(lint.seen).toEqual(['run lint'])
})

test('D1 a red xcodebuild names its command', () => {
  const src = tree({})
  mkdirSync(join(src, 'Atelier.xcodeproj'))
  const run: Run = () => ({ ok: false, code: '65', output: '** TEST FAILED **' })
  expect(checks(src, APP, run)).toMatchObject({ script: 'test', code: '65', command: expect.stringMatching(/^xcodebuild -project Atelier\.xcodeproj/) as string })
})

test('an xcodebuild failure not hung is refused on the first run', () => {
  const src = tree({})
  mkdirSync(join(src, 'Atelier.xcodeproj'))
  const once = replies({ ok: false, code: '65', output: '** TEST FAILED **' }, { ok: true, output: '' })
  expect(checks(src, APP, once.run)).toMatchObject({ code: '65', retried: false })
  expect(once.seen).toHaveLength(1)
})

const STALE = 'CoreSimulator is out of date: 1051.55 is running, 1171.7 is required'

const HANG = 'The test runner hung before establishing connection.\n'

function xcode(): string {
  const src = tree({})
  mkdirSync(join(src, 'Atelier.xcodeproj'))
  return src
}

test('#257 D1 an outdated CoreSimulator is a fault after one run', () => {
  const once = replies({ ok: false, code: '70', output: `building\n${STALE}\n` })
  expect(checks(xcode(), APP, once.run)).toMatchObject({ fault: STALE, retried: false })
  expect(once.seen).toHaveLength(1)
})

test('#257 D1 a fault keeps retries, stops the lane, posts once', () => {
  const w = world()
  internalPlan(w.db, w.root, ID)
  expect(faulted(w.db, w.root, plan(w.db, ID), STALE)).toMatchObject({ outcome: 'pass', held: true })
  expect(plan(w.db, ID).retries).toBe(0)
  expect(pipeOf(w.db, 1).enabled).toBe(0)
  expect(unread(w.root).map((e) => e.note)).toEqual([expect.stringMatching(/restart the Mac.*xcodebuild -runFirstLaunch/) as string])
  faulted(w.db, w.root, plan(w.db, ID), STALE)
  expect(unread(w.root)).toHaveLength(1)
})

test('#257 D2 a red xcodebuild test run carries no fault', () => {
  expect(checks(xcode(), APP, () => ({ ok: false, code: '65', output: '** TEST FAILED **' }))).not.toHaveProperty('fault')
})

test('#257 D3 linkd.autoShortcut lines drop; the rest keep order', () => {
  const noise = 'Error Domain=NSCocoaErrorDomain Code=4097 "connection to service named com.apple.linkd.autoShortcut" UserInfo={}'
  const run: Run = () => ({ ok: false, code: '65', output: ['a', noise, 'b', noise, '** TEST FAILED **'].join('\n') })
  expect(checks(xcode(), APP, run)?.output).toBe('a\nb\n** TEST FAILED **')
})

test('#257 D4 hung twice is a fault; hung then green is not', () => {
  const both = replies({ ok: false, code: '1', output: HANG }, { ok: false, code: '1', output: HANG })
  expect(checks(xcode(), APP, both.run)).toMatchObject({ fault: HANG.trim(), retried: true })
  expect(checks(xcode(), APP, replies({ ok: false, code: '1', output: HANG }).run)).toBeNull()
})

test('#257 D5 npm naming CoreSimulator or a hang just refuses', () => {
  const output = `${STALE}\n${HANG}`
  const failed = checks(tree(ONE), OWN, replies({ ok: false, code: '1', output }, { ok: false, code: '1', output }).run)
  expect(failed).toMatchObject({ script: 'test', code: '1' })
  expect(failed).not.toHaveProperty('fault')
})

const KILLED = { ok: false, code: '143', output: ' ✓ a.test.ts (1 test)\n', capped: true } as const

test('#700 D1 a cap-killed npm run with no red test is capped', () => {
  expect(checks(tree(ONE), OWN, replies(KILLED).run)).toMatchObject({ script: 'test', code: '143', capped: true, retried: false })
})

test('#700 D2 a cap-killed run naming a red test is refused',() => {
  const failed = checks(tree(CALLS), OWN, replies({ ...KILLED, output: CALL }).run)
  expect(failed).not.toHaveProperty('capped')
  expect(failed?.tests).toEqual(['a.test.ts:3 a call'])
})

test('#700 D3 a capped failure is a blip on checks:cap', () => {
  const outcome = capped({ script: 'test', command: 'npm run test', code: '143', output: '', tests: [], retried: false, capped: true })
  expect(outcome).toMatchObject({ outcome: 'refuse', blip: true, spans: ['checks:cap'] })
  expect(outcome.note).toContain('timed out')
  expect(outcome.note).not.toContain('exit')
})

const SUITE = { ...ONE, 'a.test.ts': '', 'b.test.ts': '' }

const PAINTED = { ...KILLED, output: ' \u001b[32m✓\u001b[39m a.test.ts \u001b[2m(1 test)\u001b[22m\n' }

test('1550 D1 a capped whole suite names its unfinished files', () => {
  expect(checks(tree(SUITE), OWN, replies(PAINTED).run)).toMatchObject({ capped: true, unfinished: ['b.test.ts'] })
})

test('1550 D2 the capped note lists the unfinished files', () => {
  const failed = checks(tree(SUITE), OWN, replies(PAINTED).run)
  expect(failed && capped(failed)).toMatchObject({ blip: true, spans: ['checks:cap'],
    note: 'npm run test timed out: killed at the cap with no test red; unfinished: b.test.ts' })
})

test('1550 D3 a capped related run lists no unfinished files', () => {
  const failed = checks(tree(SUITE), OWN, replies(PAINTED).run, ['a.ts'])
  expect(failed).toMatchObject({ capped: true })
  expect(failed).not.toHaveProperty('unfinished')
  expect(failed && capped(failed).note).toBe('npm exec -- vitest related --run a.ts timed out: killed at the cap with no test red')
})

test('1550 D6 a capped suite that printed every file adds nothing', () => {
  const failed = checks(tree(SUITE), OWN, replies({ ...KILLED, output: ' ✓ a.test.ts (1 test)\n ✓ b.test.ts (1 test)\n' }).run)
  expect(failed).toMatchObject({ capped: true, unfinished: [] })
  expect(failed && capped(failed).note).toBe('npm run test timed out: killed at the cap with no test red')
})

test('1279 D1 npm given a cap kills a longer run as capped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-cap-'))
  expect(npm(['-e', 'setTimeout(() => {}, 5000)'], dir, 'node', 200)).toMatchObject({ ok: false, capped: true })
})

test('1279 D2 finish passes minutes to run as ms', () => {
  const caps: (number | undefined)[] = []
  const run: Run = (...given) => {
    caps.push(given[3])
    return { ok: true, output: '' }
  }
  const entries = { a: ['node', '-e', 'x'] }
  finish(tree(FOUNDRY), entries, run, 10)
  finish(tree(FOUNDRY), entries, run)
  expect(caps).toEqual([600000, undefined])
})

test('1279 D3 a finish entry the cap killed is capped', () => {
  const killed = finish(tree(FOUNDRY), { a: ['node', '-e', 'x'] }, replies({ ok: false, code: '1', output: '', capped: true }).run)
  expect(killed).toEqual({ script: 'finish', command: 'node -e x', code: '1', output: '', tests: [], retried: false, capped: true })
})

test('#700 D4 a non-zero run the cap did not kill is not capped', () => {
  expect(checks(tree(ONE), OWN, replies({ ok: false, code: '143', output: '' }).run)).not.toHaveProperty('capped')
})

const PYTEST = { ok: false, code: '1', output: 'tests/test_heldout_targets.py ........' } as const

function pytest(ran: Ran): Run {
  return (...[, , bin]) => bin === 'python3' ? ran : { ok: true, output: '' }
}

test('1381 D1 a fuzz-bench pytest the cap killed is capped', () => {
  const failed = checks(tree(FOUNDRY), BENCH, pytest({ ...PYTEST, capped: true }))
  expect(failed).toMatchObject({ script: 'pytest', capped: true })
  expect(failed && capped(failed)).toMatchObject({ spans: ['checks:cap'], blip: true })
})

test('1381 D2 a fuzz-bench pytest at exit 1 is not capped', () => {
  const failed = checks(tree(FOUNDRY), BENCH, pytest(PYTEST))
  expect(failed).toMatchObject({ script: 'pytest', code: '1' })
  expect(failed).not.toHaveProperty('capped')
})

test('1394 D1 D2 pytest alone runs under the minutes cap', () => {
  const caps: (number | undefined)[] = []
  const run: Run = (...given) => {
    caps.push(given[3])
    return { ok: true, output: '' }
  }
  checks(tree(FOUNDRY), BENCH, run, [], null, [], 60)
  checks(tree(FOUNDRY), BENCH, run)
  expect(caps).toEqual([undefined, undefined, 3600000, undefined, undefined, undefined])
})

test('1524 D1 npm run test alone runs under the long cap', () => {
  const caps: (number | undefined)[] = []
  const run: Run = (...given) => {
    caps.push(given[3])
    return { ok: true, output: '' }
  }
  checks(tree(THREE), OWN, run)
  expect(caps).toEqual([undefined, undefined, 2700000])
})

test('1394 D4 a pytest capped under minutes is still capped', () => {
  const failed = checks(tree(FOUNDRY), BENCH, pytest({ ...PYTEST, capped: true }), [], null, [], 60)
  expect(failed).toMatchObject({ script: 'pytest', capped: true })
})

test('1381 D3 an xcodebuild run the cap killed is not capped', () => {
  const failed = checks(xcode(), APP, replies({ ok: false, code: '1', output: 'building', capped: true }).run)
  expect(failed).toMatchObject({ code: '1' })
  expect(failed).not.toHaveProperty('capped')
})

/** Our own profile's yml ends in its `commands:` block, so atelier's xcodebuild line lands under it. */
function xcoded(w: World): void {
  appendFileSync(join(w.root, 'profiles', 'caliperforge', 'caliperforge.yml'), `  xcodebuild: ${JSON.stringify(APP.xcodebuild)}\n`)
}

test('#257 D6 a faulted step 3 stays put with no checks verdict', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'cf-bin-'))
  writeFileSync(join(bin, 'xcodebuild'), `#!/bin/sh\necho '${STALE}'\nexit 70\n`, { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path ?? ''}`
  try {
    const w = mine(GREEN)
    xcoded(w)
    for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))
    mkdirSync(join(srcDir(w.root, ID), 'Atelier.xcodeproj'))
    const fired = (await tick(w.db, w.root, stub(CARRIED)))[0]
    expect(fired).toMatchObject({ plan: ID, step: 3, name: 'rails', spans: ['xcode'] })
    expect(plan(w.db, ID)).toMatchObject({ step: 3, retries: 0 })
    expect(verdictRows(w.db, ID).filter((v) => v.rail_id === 'checks')).toEqual([])
  } finally {
    process.env.PATH = path
  }
}, SLOW)

const LOG = join(import.meta.dirname, 'fixtures', 'host-exit.log')
const EXITED = readFileSync(LOG, 'utf8')
const CARDS = 'AtelierTests/FloorDecisionCardsTests.swift'

function atelier(): string {
  const src = xcode()
  mkdirSync(join(src, 'AtelierTests'))
  writeFileSync(join(src, CARDS), ATELIER[CARDS])
  return src
}

test('#352 D1 a host exit outside the diff earns one re-run', () => {
  const twice = replies({ ok: false, code: '65', output: EXITED }, { ok: true, output: '' })
  expect(checks(atelier(), APP, twice.run, [], null, ['src/hello.ts'])).toBeNull()
  expect(twice.seen).toHaveLength(2)
  expect(twice.seen[1]).toBe(twice.seen[0])
})

test('#352 D2 a host exit in the diff is refused after one run', () => {
  const once = replies({ ok: false, code: '65', output: EXITED }, { ok: true, output: '' })
  expect(checks(atelier(), APP, once.run, [], null, [CARDS])).toMatchObject({ code: '65', retried: false })
  expect(once.seen).toHaveLength(1)
})

test('#352 D3 a host exit on both runs refuses with the second', () => {
  const again = `${EXITED}again`
  const both = replies({ ok: false, code: '65', output: EXITED }, { ok: false, code: '66', output: again })
  expect(checks(atelier(), APP, both.run)).toMatchObject({ code: '66', output: again, retried: true })
})

test('#352 D4 D5 no restart line or known class refuses at once', () => {
  const without = (text: string): string => EXITED.split('\n').filter((line) => !line.startsWith(text)).join('\n')
  for (const [src, output] of [[atelier(), without('Restarting')], [atelier(), without('\tFloorDecisionCardsTests')], [xcode(), EXITED]] as const) {
    const once = replies({ ok: false, code: '65', output }, { ok: true, output: '' })
    expect(checks(src, APP, once.run)).toMatchObject({ code: '65', retried: false })
    expect(once.seen).toHaveLength(1)
  }
})

/** Step 3 of an Atelier plan under a fake `xcodebuild` printing the fixture and exiting 65, or passing from its second run when `settles`. */
async function exits(settles: boolean): Promise<{ w: World; fired: Awaited<ReturnType<typeof tick>>[number] | undefined }> {
  const bin = mkdtempSync(join(tmpdir(), 'cf-bin-'))
  const green = settles ? '[ -e "$0.ran" ] && exit 0\ntouch "$0.ran"\n' : ''
  writeFileSync(join(bin, 'xcodebuild'), `#!/bin/sh\n${green}cat '${LOG}'\nexit 65\n`, { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path ?? ''}`
  try {
    const w = mine(ATELIER)
    xcoded(w)
    for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))
    mkdirSync(join(srcDir(w.root, ID), 'Atelier.xcodeproj'))
    return { w, fired: (await tick(w.db, w.root, stub(CARRIED)))[0] }
  } finally {
    process.env.PATH = path
  }
}

test('#352 D6 an outside host exit then green moves to step 4', async () => {
  const { w } = await exits(true)
  expect(plan(w.db, ID).step).toBe(4)
}, SLOW)

test('#352 D6 a host exit twice goes to step 2 on checks:test', async () => {
  const { w, fired } = await exits(false)
  expect(plan(w.db, ID).step).toBe(2)
  expect(fired).toMatchObject({ outcome: 'refuse', spans: ['checks:test'], note: expect.stringMatching(/exit 65 after one retry$/) as string })
}, SLOW)

/** A step 3 checks lock another plan's tick left, naming `pid`. */
function locked(w: World, pid: number): string {
  const path = join(w.root, '.cf', 'checks.lock')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ plan: 9, pid, taken_at: new Date().toISOString() }))
  return path
}

test('a live tick\'s checks lock holds step 3, running nothing', async () => {
  const w = mine(GREEN)
  locked(w, process.ppid)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))

  const fired = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(fired).toMatchObject({ plan: ID, step: 3, name: 'rails', note: 'checks wait: plan 9 is running its tests' })
  expect(plan(w.db, ID).step).toBe(3)
  expect(verdictRows(w.db, ID).filter((v) => v.rail_id === 'checks')).toEqual([])
}, SLOW)

test('a dead holder\'s checks lock is taken, then released', async () => {
  for (const [scripts, step] of [[GREEN, 4], [RED, 2]] as const) {
    const w = mine(scripts)
    const path = locked(w, spawnSync('/usr/bin/true').pid)
    for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, stub(CARRIED))
    expect(plan(w.db, ID).step).toBe(step)
    expect(existsSync(path)).toBe(false)
  }
}, SLOW)

test('D3 a kotlin checkout runs gradle check', () => {
  const src = tree({})
  mkdirSync(join(src, 'kotlin'))
  const bins: string[] = []
  const seen: string[] = []
  const run: Run = (...[args, , bin]) => { bins.push(bin ?? 'npm'); seen.push(args.join(' ')); return { ok: true, output: '' } }
  expect(mode(src)).toBe('gradle')
  expect(checks(src, {}, run)).toBeNull()
  expect([bins, seen]).toEqual([['gradle'], ['-p kotlin check']])
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

test('#204 outside ruby runs Justfile gates in ruby/, never npm', () => {
  const src = nested({ 'package.json': pkg({ test: 'vitest run' }), 'ruby/Justfile': JUST, 'ruby/Gemfile': '', 'ruby/lib/pay_kit/config.rb': '' })
  const { run, calls } = heard()
  expect(checks(src, {}, run, [], { language: 'ruby', files: ['docs/x.md', 'ruby/lib/pay_kit/config.rb'] })).toBeNull()
  const at = join(src, 'ruby')
  expect(calls).toEqual([`just --justfile Justfile install @${at}`, `just --justfile Justfile lint @${at}`, `just --justfile Justfile test @${at}`])
})

test('#192 outside rust runs CI\'s fmt check, then touched crates', () => {
  const src = nested({
    'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
    'crates/core/Cargo.toml': '[package]\nname = "surfpool-core"\nversion = "0.1.0"\n',
    'crates/types/Cargo.toml': '[package]\nname = "surfpool-types"\n',
    '.github/workflows/rust.yml': 'jobs:\n  fmt:\n    steps:\n      - name: Run Cargo fmt\n        run: cargo +nightly fmt --all -- --check\n',
  })
  const { run, calls } = heard()
  const files = ['crates/types/src/types.rs', 'crates/core/src/rpc/a.rs', 'crates/core/src/b.rs', 'crates/sdk-node/kit/generated/index.ts']
  expect(checks(src, {}, run, [], { language: 'rust', files })).toBeNull()
  expect(calls).toEqual([`cargo +nightly fmt --all -- --check @${src}`, `cargo test -p surfpool-types -p surfpool-core @${src}`])
})

test('#192 no CI fmt line falls back to cargo fmt --all --check', () => {
  const src = nested({ 'rust/Cargo.toml': '[workspace]\n', 'rust/crates/kit/Cargo.toml': '[package]\nname = "pay-kit"\n' })
  const { run, calls } = heard()
  expect(checks(src, {}, run, [], { language: 'rust', files: ['rust/crates/kit/src/lib.rs'] })).toBeNull()
  const at = join(src, 'rust')
  expect(calls).toEqual([`cargo fmt --all -- --check @${at}`, `cargo test -p pay-kit @${at}`])
})

test('#192 a red fmt check refuses with the diff, named by folder', () => {
  const src = nested({ 'Cargo.toml': '[package]\nname = "x"\n' })
  const { run } = heard({ ok: false, code: '1', output: 'Diff in src/lib.rs at line 3' })
  expect(checks(src, {}, run, [], { language: 'rust', files: ['src/lib.rs'] }))
    .toEqual({ script: 'format', command: 'cargo fmt --all -- --check', code: '1', output: 'Diff in src/lib.rs at line 3', tests: [], retried: false })
})

test('#204 bare go runs gofmt, vet and test; gofmt output fails', () => {
  const src = nested({ 'go/go.mod': 'module x\n', 'go/config.go': '' })
  const { run, calls } = heard({ ok: true, output: 'config.go\n' })
  expect(checks(src, {}, run, [], { language: 'go', files: ['go/config.go'] }))
    .toMatchObject({ script: 'format', command: 'gofmt -s -l . (in go/)', code: '1', output: 'config.go\n' })
  expect(calls).toEqual([`gofmt -s -l . @${join(src, 'go')}`])
})

/** A shell recording the tool each `uv run --no-project` gate names, red on `red`. */
function tool(red: string): { run: Run; seen: string[] } {
  const seen: string[] = []
  return { seen, run: (args) => { const name = args[8] ?? ''; seen.push(name); return name === red ? { ok: false, code: '1', output: 'boom' } : { ok: true, output: '' } } }
}

test('1181a D3 a red pytest is test; a red ruff stops there', () => {
  const src = nested({ 'pyrightconfig.json': '', 'smoke/check_leak.py': '', 'tests/test_smoke_leak.py': '' })
  const python: Outside = { language: 'python', files: ['smoke/check_leak.py', 'tests/test_smoke_leak.py'] }
  const pytest = tool('python')
  expect(checks(src, {}, pytest.run, [], python)).toMatchObject({ script: 'test', code: '1' })
  expect(pytest.seen).toEqual(['ruff', 'pyright', 'python'])
  const ruff = tool('ruff')
  expect(checks(src, {}, ruff.run, [], python)).toMatchObject({ script: 'lint' })
  expect(ruff.seen).toEqual(['ruff'])
})

/** A shell where only the `test` gate fails, at `code`. */
function collected(code: string): Run {
  return (args) => (['pytest', 'test'].includes(args.at(-1) ?? '') ? { ok: false, code, output: 'no tests ran' } : { ok: true, output: '' })
}

const LOOSE: Outside = { language: 'python', files: ['test.py'] }

test('1481 D1 pytest exit 5 passes beside run_tests.sh', () => {
  const lines: string[] = []
  expect(checks(nested({ 'test.py': '', 'run_tests.sh': '' }), {}, collected('5'), [], LOOSE, [], undefined, (line) => { lines.push(line) })).toBeNull()
  expect(lines).toEqual(["pytest collected no tests (exit 5); run_tests.sh runs this repo's tests"])
})

test('1481 D2 pytest exit 5 with no runner script fails', () => {
  expect(checks(nested({ 'test.py': '' }), {}, collected('5'), [], LOOSE)).toMatchObject({ script: 'test', code: '5' })
})

test('1481 D3 pytest exit 1 beside run_tests.sh fails', () => {
  expect(checks(nested({ 'test.py': '', 'run_tests.sh': '' }), {}, collected('1'), [], LOOSE)).toMatchObject({ script: 'test', code: '1' })
})

test('1481 D4 a Justfile test exit 5 beside run_tests.sh fails', () => {
  const src = nested({ 'run_tests.sh': '', 'ruby/Justfile': JUST, 'ruby/Gemfile': '', 'ruby/run_tests.sh': '', 'ruby/lib/a.rb': '' })
  expect(checks(src, {}, collected('5'), [], { language: 'ruby', files: ['ruby/lib/a.rb'] })).toMatchObject({ script: 'test', code: '5' })
})

test('#204 a recipe the Justfile does not define is not run', () => {
  const src = nested({ 'lua/Justfile': 'test:\n    luajit tests/run.lua\n', 'lua/pay-kit-dev-1.rockspec': '', 'lua/pay_kit/a.lua': '' })
  const { run, calls } = heard()
  expect(checks(src, {}, run, [], { language: 'lua', files: ['lua/pay_kit/a.lua'] })).toBeNull()
  expect(calls).toEqual([`just --justfile Justfile test @${join(src, 'lua')}`])
})

test('#204 the recipe reader skips settings and takes parameters', () => {
  const src = nested({ 'Justfile': 'set shell := ["bash", "-uc"]\nuv_run := "uv run"\n\ndefault:\n    @just --list\n\ntest-cover gate="90":\n    x\n\n@lint:\n    y\n' })
  expect([...(recipes(join(src, 'Justfile')) ?? [])]).toEqual(['default', 'test-cover', 'lint'])
  expect(formatLine(src)).toEqual(['fmt', '--all', '--', '--check'])
})

test('#204 rust tests take CI features, less services, per crate', () => {
  const src = nested({
    'Cargo.toml': '[workspace]\n',
    'crates/core/Cargo.toml': '[package]\nname = "surfpool-core"\n\n[features]\ndefault = ["sqlite"]\npostgres = []\nignore_tests_ci = []\n\n[dependencies]\n',
    'crates/types/Cargo.toml': '[package]\nname = "surfpool-types"\n\n[features]\ndefault = []\n',
    '.github/workflows/rust.yml': 'jobs:\n  build:\n    services:\n      postgres:\n        image: postgres:15\n    steps:\n'
      + '      - run: cargo test --all --verbose --features "postgres,ignore_tests_ci"\n',
  })
  expect(ciFeatures(src)).toEqual(['ignore_tests_ci'])
  const { run, calls } = heard()
  expect(checks(src, {}, run, [], { language: 'rust', files: ['crates/types/src/types.rs', 'crates/core/src/types.rs'] })).toBeNull()
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

test('#221 outside rust stages, runs CI\'s generator, then diffs', () => {
  const src = surfpool(BINDINGS)
  const { run, calls } = heard()
  expect(checks(src, {}, run, [], { language: 'rust', files: ['crates/core/src/a.rs'] })).toBeNull()
  expect(calls).toEqual([`cargo +nightly fmt --all -- --check @${src}`, `cargo test -p surfpool-core @${src}`, `git add -A @${src}`,
    `node crates/sdk-node/scripts/generate-kit-types.js @${src}`, `git diff --exit-code @${src}`])
})

test('#221 a red diff after regenerating refuses with the diff', () => {
  const src = surfpool(BINDINGS)
  const run: Run = (...[args, , bin]) => `${bin ?? 'npm'} ${args.join(' ')}` === 'git diff --exit-code' ? { ok: false, code: '1', output: '-a\n+b' } : { ok: true, output: '' }
  expect(checks(src, {}, run, [], { language: 'rust', files: ['crates/core/src/a.rs'] }))
    .toEqual({ script: 'diff', command: 'git diff --exit-code', code: '1', output: '-a\n+b', tests: [], retried: false })
})

test('#221 a diff step with no generator or a shell adds no gate', () => {
  const src = surfpool('jobs:\n  a:\n    steps:\n      - run: |\n          cd x && node gen.js\n          git diff --exit-code\n      - run: git diff --exit-code\n')
  const { run, calls } = heard()
  expect(checks(src, {}, run, [], { language: 'rust', files: ['crates/core/src/a.rs'] })).toBeNull()
  expect(calls).toEqual([`cargo +nightly fmt --all -- --check @${src}`, `cargo test -p surfpool-core @${src}`])
})

const PAY = { 'rust/Cargo.toml': '[workspace]\n', 'rust/crates/core/Cargo.toml': '[package]\nname = "pay-core"\n' }
const KIT: Outside = { language: 'rust', files: ['rust/crates/core/src/lib.rs'] }
const SURFPOOL = '-p pay-core --test surfpool_tests'
const SURFPOOL_RED = `error: test failed, to rerun pass \`${SURFPOOL}\`\n`

function cargoRed(output: string): { run: Run; calls: string[] } {
  const calls: string[] = []
  const run: Run = (...[args, , bin]) => {
    calls.push(`${bin ?? 'npm'} ${args.join(' ')}`)
    return args[0] === 'test' ? { ok: false, code: '101', output } : { ok: true, output: '' }
  }
  return { run, calls }
}

test('1122 D3 an excused crate under test adds --no-fail-fast', () => {
  const src = nested(PAY)
  const at = join(src, 'rust')
  for (const [excused, args] of [[[SURFPOOL], 'test -p pay-core --no-fail-fast'], [[], 'test -p pay-core'], [['-p pay-kit --test x'], 'test -p pay-core']] as const) {
    const { run, calls } = heard()
    expect(checks(src, { excused: [...excused] }, run, [], KIT)).toBeNull()
    expect(calls[1]).toBe(`cargo ${args} @${at}`)
  }
})

test('1122 D4 a red run of only excused spans runs on', () => {
  const src = nested({ ...PAY, '.github/workflows/sdk.yml': BINDINGS })
  const { run, calls } = cargoRed(SURFPOOL_RED)
  expect(checks(src, { excused: [SURFPOOL] }, run, [], KIT)).toBeNull()
  expect(calls.slice(1)).toEqual(['cargo test -p pay-core --no-fail-fast', 'git add -A', 'node crates/sdk-node/scripts/generate-kit-types.js', 'git diff --exit-code'])
})

test('1122 D5 an unexcused span, or none, still refuses', () => {
  const src = nested(PAY)
  for (const output of [`${SURFPOOL_RED}error: test failed, to rerun pass \`-p pay-core --test server_tests\`\n`, 'error: could not compile `pay-core`\n']) {
    const { run } = cargoRed(output)
    expect(checks(src, { excused: [SURFPOOL] }, run, [], KIT))
      .toEqual({ script: 'test', command: 'cargo test -p pay-core --no-fail-fast (in rust/)', code: '101', output, tests: [], retried: false })
  }
})

test('a program that never starts is named', () => {
  expect(npm(['--version'], tmpdir(), 'cf-no-such-bin')).toEqual({ ok: false, code: '127', output: expect.stringMatching(/^cf-no-such-bin: spawnSync cf-no-such-bin ENOENT/) as string })
})
