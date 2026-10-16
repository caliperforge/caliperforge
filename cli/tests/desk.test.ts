import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { mapOf } from '../../sequencer/steps.ts'
import { plan, PASS, stub, world, type World } from '../../sequencer/tests/world.ts'
import { put } from '../../sequencer/workspace.ts'
import { amend, approved, learnings, log, postOf, posts, putPost, sentBack } from '../../store/desk.ts'
import { eventsOf, kindsOf } from '../../store/events.ts'
import { take } from '../../store/leases.ts'
import { briefed, dropPlan, end, plansOf, putPlan } from '../../store/plans.ts'
import { capture, draft } from '../../templates/comms.ts'
import { catchup, giveBack, learn } from '../desk.ts'

const comms = (status: 'proof' | 'approved' | 'published' = 'proof'): World => {
  const w = world()
  const { queued_at } = plan(w.db, 1)
  dropPlan(w.db, 1)
  putPlan(w.db, { id: 1, pipe_id: 1, target_id: 1, template: 'comms', state: 'queued', queued_at, step: 0, retries: 0 })
  briefed(w.db, 1, { title: 'ship post acme/widget#7', what: null, why: null, ends: null })
  put(w.root, 1, 'packet.json', JSON.stringify({ landed: [{ plan: 7, origin: '', digest: '' }], refusals: [{ id: 3 }] }))
  putPost(w.db, { id: 1, kind: 'ship', dest: 'site', status, title: 'The day', dek: 'What moved', body: 'One job landed.',
    edited_title: null, sources: '[]', checks: '[]', work_date: '2026-10-01', written_date: '2026-10-01' })
  return w
}

const reply = readFileSync(join(import.meta.dirname, '../../seats/writer/tests/reply.md'), 'utf8')

const prompted = async (w: World): Promise<string> => {
  let prompt = ''
  await draft(w.db, w.root, plan(w.db, 1), mapOf('comms').at(1), stub(reply, 0, PASS, (p) => { prompt = p.prompt }))
  return prompt
}

test('D1 edit then approve keeps body and logs the ceo', () => {
  const w = comms()
  amend(w.db, 1, { body: 'Two jobs landed.' }, 'ceo')
  approved(w.db, 1, 'ceo')
  expect(postOf(w.db, 1)).toMatchObject({ edited_body: 'Two jobs landed.', body: 'One job landed.', status: 'approved' })
  expect(eventsOf(w.db, 1, 'desk_edit')).toEqual([{ actor: 'ceo', outcome: 'pass', message: 'body' }])
  expect(eventsOf(w.db, 1, 'desk_approve')).toEqual([{ actor: 'ceo', outcome: 'pass', message: 'approved' }])
})

test('D2 giveBack sets changes and requeues the plan at draft', () => {
  const w = comms()
  end(w.db, 1, 'done')
  giveBack(w.db, 1, 'warmer', 'ceo')
  expect(postOf(w.db, 1)).toMatchObject({ status: 'changes', note: 'warmer' })
  expect(plan(w.db, 1)).toMatchObject({ state: 'queued', step: 1 })
  expect(eventsOf(w.db, 1, 'desk_return')).toEqual([{ actor: 'ceo', outcome: 'pass', message: 'warmer' }])
})

test('D3 the next draft carries the note to the writer', async () => {
  const w = comms()
  expect(await prompted(w)).not.toContain('# Returned from the desk')
  giveBack(w.db, 1, 'warmer', 'ceo')
  expect(await prompted(w)).toContain('# Returned from the desk\n\nwarmer')
})

test.each(['approved', 'published'] as const)('D4 a %s row refuses every desk write', (status) => {
  const w = comms(status)
  const was = posts(w.db)
  const why = `desk post 1 is ${status}, not in proof or changes`
  expect(() => { amend(w.db, 1, { body: 'x' }, 'ceo') }).toThrow(why)
  expect(() => { approved(w.db, 1, 'ceo') }).toThrow(why)
  expect(() => { giveBack(w.db, 1, 'x', 'ceo') }).toThrow(why)
  expect(posts(w.db)).toEqual(was)
  expect(plan(w.db, 1)).toMatchObject({ state: 'queued', step: 0 })
  expect(kindsOf(w.db, 1)).toEqual([])
})

test('D4 an unknown id throws no desk post', () => {
  const w = comms()
  expect(() => { sentBack(w.db, 9, 'x', 'ceo') }).toThrow('no desk post 9')
})

test('D5 return on a leased plan throws before any write', () => {
  const w = comms()
  take(w.db, 1)
  expect(() => { giveBack(w.db, 1, 'warmer', 'ceo') }).toThrow('mid-step in a live tick')
  expect(postOf(w.db, 1)).toMatchObject({ status: 'proof', note: null })
  expect(kindsOf(w.db, 1)).toEqual([])
})

