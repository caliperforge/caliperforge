import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { counts } from '../../checks/ratchet.ts'
import { open } from '../../store/index.ts'
import { last as lastMerge } from '../../store/merges.ts'
import { dropPlan } from '../../store/plans.ts'
import { tick } from '../index.ts'
import { merging } from '../merging.ts'
import { cloned, get, MAIN, srcDir } from '../workspace.ts'
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
const ROWS = '{\n"src/bye.ts": {"lines": 1},\n"src/hello.ts": {"lines": 1}\n}\n'
const BUILT = owning(['ratchet.json'])

const rowsOf = (dir: string): unknown => JSON.parse(readFileSync(join(dir, 'ratchet.json'), 'utf8'))

/** Plan and main each rewrite one of two adjacent `ratchet.json` rows; `hello` also has main overwrite `src/hello.ts`. */
async function split(hello: boolean): Promise<World> {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  moveMain(w.root, 'src/bye.ts', 'export const bye = 1\n')
  moveMain(w.root, 'ratchet.json', ROWS)
  internalPlan(w.db, w.root, ID)
  const wire = watched([], w.root, ID)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(BUILT), undefined, undefined, wire)
  built(w.root, ID, 'export const landed = true')
  writeFileSync(join(srcDir(w.root, ID), 'ratchet.json'), ROWS.replace('"src/hello.ts": {"lines": 1}', '"src/hello.ts": {"lines": 2}'))
  moveMain(w.root, 'src/bye.ts', 'export const bye = 1\nexport const also = 2\n')
  moveMain(w.root, 'ratchet.json', ROWS.replace('"src/bye.ts": {"lines": 1}', '"src/bye.ts": {"lines": 2}'))
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

test('D4 a ratchet.json and .ts conflict still refuses and re-cuts', async () => {
  const w = await split(true)

  const refused = (await tick(w.db, w.root, stub(BUILT), undefined, undefined, watched([], w.root, ID)))[0]
  expect(refused).toMatchObject({ step: 3, outcome: 'refuse' })
  expect([...refused?.spans ?? []].sort()).toEqual(['ratchet.json', 'src/hello.ts'])
  expect(plan(w.db, ID)).toMatchObject({ step: 2, retries: 0 })
  expect(cloned(srcDir(w.root, ID))).toBe(false)
})
