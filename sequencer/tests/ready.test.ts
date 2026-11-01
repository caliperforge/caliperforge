import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { built as builtRow, newest } from '../../store/deliverables.ts'
import { refusalsOf } from '../../store/refusals.ts'
import { verdictRows } from '../../store/verdict.ts'
import { tick } from '../index.ts'
import type { Fired } from '../kind.ts'
import { headOf, type Wire } from '../push.ts'
import { ASKED, CREDITS, proved, SKIPPED } from '../ready.ts'
import { mapOf } from '../steps.ts'
import { cloned, get, headSha, put, srcDir } from '../workspace.ts'
import { approve, built, CARRIED, plan, scored, stub, watched, world, type World } from './world.ts'

const atReady = async (log: string[], over: Partial<Wire> = {}, handback = (): string => CARRIED): Promise<[World, () => Promise<Fired | undefined>]> => {
  const w = world()
  approve(w.db, w.target)
  const wire = { ...watched(log, w.root, 1), ...over }
  const lap = async (): Promise<Fired | undefined> => (await tick(w.db, w.root, stub(handback()), undefined, undefined, wire))[0]
  for (let at = 0; at < 6; at += 1) await lap()
  expect(plan(w.db, 1).step).toBe(6)
  return [w, lap]
}

const readyVerdicts = (w: World): number => verdictRows(w.db, 1).filter((v) => v.rail_id === 'ready').length

const UNPROVEN = { step: 6, name: 'ready', outcome: 'pass', spans: ['ready.unproven'] }

test('D1 D4 a built row after senior goes back to the rails', async () => {
  const log: string[] = []
  const [w, lap] = await atReady(log)
  const row = newest(w.db, 1)
  if (row === null) throw new Error('senior wrote no row')
  builtRow(w.db, { plan: 1, step: 2, seat: row.seat, diff_digest: row.diff_digest, evidence: row.evidence })
  const sent = log.length
  expect(await lap()).toMatchObject(UNPROVEN)
  expect(plan(w.db, 1)).toMatchObject({ step: 3, retries: 0 })
  expect(readyVerdicts(w)).toBe(0)
  expect(refusalsOf(w.db, 1)).toBe(0)
  expect(log.slice(sent).filter((l) => l.startsWith('send '))).toEqual([])
})

test('D2 an outside plan with no checkout is refused, not cloned', async () => {
  const [w, lap] = await atReady([])
  rmSync(srcDir(w.root, 1), { recursive: true, force: true })
  expect(await lap()).toMatchObject({ step: 6, outcome: 'refuse', spans: ['checkout'] })
  expect(cloned(srcDir(w.root, 1))).toBe(false)
})

test('D4 an unsigned commit on a signed target is refused', async () => {
  const [w, lap] = await atReady([])
  built(w.root, 1, 'export const bye = (): string => "bye"')
  for (let at = 2; at < 6; at += 1) await lap()
  expect(plan(w.db, 1).step).toBe(6)
  mkdirSync(join(w.root, 'profiles/acme'), { recursive: true })
  writeFileSync(join(w.root, 'profiles/acme/widget.yml'), 'signed: true\n')
  expect(await lap()).toMatchObject({ step: 6, outcome: 'refuse', spans: ['ready.unsigned'] })
  expect(readyVerdicts(w)).toBe(0)
})

test('D2 the senior write needs no checkout', async () => {
  const [w] = await atReady([])
  const write = proved(w.db, w.root, plan(w.db, 1), mapOf('pr_path').at(5))
  const row = newest(w.db, 1)
  if (row === null) throw new Error('senior wrote no row')
  builtRow(w.db, { plan: 1, step: 2, seat: row.seat, diff_digest: row.diff_digest, evidence: row.evidence })
  rmSync(srcDir(w.root, 1), { recursive: true, force: true })
  write()
  expect(newest(w.db, 1)?.state).toBe('gated')
})

