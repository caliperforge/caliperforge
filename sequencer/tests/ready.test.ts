import { expect, test } from 'vitest'
import { built as builtRow, newest } from '../../store/deliverables.ts'
import { refusalsOf } from '../../store/refusals.ts'
import { verdictRows } from '../../store/verdict.ts'
import { tick } from '../index.ts'
import type { Fired } from '../kind.ts'
import { approve, built, CARRIED, plan, stub, watched, world, type World } from './world.ts'

const atReady = async (log: string[]): Promise<[World, () => Promise<Fired | undefined>]> => {
  const w = world()
  approve(w.db, w.target)
  const wire = watched(log, w.root, 1)
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
