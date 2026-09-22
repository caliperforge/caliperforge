import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { record } from '../../store/files.ts'
import { checks, type Run } from '../checks.ts'
import { tick } from '../index.ts'
import { narrow } from '../rails.ts'
import { get } from '../workspace.ts'
import { approve, CARRIED, internalPlan, ours, plan, stub, TYPESCRIPT, world, type World } from './world.ts'

const ID = 2

const RED = { lint: 'node -e "process.stderr.write(\'lint is red\'); process.exit(3)"' }

const TIMEOUT = ' FAIL x.test.ts > a lap\nError: Test timed out in 5000ms.\n'
const BOUND = '   × a lap 1066ms\n     → expected 1066 to be less than 1000\n'
const ASSERTED = ' FAIL x.test.ts > a call\nAssertionError: expected "hi" to be "ho"\n'
const SILENT = ' FAIL x.test.ts > a call\n'

const NAPPING = { test: `node -e "process.stderr.write('${TIMEOUT.replaceAll('\n', '\\n')}'); process.exit(1)"` }

const SLOW = 30000

function pkg(scripts: Record<string, string>): string {
  return JSON.stringify({ name: 'x', private: true, scripts })
}

const ONE = { 'package.json': pkg({ test: 'vitest run' }) }

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-checks-'))
  for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), body)
  return dir
}

/** A shell answering each call in turn, so a retry of the same command meets the next answer. */
function replies(...answers: { code: number; output: string }[]): { run: Run; seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    run: (args) => {
      seen.push(args.join(' '))
      return answers[seen.length - 1] ?? { code: 0, output: '' }
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
      return command === red ? { code: 2, output: 'boom' } : { code: 0, output: '' }
    },
  }
}

/** Our own repo carrying the scripts, so the plan's checkout is the one the checks run in. */
function mine(scripts: Record<string, string>): World {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root, { ...TYPESCRIPT, 'package.json': pkg(scripts) })
  internalPlan(w.db, w.root, ID)
  return w
}

test('the three scripts run in order and stop at the first non-zero exit, which the failure names', () => {
  const all = recorder('run lint')
  const src = tree({ 'package.json': pkg({ typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'vitest run' }) })
  expect(checks(src, all.run)).toEqual({ script: 'lint', command: 'npm run lint', code: 2, output: 'boom', retried: false })
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
}, SLOW)

test('a timeout-only failure runs the command once more, and the second run is the one that settles it', () => {
  const twice = replies({ code: 1, output: TIMEOUT }, { code: 0, output: '' })
  expect(checks(tree(ONE), twice.run)).toBeNull()
  expect(twice.seen).toEqual(['run test', 'run test'])
})

test('an assertion failure is refused on the first run and never retried', () => {
  const once = replies({ code: 1, output: ASSERTED }, { code: 0, output: '' })
  expect(checks(tree(ONE), once.run))
    .toEqual({ script: 'test', command: 'npm run test', code: 1, output: ASSERTED, retried: false })
  expect(once.seen).toEqual(['run test'])
})

test('a failure the output does not account for as load is refused on the first run', () => {
  for (const output of [`${TIMEOUT}${ASSERTED}`, SILENT]) {
    const shell = replies({ code: 1, output }, { code: 0, output: '' })
    expect(checks(tree(ONE), shell.run)).toMatchObject({ command: 'npm run test', code: 1, retried: false })
    expect(shell.seen).toEqual(['run test'])
  }
})

test('load-only on both runs is refused with the second run, and the note names the retry', async () => {
  const both = replies({ code: 1, output: TIMEOUT }, { code: 7, output: BOUND })
  expect(checks(tree(ONE), both.run))
    .toEqual({ script: 'test', command: 'npm run test', code: 7, output: BOUND, retried: true })

  const w = mine(NAPPING)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))

  const fired = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(fired).toMatchObject({ plan: ID, step: 3, outcome: 'refuse', spans: ['checks:test'] })
  expect(fired?.note).toBe('npm run test exit 1 after one retry')
  expect(get(w.root, ID, 'refusal.md')).toContain('after one retry')
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
  expect(checks(src, red.run, ['store/plans.ts'])).toMatchObject({ script: 'test', code: 2 })
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
  expect(checks(tree(files), fresh.run)).toEqual({ script: 'ci', command: 'npm ci', code: 2, output: 'boom', retried: false })
  expect(fresh.seen).toEqual(['ci'])

  const installed = recorder()
  const dir = tree(files)
  mkdirSync(join(dir, 'node_modules'))
  expect(checks(dir, installed.run)).toBeNull()
  expect(installed.seen).toEqual(['run test'])
})

test('a plan on a target runs none of the stranger\'s scripts and passes step 3 as before', async () => {
  const w = world('warm', undefined, { ...TYPESCRIPT, 'package.json': pkg(RED) })
  approve(w.db, w.target)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))

  const fired = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(fired).toMatchObject({ plan: w.plan, step: 3, name: 'rails', outcome: 'pass' })
  expect(plan(w.db, w.plan).step).toBe(4)
}, SLOW)
