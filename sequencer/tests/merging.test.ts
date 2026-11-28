import { execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { counts } from '../../checks/ratchet.ts'
import { ruleHashes } from '../../checks/rule-hashes.ts'
import { fill, SEED } from '../../cli/digests.ts'
import { open } from '../../store/index.ts'
import { last as lastMerge } from '../../store/merges.ts'
import { dropPlan } from '../../store/plans.ts'
import { tick } from '../index.ts'
import { merging } from '../merging.ts'
import { cloned, get, MAIN, SELF, srcDir } from '../workspace.ts'
import { git } from './bases.ts'
import { built, internalPlan, moveMain, ours, owning, plan, stub, watched, world, type World } from './world.ts'

const NOW = new Date('2026-09-27T12:00:00Z')

const TARGET = { repo: 'acme/widget', issue_no: 12, named_merger: 'maintainer' }

const ago = (days: number): string => new Date(NOW.getTime() - days * 86400000).toISOString()

const pr = (author: string | null, merger: string, opened: number, merged: number | null) => ({
  author: author === null ? null : { login: author },
  mergedBy: { login: merger },
  createdAt: ago(opened),
  mergedAt: merged === null ? null : ago(merged),
})

const MISSED = [
  pr('lead', 'owner', 12, 10),
  pr('owner', 'lead', 4, 3),
  pr(null, 'owner', 6, 5),
  pr('stranger', 'owner', 8, null),
  pr('late', 'owner', 33, 31),
]

const row = (prs: unknown[]) => merging(TARGET.repo, () => prs, NOW)(open(':memory:'), '', 1, TARGET)

test('D1 no outsider merge in the 30 days before now is a flag', () => {
  expect(row([])).toEqual({ check: 'outside merges', ok: false, says: 'none in 30 days' })
})

test('D2 two outsider merges give count and median days',() => {
  expect(row([pr('ann', 'owner', 3, 2), pr('bo', 'owner', 10, 5)]))
    .toEqual({ check: 'outside merges', ok: true, says: '2 in 30 days, median 1d to merge' })
})

test('D3 own, authorless, unmerged or old prs do not count',() => {
  expect(row(MISSED)).toMatchObject({ ok: false, says: 'none in 30 days' })
  expect(row([...MISSED, pr('ann', 'owner', 3, 2)])).toMatchObject({ ok: true, says: '1 in 30 days, median 1d to merge' })
})

const ID = 2
const rows = (key: string): string => `{\n"${key}bye.ts": {"lines": 1},\n"${key}hello.ts": {"lines": 1}\n}\n`
const BUILT = owning(['ratchet.json', 'sequencer/ratchet.json'])

const rowsOf = (dir: string, file = 'ratchet.json'): unknown => JSON.parse(readFileSync(join(dir, file), 'utf8'))

/**
 * Plan and main each rewrite one of two adjacent rows for `folder`'s files, in `sequencer/ratchet.json` keyed from
 * that folder when `folder` is `sequencer`, else in `ratchet.json`; `hello` also has main overwrite `src/hello.ts`.
 */
async function split(hello: boolean, folder = 'src'): Promise<World> {
  const [file, key] = folder === 'sequencer' ? ['sequencer/ratchet.json', ''] : ['ratchet.json', `${folder}/`]
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  if (folder !== 'src') moveMain(w.root, `${folder}/hello.ts`, 'export const hello = 1\n')
  moveMain(w.root, `${folder}/bye.ts`, 'export const bye = 1\n')
  moveMain(w.root, file, rows(key))
  internalPlan(w.db, w.root, ID)
  const wire = watched([], w.root, ID)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(BUILT), undefined, undefined, wire)
  built(w.root, ID, 'export const landed = true')
  writeFileSync(join(srcDir(w.root, ID), file), rows(key).replace(`"${key}hello.ts": {"lines": 1}`, `"${key}hello.ts": {"lines": 2}`))
  moveMain(w.root, `${folder}/bye.ts`, 'export const bye = 1\nexport const also = 2\n')
  moveMain(w.root, file, rows(key).replace(`"${key}bye.ts": {"lines": 1}`, `"${key}bye.ts": {"lines": 2}`))
  if (hello) moveMain(w.root, 'src/hello.ts', 'export const hello = (): string => "main took this line"\n')
  return w
}