test('D2 D3 bytes changed after senior are proved again', async () => {
  const [w, lap] = await atReady([])
  built(w.root, 1, 'export const bye = (): string => "bye"')
  expect(await lap()).toMatchObject(UNPROVEN)
  expect(plan(w.db, 1)).toMatchObject({ step: 3, retries: 0 })
  expect(readyVerdicts(w)).toBe(0)
  for (let at = 3; at < 6; at += 1) await lap()
  expect(plan(w.db, 1).step).toBe(6)
  await lap()
  expect(readyVerdicts(w)).toBe(1)
})

test('D1 a spent month passes ready without asking Greptile', async () => {
  const log: string[] = []
  const [w, lap] = await atReady(log, { rehearse: () => undefined })
  put(w.root, 2, ASKED, `${'f'.repeat(40)} ${new Date().toISOString()}\n`.repeat(CREDITS))
  expect(await lap()).toMatchObject({ step: 6, name: 'ready', outcome: 'pass',
    note: expect.stringContaining('; Greptile skipped: monthly quota spent (50/50)') as unknown })
  expect(log.filter((l) => l.startsWith('review '))).toEqual([])
  expect(plan(w.db, 1).step).toBe(7)
  expect(get(w.root, 1, SKIPPED)).toBe(`${headSha(srcDir(w.root, 1))} monthly quota spent (50/50)\n`)
})

const UNSCORED = { rehearse: (): void => undefined }

const reviews = (log: string[]): string[] => log.filter((l) => l.startsWith('review '))

/** Greptile's `score` at the head, with one finding listed under `badge`. */
const finding = (w: World, score: number, badge: string): void => {
  scored(w.root, 1, score, `Confidence Score: ${String(score)}/5`)
  put(w.root, 1, `findings-${headOf(w.root, 1).sha}.md`, `- G11 <img alt="${badge}" src="https://greptile.com/p.svg"> the empty name is never refused\n`)
}

test('D1 a second head on an asked job is not asked', async () => {
  const log: string[] = []
  const [w, lap] = await atReady(log, UNSCORED)
  expect(await lap()).toMatchObject({ step: 6, outcome: 'pass', spans: ['greptile.missing'] })
  built(w.root, 1, 'export const two = 2')
  for (let at = 0; at < 4; at += 1) await lap()
  expect(plan(w.db, 1).step).toBe(6)
  const fired = await lap()
  expect(fired?.spans).not.toContain('greptile.missing')
  expect(fired?.note).toMatch(/Greptile reviewed [0-9a-f]{12} once; [0-9a-f]{12} is not asked again/)
  expect(reviews(log)).toHaveLength(1)
})

test('D2 a P2-only head stays at step 6', async () => {
  const [w, lap] = await atReady([], UNSCORED)
  finding(w, 4, 'P2')
  const fired = await lap()
  expect(fired).toMatchObject({ step: 6, outcome: 'refuse', spans: ['greptile:4/5'] })
  expect(fired?.note).toMatch(/P2s are fixed in one batch before sign-off; Greptile is not asked again$/)
  expect(plan(w.db, 1).step).toBe(6)
  await lap()
  expect(plan(w.db, 1).step).toBe(6)
})

test('D3 an open P1 goes to the builder once', async () => {
  const log: string[] = []
  let handback = CARRIED
  const [w, lap] = await atReady(log, UNSCORED, () => handback)
  await lap()
  finding(w, 4, 'P1')
  expect(await lap()).toMatchObject({ step: 6, outcome: 'refuse', spans: ['greptile:4/5'] })
  expect(plan(w.db, 1).step).toBe(2)
  handback = CARRIED.replace(/---\n$/, '  - id: G11\n    status: done\n    pointer: src/hello.ts:2\n---\n')
  built(w.root, 1, 'export const two = 2')
  for (let at = 0; plan(w.db, 1).step !== 6 && at < 8; at += 1) await lap()
  expect(await lap()).toMatchObject({ step: 6, outcome: 'pass' })
  expect(plan(w.db, 1).step).toBe(7)
  expect(reviews(log)).toHaveLength(1)
})
