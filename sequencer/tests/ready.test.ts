import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { built as builtRow, newest } from '../../store/deliverables.ts'
import { refusalsOf } from '../../store/refusals.ts'
import { verdictRows } from '../../store/verdict.ts'
import { tick } from '../index.ts'
import type { Fired } from '../kind.ts'
import type { Wire } from '../push.ts'
import { ASKED, CREDITS, proved, SKIPPED } from '../ready.ts'
import { mapOf } from '../steps.ts'
import { cloned, get, headSha, put, srcDir } from '../workspace.ts'
import { approve, built, CARRIED, plan, stub, watched, world, type World } from './world.ts'

const atReady = async (log: string[], over: Partial<Wire> = {}): Promise<[World, () => Promise<Fired | undefined>]> => {
  const w = world()
  approve(w.db, w.target)
  const wire = { ...watched(log, w.root, 1), ...over }
  const lap = async (): Promise<Fired | undefined> => (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
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
