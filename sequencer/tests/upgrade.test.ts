import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Db } from '../../store/index.ts'
import { last, receipt, type Receipt } from '../../store/ticks.ts'
import { tick } from '../index.ts'
import { behind, upgrade, upgraded } from '../upgrade.ts'
import { SELF, srcDir } from '../workspace.ts'
import { built, CARRIED, internalPlan, landing, moveMain, ours, stub, watched, world, type World } from './world.ts'

const ID = 2
const LAP: Receipt = { at: '2026-09-21T09:00:00.000Z', hhmm: '09:00', dry: false, pipes: 1, fired: 1, exit: 0,
  note: 'pr-path plan 2 step 7 batch pass' }

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const store = (): Db => fresh(join(import.meta.dirname, '../../schema'))

const version = (db: Db): number => Number(db.pragma('user_version', { simple: true }))

/** The lap of `sequencer/tests/land.test.ts`, with `sql` on the main it lands over and the COO's tree cloned before it. */
async function lands(sql: string, detached = false): Promise<{ w: World; live: string; sha: string }> {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root)
  internalPlan(w.db, w.root, ID)
  const live = mkdtempSync(join(tmpdir(), 'cf-live-'))
  git(live, ['clone', '-q', '--no-local', join(w.root, 'remotes', SELF), live])
  if (detached) git(live, ['checkout', '-q', '--detach'])
  const wire = landing(watched([], w.root, ID))
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  built(w.root, ID, 'export const landed = true')
  moveMain(w.root, 'schema/0018_live.sql', sql)
  for (let at = 0; at < 5; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  return { w, live, sha: git(srcDir(w.root, ID), ['rev-parse', 'main']) }
}

/** A live tree and its remote with a commit each the other has not got: what `--ff-only` exists to refuse. */
function diverged(): { live: string; sha: string } {
  const base = mkdtempSync(join(tmpdir(), 'cf-up-'))
  const origin = join(base, 'origin')
  const live = join(base, 'live')
  mkdirSync(join(origin, 'schema'), { recursive: true })
  writeFileSync(join(origin, 'schema/0018_live.sql'), 'CREATE TABLE live (id INTEGER PRIMARY KEY);\n')
  git(origin, ['init', '-q', '-b', 'main'])
  commit(origin, 'base')
  git(base, ['clone', '-q', '--no-local', origin, live])
  writeFileSync(join(origin, 'landed.ts'), 'export const landed = true\n')
  commit(origin, 'a landing')
  writeFileSync(join(live, 'coo.ts'), 'export const coo = true\n')
  commit(live, 'a commit of the live tree\'s own')
  return { live, sha: git(origin, ['rev-parse', 'HEAD']) }
}

function commit(dir: string, message: string): void {
  git(dir, ['add', '-A'])
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message])
}

test('the tick whose lap lands one of ours leaves the live tree at that commit, migrated', async () => {
  const { w, live, sha } = await lands('CREATE TABLE live (id INTEGER PRIMARY KEY);\n')
  expect(behind(w.db, live)).toBe(sha)

  expect(upgraded(w.db, live, LAP)).toEqual(LAP)
  expect(git(live, ['rev-parse', 'HEAD'])).toBe(sha)
  expect(version(w.db)).toBe(18)
  expect(behind(w.db, live)).toBeNull()
})

test('a live tree with a commit of its own is refused: no ref moves and no schema file runs', () => {
  const { live, sha } = diverged()
  const db = store()
  const head = git(live, ['rev-parse', 'HEAD'])

  const reason = upgrade(db, live, sha)
  expect(reason).toContain(sha.slice(0, 12))
  expect(reason).toContain('main')
  expect(git(live, ['rev-parse', 'HEAD'])).toBe(head)
  expect(git(live, ['rev-parse', 'main'])).toBe(head)
  expect(version(db)).toBe(0)
})

test('a detached tick tree moves forward to the landing, migrated, and its receipt stays clean', async () => {
  const { w, live, sha } = await lands('CREATE TABLE live (id INTEGER PRIMARY KEY);\n', true)

  expect(upgraded(w.db, live, LAP)).toEqual(LAP)
  expect(git(live, ['rev-parse', 'HEAD'])).toBe(sha)
  expect(git(live, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD')
  expect(version(w.db)).toBe(18)
})

test('a detached tick tree carrying a commit of its own is refused and does not move', () => {
  const { live, sha } = diverged()
  git(live, ['checkout', '-q', '--detach'])
  const head = git(live, ['rev-parse', 'HEAD'])

  expect(upgrade(store(), live, sha)).toContain(`HEAD cannot fast-forward to ${sha.slice(0, 12)}`)
  expect(git(live, ['rev-parse', 'HEAD'])).toBe(head)
})

test('a schema file that throws puts the sqlite message in that tick\'s receipt at exit 1', async () => {
  const { w, live } = await lands('CREATE TABLE plans (id INTEGER PRIMARY KEY);\n')

  receipt(w.db, upgraded(w.db, live, LAP))
  const [row] = last(w.db, 1)
  expect(row?.exit).toBe(1)
  expect(row?.note).toContain(`${LAP.note}; migrate to ${git(live, ['rev-parse', 'HEAD']).slice(0, 12)}: `)
  expect(row?.note).toContain('table plans already exists')
  expect(version(w.db)).toBe(0)
})

test('a store with no landing of ours leaves the live tree and its receipt alone', () => {
  const db = store()
  const live = mkdtempSync(join(tmpdir(), 'cf-bare-'))

  expect(behind(db, live)).toBeNull()
  expect(upgraded(db, live, LAP)).toEqual(LAP)
})
