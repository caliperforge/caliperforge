import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Packet } from '../../providers/kind.ts'
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

test('D2: a growth plan at step 7 fires growth_lead once on packet.json, with no checkout, and keeps its reply', async () => {
  const w = growing('growth 2026-09-28')
  const seen: Packet[] = []
  await tick(w.db, w.root, stub('', 0, REPLY, (p) => seen.push(p)))
  expect(seen).toHaveLength(1)
  expect(seen[0]?.prompt).toContain(`# packet.json\n\n${PACKET}`)
  expect(w.db.prepare('SELECT plan, step, seat FROM runs').all()).toEqual([{ plan: 1, step: 7, seat: 'growth_lead' }])
  expect(maybe(w.root, 1, 'base.sha')).toBeNull()
  expect(get(w.root, 1, 'growth.md')).toBe(REPLY)
})

test('D3: pack puts the fixture reply on the desk as one pack row in proof', () => {
  const w = growing('growth 2026-09-28', 8)
  put(w.root, 1, 'growth.md', REPLY)
  expect(pack(w.db, w.root, plan(w.db, 1))).toMatchObject({ outcome: 'pass' })
  expect(w.db.prepare('SELECT id, kind, dest, status, title, dek, body, sources, checks, work_date FROM desk_posts').all()).toEqual([{
    id: 1, kind: 'growth', dest: 'pack', status: 'proof', title: 'What a refusal teaches the machine', dek: '',
    body: JSON.stringify({ notes: NOTES, replies: fenced('replies'), partners: fenced('partners') }),
    sources: '[]', checks: '[]', work_date: '2026-09-28',
  }])
})

test.each([
  { why: '13 Notes', reply: noted(NOTES.slice(1)) },
  { why: '15 Notes', reply: noted([...NOTES, NOTES[0] ?? '']) },
  { why: 'a Note of 30 words', reply: noted([words(30), ...NOTES.slice(1)]) },
  { why: 'a Note of 61 words', reply: noted([words(61), ...NOTES.slice(1)]) },
  { why: 'a Note holding ?', reply: noted([`${words(40)}?`, ...NOTES.slice(1)]) },
  { why: 'no fence', reply: 'The week\'s pack, with no fence.\n' },
])('D4: pack refuses $why and writes no row', ({ reply }) => {
  const w = growing('growth 2026-09-28', 8)
  put(w.root, 1, 'growth.md', reply)
  expect(pack(w.db, w.root, plan(w.db, 1))).toMatchObject({ outcome: 'refuse', spans: ['growth.md'] })
  expect(posts(w)).toEqual([])
})

test('D5: a ship post plan passes grow and pack with no run and no desk row', async () => {
  const w = growing('ship post acme/widget#7')
  const never = stub('', 0, REPLY, () => { throw new Error('no seat fires on a ship post') })
  for (let n = 0; n < 4 && plan(w.db, 1).state !== 'done'; n += 1) await tick(w.db, w.root, never)
  expect(plan(w.db, 1).state).toBe('done')
  expect(w.db.prepare('SELECT kind, outcome FROM events WHERE plan = 1 ORDER BY id').all())
    .toEqual([{ kind: 'grow', outcome: 'pass' }, { kind: 'pack', outcome: 'pass' }, { kind: 'score', outcome: 'pass' }])
  expect(w.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 })
  expect(posts(w)).toEqual([])
})
