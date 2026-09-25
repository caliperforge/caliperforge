import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Db } from '../../store/index.ts'
import { set } from '../../store/lanes.ts'
import type { Receipt } from '../../store/ticks.ts'
import { saved } from '../hq.ts'

const LAP: Receipt = { at: '2026-09-25T09:00:00.000Z', hhmm: '09:00', dry: false, pipes: 1, fired: 1, exit: 0,
  note: 'pr-path plan 7 step 7 batch pass' }

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const store = (): Db => fresh(join(import.meta.dirname, '../../schema'))

/** An HQ checkout with its own identity, one commit pushed to the bare `remote` it tracks. */
function hq(): { db: Db; dir: string; remote: string } {
  const base = mkdtempSync(join(tmpdir(), 'cf-hq-'))
  const remote = join(base, 'remote.git')
  const dir = join(base, 'hq')
  git(base, ['init', '-q', '--bare', '-b', 'main', remote])
  git(base, ['init', '-q', '-b', 'main', dir])
  git(dir, ['config', 'user.email', 't@t'])
  git(dir, ['config', 'user.name', 't'])
  writeFileSync(join(dir, 'plan.md'), 'plan\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'base'])
  git(dir, ['remote', 'add', 'origin', remote])
  git(dir, ['push', '-q', '-u', 'origin', 'main'])
  const db = store()
  set(db, 'hq.path', dir, 'ceo', '2026-09-25')
  return { db, dir, remote }
}

test('a changed HQ after plan 7 is done gets one commit, pushed', () => {
  const { db, dir, remote } = hq()
  writeFileSync(join(dir, 'plan.md'), 'plan 7 done\n')

  expect(saved(db, LAP, [7])).toEqual({ ...LAP, note: `${LAP.note}; hq: pushed ${git(dir, ['rev-parse', '--short', 'HEAD'])}` })
  expect(git(dir, ['rev-list', '--count', 'HEAD'])).toBe('2')
  expect(git(dir, ['log', '-1', '--format=%s'])).toBe('hq: plan 7')
  expect(git(remote, ['rev-parse', 'main'])).toBe(git(dir, ['rev-parse', 'HEAD']))
})

test('a clean HQ level with its upstream is left alone', () => {
  const { db, dir, remote } = hq()
  const head = git(dir, ['rev-parse', 'HEAD'])

  expect(saved(db, LAP, [7])).toEqual(LAP)
  expect(git(dir, ['rev-parse', 'HEAD'])).toBe(head)
  expect(git(remote, ['rev-parse', 'main'])).toBe(head)
})

test.each(['.env', 'keys/id_ed25519'])('an unignored %s beside a changed file stages and commits nothing', (secret) => {
  const { db, dir } = hq()
  const head = git(dir, ['rev-parse', 'HEAD'])
  writeFileSync(join(dir, 'plan.md'), 'plan 7 done\n')
  mkdirSync(dirname(join(dir, secret)), { recursive: true })
  writeFileSync(join(dir, secret), 'secret\n')

  const lap = saved(db, LAP, [7])
  expect(lap.note).toBe(`${LAP.note}; hq: refused, ${secret} not ignored`)
  expect(git(dir, ['diff', '--cached', '--name-only'])).toBe('')
  expect(git(dir, ['rev-parse', 'HEAD'])).toBe(head)
})

test('an unreachable remote keeps the commit local, and the next job end pushes it', () => {
  const { db, dir, remote } = hq()
  writeFileSync(join(dir, 'plan.md'), 'plan 7 done\n')
  renameSync(remote, `${remote}.gone`)

  const lap = saved(db, LAP, [7])
  expect(lap.note.startsWith(`${LAP.note}; hq: push failed: `)).toBe(true)
  expect(lap.exit).toBe(0)
  expect(git(dir, ['log', '-1', '--format=%s'])).toBe('hq: plan 7')

  renameSync(`${remote}.gone`, remote)
  expect(git(remote, ['rev-parse', 'main'])).not.toBe(git(dir, ['rev-parse', 'HEAD']))
  saved(db, LAP, [8])
  expect(git(remote, ['rev-parse', 'main'])).toBe(git(dir, ['rev-parse', 'HEAD']))
})

test('no done plan, or no HQ path, makes no git call', () => {
  const db = store()
  set(db, 'hq.path', join(tmpdir(), 'cf-hq-nowhere'), 'ceo', '2026-09-25')

  expect(saved(db, LAP, [])).toEqual(LAP)
  expect(saved(store(), LAP, [7])).toEqual(LAP)
})
