import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Packet } from '../../providers/kind.ts'
import { eventsOf } from '../../store/events.ts'
import { pack } from '../../templates/comms.ts'
import { tick } from '../index.ts'
import { get, maybe, put } from '../workspace.ts'
import { plan, stub, world, type World } from './world.ts'

const REPLY = readFileSync(join(import.meta.dirname, '../../seats/growth_lead/tests/reply.md'), 'utf8')
const PACKET = JSON.stringify({ landed: [{ plan: 7, origin: '', digest: '' }], refusals: [{ id: 3 }] })

const fenced = (key: string): unknown => JSON.parse(new RegExp(`^${key}: (.*)$`, 'm').exec(REPLY)?.[1] ?? 'null')
const NOTES = fenced('notes') as string[]
const noted = (notes: string[]): string => REPLY.replace(/^notes: .*$/m, () => `notes: ${JSON.stringify(notes)}`)
const words = (n: number): string => Array.from({ length: n }, () => 'word').join(' ')

const growing = (title: string, step = 7): World => {
  const w = world()
  w.db.prepare("UPDATE plans SET template = 'comms', step = ?, title = ? WHERE id = 1").run(step, title)
  put(w.root, 1, 'packet.json', PACKET)
  return w
}

const posts = (w: World): unknown[] => w.db.prepare('SELECT * FROM desk_posts').all()

test.each(['growth 2026-09-28', 'weekly 2026-10-05'])('D1 D2: %s at step 7 fires growth_lead once', async (title) => {
  const w = growing(title)
  const seen: Packet[] = []
  await tick(w.db, w.root, stub('', 0, REPLY, (p) => seen.push(p)))
  expect(seen).toHaveLength(1)
  expect(seen[0]?.prompt).toContain(`# packet.json\n\n${PACKET}`)
  expect(w.db.prepare('SELECT plan, step, seat FROM runs').all()).toEqual([{ plan: 1, step: 7, seat: 'growth_lead' }])
  expect(maybe(w.root, 1, 'base.sha')).toBeNull()
  expect(get(w.root, 1, 'growth.md')).toBe(REPLY)
})

test.each([
  { title: 'growth 2026-09-28', day: '2026-09-28', id: 1 },
  { title: 'weekly 2026-10-05', day: '2026-10-05', id: 2_000_001 },
])('D3: pack on $title puts one row in proof', ({ title, day, id }) => {
  const w = growing(title, 8)
  put(w.root, 1, 'growth.md', REPLY)
  expect(pack(w.db, w.root, plan(w.db, 1))).toMatchObject({ outcome: 'pass' })
  expect(w.db.prepare('SELECT id, kind, dest, status, title, dek, body, sources, checks, work_date FROM desk_posts').all()).toEqual([{
    id, kind: 'growth', dest: 'pack', status: 'proof', title: 'What a refusal teaches the machine', dek: '',
    body: JSON.stringify({ notes: NOTES, replies: fenced('replies'), partners: fenced('partners') }),
    sources: '[]', checks: '[]', work_date: day,
  }])
})

test.each([
  { why: '13 Notes', reply: noted(NOTES.slice(1)) },
  { why: '15 Notes', reply: noted([...NOTES, NOTES[0] ?? '']) },
  { why: 'a Note of 30 words', reply: noted([words(30), ...NOTES.slice(1)]) },
  { why: 'a Note of 61 words', reply: noted([words(61), ...NOTES.slice(1)]) },
  { why: 'a Note holding ?', reply: noted([`${words(40)}?`, ...NOTES.slice(1)]) },
  { why: 'no fence', reply: 'The week\'s pack, with no fence.\n' },
  { why: '13 weekly Notes', reply: noted(NOTES.slice(1)), title: 'weekly 2026-10-05' },
])('D4: pack refuses $why and writes no row', ({ reply, title = 'growth 2026-09-28' }) => {
  const w = growing(title, 8)
  put(w.root, 1, 'growth.md', reply)
  expect(pack(w.db, w.root, plan(w.db, 1))).toMatchObject({ outcome: 'refuse', spans: ['growth.md'] })
  expect(posts(w)).toEqual([])
})

test('D4 D5: a ship post passes grow and pack: no run, no desk row', async () => {
  const w = growing('ship post acme/widget#7')
  const never = stub('', 0, REPLY, () => { throw new Error('no seat fires on a ship post') })
  for (let n = 0; n < 4 && plan(w.db, 1).state !== 'done'; n += 1) await tick(w.db, w.root, never)
  expect(plan(w.db, 1).state).toBe('done')
  expect(w.db.prepare('SELECT kind, outcome FROM events WHERE plan = 1 ORDER BY id').all())
    .toEqual([{ kind: 'grow', outcome: 'pass' }, { kind: 'pack', outcome: 'pass' }, { kind: 'score', outcome: 'pass' }])
  expect(eventsOf(w.db, 1, 'grow')).toEqual([{ actor: 'growth_lead', outcome: 'pass', message: 'skipped: not a growth or weekly plan' }])
  expect(w.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 })
  expect(posts(w)).toEqual([])
})