test('D1 D2 a ratchet.json-only conflict is recounted, not re-cut', async () => {
  const w = await split(false)
  const src = srcDir(w.root, ID)

  expect((await tick(w.db, w.root, stub(BUILT), undefined, undefined, watched([], w.root, ID)))[0])
    .toMatchObject({ step: 3, outcome: 'pass' })
  expect(get(w.root, ID, 'base.sha').trim()).toBe(execFileSync('git', ['rev-parse', MAIN], { cwd: src, encoding: 'utf8' }).trim())
  const merge = lastMerge(w.db, ID)
  expect(merge?.clean).toBe(true)

  const now = counts(src)
  const changed = [...new Set([...merge?.incoming ?? [], ...merge?.mine ?? []])].filter((path) => path.endsWith('.ts')).sort()
  expect(changed).toEqual(['src/bye.ts', 'src/hello.ts'])
  expect(rowsOf(src)).toEqual(Object.fromEntries(changed.map((path) => [path, now[path]])))
})

test('D3 a sequencer/ratchet.json-only conflict is recounted', async () => {
  const w = await split(false, 'sequencer')
  const src = srcDir(w.root, ID)

  expect((await tick(w.db, w.root, stub(BUILT), undefined, undefined, watched([], w.root, ID)))[0])
    .toMatchObject({ step: 3, outcome: 'pass' })
  expect(get(w.root, ID, 'base.sha').trim()).toBe(execFileSync('git', ['rev-parse', MAIN], { cwd: src, encoding: 'utf8' }).trim())
  expect(execFileSync('git', ['status', '--porcelain'], { cwd: src, encoding: 'utf8' })).toBe('')

  const now = counts(src)
  expect(rowsOf(src, 'sequencer/ratchet.json')).toEqual({ 'bye.ts': now['sequencer/bye.ts'], 'hello.ts': now['sequencer/hello.ts'] })
})

test('D4 a ratchet.json and .ts conflict still refuses and re-cuts', async () => {
  const w = await split(true)

  const refused = (await tick(w.db, w.root, stub(BUILT), undefined, undefined, watched([], w.root, ID)))[0]
  expect(refused).toMatchObject({ step: 3, outcome: 'refuse' })
  expect([...refused?.spans ?? []].sort()).toEqual(['ratchet.json', 'src/hello.ts'])
  expect(plan(w.db, ID)).toMatchObject({ step: 2, retries: 0 })
  expect(cloned(srcDir(w.root, ID))).toBe(false)
})

const MINE = 'rules/registry/105-filed_resume_step.yaml'
const THEIRS = 'rules/registry/106-long_job_credential.yaml'
const SEEDING = owning([MINE, SEED])
const today = (): string => new Date().toISOString().slice(0, 10)

/** Plan and main each edit one of two adjacent registry files and refill the seed; `hello` also has main overwrite `src/hello.ts`. */
async function reseeded(hello: boolean): Promise<World> {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, ID)
  const wire = watched([], w.root, ID)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(SEEDING), undefined, undefined, wire)
  const src = srcDir(w.root, ID)
  built(w.root, ID, 'export const landed = true')
  appendFileSync(join(src, MINE), '# mine\n')
  fill(src, today())
  const main = join(w.root, 'remotes', SELF)
  appendFileSync(join(main, THEIRS), '# theirs\n')
  fill(main, today())
  git(main, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'main refills the seed'])
  if (hello) moveMain(w.root, 'src/hello.ts', 'export const hello = (): string => "main took this line"\n')
  return w
}

test('D3 D4 a seed-only conflict is refilled, not re-cut', async () => {
  const w = await reseeded(false)
  const src = srcDir(w.root, ID)

  expect((await tick(w.db, w.root, stub(SEEDING), undefined, undefined, watched([], w.root, ID)))[0])
    .toMatchObject({ step: 3, outcome: 'pass' })
  expect(get(w.root, ID, 'base.sha').trim()).toBe(execFileSync('git', ['rev-parse', MAIN], { cwd: src, encoding: 'utf8' }).trim())
  expect(cloned(src)).toBe(true)
  expect(execFileSync('git', ['status', '--porcelain'], { cwd: src, encoding: 'utf8' })).toBe('')

  cpSync(join(import.meta.dirname, '../../schema'), join(src, 'schema'), { recursive: true })
  expect(await ruleHashes.run(src)).toEqual([])
  const seed = join(src, SEED)
  writeFileSync(seed, readFileSync(seed, 'utf8').replace(/'[0-9a-f]{64}'/, `'${'0'.repeat(64)}'`))
  expect((await ruleHashes.run(src)).map((f) => f.message)).toContain('row hash is stale')
})

test('D5 a seed and .ts conflict still refuses and re-cuts', async () => {
  const w = await reseeded(true)

  const refused = (await tick(w.db, w.root, stub(SEEDING), undefined, undefined, watched([], w.root, ID)))[0]
  expect(refused).toMatchObject({ step: 3, outcome: 'refuse' })
  expect([...refused?.spans ?? []].sort()).toEqual([SEED, 'src/hello.ts'])
  expect(plan(w.db, ID)).toMatchObject({ step: 2, retries: 0 })
  expect(cloned(srcDir(w.root, ID))).toBe(false)
})
