import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { checks, type Run } from '../checks.ts'
import { tick } from '../index.ts'
import { get } from '../workspace.ts'
import { approve, CARRIED, internalPlan, ours, plan, stub, TYPESCRIPT, world, type World } from './world.ts'

const ID = 2

const RED = { lint: 'node -e "process.stderr.write(\'lint is red\'); process.exit(3)"' }

const SLOW = 30000

function pkg(scripts: Record<string, string>): string {
  return JSON.stringify({ name: 'x', private: true, scripts })
}

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-checks-'))
  for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), body)
  return dir
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
  expect(checks(src, all.run)).toEqual({ command: 'npm run lint', code: 2, output: 'boom' })
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

test('a checkout with no package.json runs no command', () => {
  const none = recorder()
  expect(checks(tree({ 'readme.md': '# no scripts here\n' }), none.run)).toBeNull()
  expect(none.seen).toEqual([])
})

test('npm ci runs for a lock file with no node_modules, and its own failure refuses the same way', () => {
  const files = { 'package.json': pkg({ test: 'vitest run' }), 'package-lock.json': '{}' }
  const fresh = recorder('ci')
  expect(checks(tree(files), fresh.run)).toEqual({ command: 'npm ci', code: 2, output: 'boom' })
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