test('D5 cf desk return --by cto is refused', () => {
  const run = (): string => execFileSync(process.execPath, [join(import.meta.dirname, '../cf.ts'), 'desk', 'return', '1',
    '--note', 'x', '--by', 'cto'], { encoding: 'utf8', stdio: 'pipe' })
  expect(run).toThrow('--by takes ceo or coo, not cto')
})

const AT = new Date('2026-10-04T05:00:00Z')
const A = { title: 'a', what: 'w', lesson: 'l', fix: 'f', status: 'open' } as const

test('learnAppends D1 one coo item on the local date', () => {
  const w = world()
  expect(learn(w.db, A, AT)).toBe(1)
  expect(learnings(w.db)).toEqual([{ date: '2026-10-03', numbers: '[]', items: JSON.stringify([{ ...A, source: 'coo' }]), sources: '[]' }])
})

test('learnAppends D2 a repeated title adds nothing', () => {
  const w = world()
  log(w.db, '2026-10-03', [{ ...A, title: 'z' }])
  learn(w.db, A, AT)
  const was = learnings(w.db)
  expect(learn(w.db, { ...A, what: 'other' }, AT)).toBe(0)
  expect(learnings(w.db)).toEqual(was)
  expect((JSON.parse(was[0]?.items ?? '[]') as { title: string }[]).map((i) => i.title)).toEqual(['z', 'a'])
})

test('D3 cf learn --status done is refused', () => {
  const run = (): string => execFileSync(process.execPath, [join(import.meta.dirname, '../cf.ts'), 'learn', 'x', '--status', 'done'],
    { encoding: 'utf8', stdio: 'pipe' })
  expect(run).toThrow('--status takes fixed, open, ruled or noted, not done')
})

const CF = join(import.meta.dirname, '../cf.ts')

test('catchup D1 files one queued comms plan by coo', () => {
  const w = world()
  const id = catchup(w.db, '2026-08-01', '2026-10-11', 'coo', AT)
  expect(plansOf(w.db, 'comms')).toEqual([{ id, title: 'catchup 2026-08-01 2026-10-11', state: 'queued' }])
  expect(eventsOf(w.db, id, 'filed')).toEqual([{ actor: 'coo', outcome: 'pass', message: 'cf desk catchup' }])
})

test('catchup D2 the same or an overlapping range is refused', () => {
  const w = world()
  catchup(w.db, '2026-08-01', '2026-10-11', 'coo', AT)
  const was = plansOf(w.db, 'comms')
  expect(() => catchup(w.db, '2026-08-01', '2026-10-11', 'coo', AT)).toThrow('overlaps plan')
  expect(() => catchup(w.db, '2026-10-01', '2026-10-20', 'coo', AT)).toThrow('overlaps plan')
  expect(plansOf(w.db, 'comms')).toEqual(was)
})

test('catchup D3 a reversed range is refused', () => {
  const w = world()
  expect(() => catchup(w.db, '2026-10-11', '2026-08-01', 'coo', AT)).toThrow('is after')
  expect(plansOf(w.db, 'comms')).toEqual([])
})

test('catchup D4 cf desk catchup --by director is refused', () => {
  const run = (): string => execFileSync(process.execPath, [CF, 'desk', 'catchup', '2026-08-01', '2026-10-11',
    '--by', 'director'], { encoding: 'utf8', stdio: 'pipe' })
  expect(run).toThrow('--by takes ceo or coo, not director')
})

test('catchup D5 cf desk --help lists catchup', () => {
  expect(execFileSync(process.execPath, [CF, 'desk', '--help'], { encoding: 'utf8', stdio: 'pipe' })).toContain('catchup')
})

test('catchup D6 a refused plan holds only its own title', () => {
  const w = world()
  end(w.db, catchup(w.db, '2026-08-01', '2026-10-11', 'coo', AT), 'refused')
  expect(() => catchup(w.db, '2026-08-01', '2026-10-11', 'coo', AT)).toThrow('is already filed')
  expect(catchup(w.db, '2026-10-01', '2026-10-20', 'ceo', AT)).toBeGreaterThan(0)
})

test('D6 an edit lands in comms/voice-notes.md on capture', () => {
  const w = comms()
  amend(w.db, 1, { body: 'One job landed today, warmly.' }, 'ceo')
  capture(w.db, w.root)
  expect(readFileSync(join(w.root, 'comms/voice-notes.md'), 'utf8')).toContain('1 body: lengthened (15 → 29 chars)')
})
