import { execFileSync } from 'node:child_process'
import { cpSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { expect, test } from 'vitest'
import { dropPlan } from '../../store/plans.ts'
import { tick } from '../index.ts'
import type { Wire } from '../push.ts'
import { get, planDir, put, SELF, srcDir } from '../workspace.ts'
import { built, CARRIED, internalPlan, ours, plan, stub, watched, world, type World } from './world.ts'

const ID = 2
const BRANCH = 'p2-let-an-internal-plan-run'
const PAY = 'caliperforge/pay'

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function commit(dir: string, file: string): void {
  writeFileSync(join(dir, file), `export const ${file.replace('.ts', '')} = 1\n`)
  git(dir, ['add', '-A'])
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', file])
}

/** Our repo copied to pay with one commit past it, a `redesign` branch on pay, and an internal plan whose ask carries `lines`. */
function forked(lines: string[]): { w: World; pay: string } {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, ID)
  ask(w, lines)
  const pay = join(w.root, 'remotes', PAY)
  cpSync(join(w.root, 'remotes', SELF), pay, { recursive: true })
  commit(pay, 'pay.ts')
  git(pay, ['checkout', '-q', '-b', 'redesign'])
  commit(pay, 'redesign.ts')
  git(pay, ['checkout', '-q', 'main'])
  return { w, pay }
}

function ask(w: World, lines: string[]): void {
  put(w.root, ID, 'ask.md', `${get(w.root, ID, 'ask.md')}${lines.map((l) => `\n${l}\n`).join('')}`)
}

function pushing(log: string[], w: World): Wire {
  return { ...watched(log, w.root, ID),
    send: (dir, branch) => { log.push(`send ${basename(dir)} ${branch}`); git(dir, ['push', '-q', 'origin', branch]) },
    close: (repo, no, sha, comment) => void log.push(`close ${repo}#${String(no)} ${sha.slice(0, 7)} ${String(comment)}`) }
}

async function laps(w: World, n: number, wire: Wire): Promise<void> {
  for (let at = 0; at < n; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
}

const origin = (w: World): string => git(srcDir(w.root, ID), ['remote', 'get-url', 'origin'])

const stale = (w: World): string[] => readdirSync(planDir(w.root, ID)).filter((f) => f.startsWith('src.stale-'))

test('D1 D3 a Fork: ask clones pay and lands on its main', async () => {
  const { w, pay } = forked(['Fork: caliperforge/pay'])
  const log: string[] = []
  const wire = pushing(log, w)
  const ourMain = git(join(w.root, 'remotes', SELF), ['rev-parse', 'main'])

  await laps(w, 3, wire)
  expect(origin(w)).toBe(pay)
  expect(get(w.root, ID, 'base.sha').trim()).toBe(git(pay, ['rev-parse', 'main']))
  built(w.root, ID, 'export const landed = true')
  await laps(w, 4, wire)
  expect(plan(w.db, ID).step).toBe(7)

  await laps(w, 1, wire)
  const sha = git(srcDir(w.root, ID), ['rev-parse', BRANCH])
  expect(log.slice(-2)).toEqual(['send src main', `close ${SELF}#34 ${sha.slice(0, 7)} landed on main as ${sha}`])
  expect(git(pay, ['rev-parse', 'main'])).toBe(sha)
  expect(git(join(w.root, 'remotes', SELF), ['rev-parse', 'main'])).toBe(ourMain)

  const pushed = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(pushed).toMatchObject({ step: 8, outcome: 'pass', note: `on main at https://github.com/${PAY}/commit/${sha}` })
})

test('D2 Fork: with Base: cuts from and lands on pay redesign', async () => {
  const { w, pay } = forked(['Fork: caliperforge/pay', 'Base: redesign'])
  const log: string[] = []
  const wire = pushing(log, w)

  await laps(w, 3, wire)
  expect(git(srcDir(w.root, ID), ['config', 'cf.base'])).toBe('redesign')
  expect(get(w.root, ID, 'base.sha').trim()).toBe(git(pay, ['rev-parse', 'redesign']))
  built(w.root, ID, 'export const landed = true')
  await laps(w, 5, wire)

  const sha = git(srcDir(w.root, ID), ['rev-parse', BRANCH])
  expect(log).toContain('send src main:refs/heads/redesign')
  expect(git(pay, ['rev-parse', 'redesign'])).toBe(sha)
})

test('D4 a kernel clone whose ask gains Fork: is cloned from pay', async () => {
  const { w, pay } = forked([])
  const wire = watched([], w.root, ID)
  await laps(w, 2, wire)
  expect(origin(w)).toBe(join(w.root, 'remotes', SELF))
  expect(plan(w.db, ID).step).toBe(2)

  ask(w, ['Fork: caliperforge/pay'])
  await laps(w, 1, wire)
  expect(origin(w)).toBe(pay)
  expect(stale(w)).toHaveLength(1)
})

test('D5 a Fork: outside caliperforge leaves the tree on ours', async () => {
  const { w } = forked(['Fork: acme/widget'])
  await laps(w, 3, watched([], w.root, ID))
  expect(origin(w)).toBe(join(w.root, 'remotes', SELF))
})

test('D6 a plan with no Fork: line is never cloned again', async () => {
  const { w } = forked([])
  await laps(w, 3, watched([], w.root, ID))
  expect(origin(w)).toBe(join(w.root, 'remotes', SELF))
  expect(stale(w)).toEqual([])
})
