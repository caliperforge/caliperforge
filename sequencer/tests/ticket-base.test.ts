import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { expect, test } from 'vitest'
import { dropPlan } from '../../store/plans.ts'
import { tick } from '../index.ts'
import { land, type Wire } from '../push.ts'
import { get, put, SELF, srcDir } from '../workspace.ts'
import { built, CARRIED, internalPlan, ours, plan, stub, watched, world, type World } from './world.ts'

const ID = 2
const BRANCH = 'p2-let-an-internal-plan-run'

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** Our repo with a `redesign` branch one commit past `main`, and an internal plan whose ask names it or not. */
function redesign(base: boolean): { w: World; remote: string } {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, ID)
  if (base) put(w.root, ID, 'ask.md', `${get(w.root, ID, 'ask.md')}\nBase: redesign\n`)
  const remote = join(w.root, 'remotes', SELF)
  git(remote, ['checkout', '-q', '-b', 'redesign'])
  writeFileSync(join(remote, 'redesign.ts'), 'export const redesign = 1\n')
  git(remote, ['add', '-A'])
  git(remote, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'redesign'])
  git(remote, ['checkout', '-q', 'main'])
  return { w, remote }
}

/** The watched log with a real push, and the close comment after the sha. */
function pushing(log: string[], w: World): Wire {
  return { ...watched(log, w.root, ID),
    send: (dir, branch) => { log.push(`send ${basename(dir)} ${branch}`); git(dir, ['push', '-q', 'origin', branch]) },
    close: (repo, no, sha, comment) => void log.push(`close ${repo}#${String(no)} ${sha.slice(0, 7)} ${String(comment)}`) }
}

async function laps(w: World, n: number, wire: Wire): Promise<void> {
  for (let at = 0; at < n; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
}

test('D1 D2 D4 a Base: ask is cut from and lands on redesign', async () => {
  const { w, remote } = redesign(true)
  const log: string[] = []
  const wire = pushing(log, w)
  const tip = git(remote, ['rev-parse', 'redesign'])
  const main = git(remote, ['rev-parse', 'main'])

  await laps(w, 3, wire)
  const src = srcDir(w.root, ID)
  expect(git(src, ['config', 'cf.base'])).toBe('redesign')
  expect(get(w.root, ID, 'base.sha').trim()).toBe(tip)
  built(w.root, ID, 'export const landed = true')
  await laps(w, 4, wire)
  expect(plan(w.db, ID).step).toBe(7)

  const landed = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  const sha = git(src, ['rev-parse', BRANCH])
  expect(landed).toMatchObject({ step: 7, outcome: 'pass', note: `landed ${BRANCH} on redesign as ${sha.slice(0, 12)}` })
  expect(log.slice(-2)).toEqual(['send src main:refs/heads/redesign', `close ${SELF}#34 ${sha.slice(0, 7)} landed on redesign as ${sha}`])
  expect(git(remote, ['rev-parse', 'redesign'])).toBe(sha)
  expect(git(remote, ['rev-parse', 'main'])).toBe(main)

  const pushed = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(pushed).toMatchObject({ step: 8, outcome: 'pass', note: `on redesign at https://github.com/${SELF}/commit/${sha}` })
})

test('D3 a main cut whose ask gains Base: is refused base:branch', async () => {
  const { w } = redesign(false)
  const wire = watched([], w.root, ID)
  await laps(w, 3, wire)
  built(w.root, ID, 'export const landed = true')
  await laps(w, 4, wire)
  expect(plan(w.db, ID).step).toBe(7)
  put(w.root, ID, 'ask.md', `${get(w.root, ID, 'ask.md')}\nBase: redesign\n`)

  const log: string[] = []
  expect(land(w.db, w.root, plan(w.db, ID), 1, watched(log, w.root, ID))).toMatchObject({ outcome: 'refuse', spans: ['base:branch'] })
  expect(log).toEqual([])
})
