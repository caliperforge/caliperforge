import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { eventsOf } from '../../store/events.ts'
import { dropPlan, rewind } from '../../store/plans.ts'
import { tick } from '../index.ts'
import { CARRY, checkout, get, git, maybe, put, SELF, srcDir } from '../workspace.ts'
import { OURS, WORLDS } from './bases.ts'
import { built, CARRIED, internalPlan, ours, stub, watched, world, type World } from './world.ts'

const ID = 2
const BRANCH = 'p2-let-an-internal-plan-run'
const EDIT = 'export const edited = true'

/** Our repo with a `redesign` branch one commit past `main`, and an internal plan whose ask names no base. */
function redesign(): { w: World; tip: string } {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, ID)
  const remote = join(w.root, 'remotes', SELF)
  git(remote, ['checkout', '-q', '-b', 'redesign'])
  writeFileSync(join(remote, 'redesign.ts'), 'export const redesign = 1\n')
  git(remote, ['add', '-A'])
  git(remote, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'redesign'])
  const tip = git(remote, ['rev-parse', 'HEAD']).trim()
  git(remote, ['checkout', '-q', 'main'])
  return { w, tip }
}

function gitless(run: () => void): void {
  const path = process.env.PATH
  process.env.PATH = mkdtempSync(join(tmpdir(), 'cf-path-'))
  try { run() } finally { process.env.PATH = path }
}

test('D1 world and ours trees copy from base with no git on PATH', () => {
  gitless(() => {
    for (const [files, ci] of WORLDS) {
      const { root } = world('warm', undefined, files, ci)
      for (const repo of ['acme/widget', 'caliperforge/widget']) expect(existsSync(join(root, 'remotes', repo, '.git/HEAD'))).toBe(true)
    }
    for (const [files, ci] of OURS) {
      const { root } = world()
      ours(root, files, ci)
      expect(existsSync(join(root, 'remotes', SELF, '.git/HEAD'))).toBe(true)
    }
  })
})

test('D2 a tree with no base throws and names it', () => {
  gitless(() => {
    const { root } = world()
    expect(() => world('warm', undefined, { 'nope.ts': '' })).toThrow('nope.ts')
    expect(() => { ours(root, { 'nope.ts': '' }) }).toThrow('nope.ts')
  })
})

test('D1 a main clone checked out from redesign is cut again', () => {
  const { w, tip } = redesign()
  checkout(w.root, ID, SELF, BRANCH)
  built(w.root, ID, EDIT)
  expect(checkout(w.root, ID, SELF, BRANCH, 'redesign').recut).toBe('main')
  expect(git(srcDir(w.root, ID), ['config', 'cf.base']).trim()).toBe('redesign')
  expect(get(w.root, ID, 'base.sha').trim()).toBe(tip)
  expect(get(w.root, ID, CARRY)).toContain(`+${EDIT}`)
})

test('D2 a clone checked out from its own base is reused', () => {
  const { w } = redesign()
  checkout(w.root, ID, SELF, BRANCH)
  built(w.root, ID, EDIT)
  expect(checkout(w.root, ID, SELF, BRANCH).recut).toBeNull()
  expect(maybe(w.root, ID, CARRY)).toBeNull()
  expect(readFileSync(join(srcDir(w.root, ID), 'src/hello.ts'), 'utf8')).toContain(EDIT)
})

test('D3 a tick that cuts the clone again logs base_recut', async () => {
  const { w } = redesign()
  const wire = watched([], w.root, ID)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  built(w.root, ID, EDIT)
  expect(eventsOf(w.db, ID, 'base_recut')).toEqual([])
  put(w.root, ID, 'ask.md', `${get(w.root, ID, 'ask.md')}\nBase: redesign\n`)
  rewind(w.db, ID, 2)
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(eventsOf(w.db, ID, 'base_recut')).toEqual([
    { actor: 'workspace', outcome: 'pass', message: 'cut again from redesign: the clone was cut from main' }])
})
