import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Packet } from '../../providers/kind.ts'
import type { Db } from '../../store/index.ts'
import { tick } from '../index.ts'
import { approve, CARRIED, REFUSE, stub, watched, WORDS, world } from './world.ts'

const writes = (packet: Packet): void => {
  if (packet.tools.includes('Write')) writeFileSync(join(packet.cwd, 'src/hello.ts'), 'export const hello = (): string => "hey"\n')
}

const rows = (db: Db): Record<string, unknown>[] =>
  db.prepare('SELECT kind, actor, outcome, message, pointer, run FROM events WHERE plan = 1 ORDER BY id').all() as Record<string, unknown>[]

const runAt = (db: Db, step: number): unknown =>
  (db.prepare('SELECT max(id) AS id FROM runs WHERE plan = 1 AND step = ?').get(step) as { id: unknown }).id

const verdictAt = (db: Db, step: number): string =>
  `verdicts:${String((db.prepare(`SELECT max(id) AS id FROM verdicts
    WHERE plan = 1 AND step = ? AND kind = 'review' AND quick_lane = 0`).get(step) as { id: unknown }).id)}`

test('a chained lap writes one row per step, pointing at its runs row', async () => {
  const w = world()
  approve(w.db, w.target)
  const fired = await tick(w.db, w.root, stub(CARRIED, 0, undefined, writes), undefined, undefined, watched([], w.root, 1), 5)
  const logged = rows(w.db)
  const pointers: Record<number, string> = { 1: 'plans:1', 4: verdictAt(w.db, 4), 5: verdictAt(w.db, 5) }
  expect(logged.map((r) => [r.kind, r.outcome, r.message, r.pointer]))
    .toEqual(fired.map((f) => [f.name, f.outcome, f.note, pointers[f.step] ?? `step-${String(f.step)}`]))
  const at = [null, runAt(w.db, 1), runAt(w.db, 2), null, runAt(w.db, 4), runAt(w.db, 5), null]
  expect(at.filter((id) => id !== null)).toHaveLength(4)
  expect(logged.map((r) => r.run)).toEqual(at)
})

test('the store holds the brief title and lines, and the reviewer prose the review event points at', async () => {
  const w = world()
  approve(w.db, w.target)
  await tick(w.db, w.root, stub(CARRIED, 0, REFUSE, writes), undefined, undefined, watched([], w.root, 1), 5)
  expect(w.db.prepare('SELECT title, what, why, ends FROM plans WHERE id = 1').get())
    .toEqual({ title: 'hello', what: 'add `hello()`.', why: 'the ask asks for it.', ends: 'it is exported.' })
  const review = rows(w.db).find((r) => r.kind === 'review')
  expect(w.db.prepare('SELECT message FROM verdicts WHERE id = ?').get(Number(String(review?.pointer).split(':')[1])))
    .toEqual({ message: WORDS })
})

test('a job past the ceiling leaves one refuse row with no run', async () => {
  const w = world()
  approve(w.db, w.target)
  let fired = 0
  const provider = stub(CARRIED, 0, undefined, () => { fired += 1 })
  while (fired === 0) await tick(w.db, w.root, provider)
  w.db.prepare('UPDATE runs SET input_tokens = 7000000').run()
  const before = rows(w.db).length
  await tick(w.db, w.root, provider)
  expect(rows(w.db).slice(before)).toEqual([expect.objectContaining({ actor: 'token_ceiling', outcome: 'refuse', run: null })])
})

test('events refuse UPDATE and DELETE and keep the row', async () => {
  const w = world()
  approve(w.db, w.target)
  await tick(w.db, w.root, stub(CARRIED))
  const kept = rows(w.db)
  expect(() => w.db.prepare("UPDATE events SET message = 'x'").run()).toThrow('events is append-only')
  expect(() => w.db.prepare('DELETE FROM events').run()).toThrow('events is append-only')
  expect(rows(w.db)).toEqual(kept)
})
