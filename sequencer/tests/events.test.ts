import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Packet } from '../../providers/kind.ts'
import { runSince } from '../../store/events.ts'
import type { Db } from '../../store/index.ts'
import { planRows } from '../../store/plans.ts'
import { setInputTokens } from '../../store/runs.ts'
import { planEvents, verdictMessage } from '../../store/trail.ts'
import { verdictRows } from '../../store/verdict.ts'
import { tick } from '../index.ts'
import { approve, CARRIED, REFUSE, stub, watched, WORDS, world } from './world.ts'

const writes = (packet: Packet): void => {
  if (packet.tools.includes('Write')) writeFileSync(join(packet.cwd, 'src/hello.ts'), 'export const hello = (): string => "hey"\n')
}

const verdictAt = (db: Db, step: number): string =>
  `verdicts:${String(verdictRows(db, 1).filter((v) => v.kind === 'review' && v.step === step).at(-1)?.id ?? null)}`

test('a chained lap writes one row per step, each at its runs row', async () => {
  const w = world()
  approve(w.db, w.target)
  const fired = await tick(w.db, w.root, stub(CARRIED, 0, undefined, writes), undefined, undefined, watched([], w.root, 1), 5)
  const logged = planEvents(w.db, 1).filter((r) => !r.kind.startsWith('fork.'))
  const pointers: Record<number, string> = { 1: 'plans:1', 4: verdictAt(w.db, 4), 5: verdictAt(w.db, 5) }
  expect(logged.map((r) => [r.kind, r.outcome, r.message, r.pointer]))
    .toEqual(fired.map((f) => [f.name, f.outcome, f.note, pointers[f.step] ?? `step-${String(f.step)}`]))
  const at = [null, runSince(w.db, 1, 1, 0), runSince(w.db, 1, 2, 0), null, runSince(w.db, 1, 4, 0), runSince(w.db, 1, 5, 0), null]
  expect(at.filter((id) => id !== null)).toHaveLength(4)
  expect(logged.map((r) => r.run)).toEqual(at)
})

test('the store holds brief title, lines and the review\'s prose', async () => {
  const w = world()
  approve(w.db, w.target)
  await tick(w.db, w.root, stub(CARRIED, 0, REFUSE, writes), undefined, undefined, watched([], w.root, 1), 5)
  expect(planRows(w.db).find((p) => p.id === 1))
    .toMatchObject({ title: 'hello', what: 'add `hello()`.', why: 'the ask asks for it.', ends: 'it is exported.' })
  const review = planEvents(w.db, 1).find((r) => r.kind === 'review')
  expect(verdictMessage(w.db, Number(String(review?.pointer).split(':')[1]))).toBe(WORDS)
})

test('a job past the ceiling leaves one refuse row with no run', async () => {
  const w = world()
  approve(w.db, w.target)
  let fired = 0
  const provider = stub(CARRIED, 0, undefined, () => { fired += 1 })
  while (fired === 0) await tick(w.db, w.root, provider)
  setInputTokens(w.db, 7000000)
  const before = planEvents(w.db, 1).length
  await tick(w.db, w.root, provider)
  expect(planEvents(w.db, 1).slice(before)).toEqual([expect.objectContaining({ actor: 'token_ceiling', outcome: 'refuse', run: null }),
    expect.objectContaining({ kind: 'director', outcome: 'needs_coo', run: null })])
})

test('events refuse UPDATE and DELETE and keep the row', async () => {
  const w = world()
  approve(w.db, w.target)
  await tick(w.db, w.root, stub(CARRIED))
  const kept = planEvents(w.db, 1)
  expect(() => w.db.exec("UPDATE events SET message = 'x'")).toThrow('events is append-only')
  expect(() => w.db.exec('DELETE FROM events')).toThrow('events is append-only')
  expect(planEvents(w.db, 1)).toEqual(kept)
})
