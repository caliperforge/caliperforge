import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { landed } from '../../cli/batch.ts'
import type { Provider } from '../../providers/kind.ts'
import { desk, drafted, facts, gather } from '../../templates/comms.ts'
import { tick } from '../index.ts'
import { FORK, get, put } from '../workspace.ts'
import { plan, reads, world, type World } from './world.ts'

const NAMES = ['gather', 'draft', 'facts', 'text_review', 'desk', 'publish', 'capture', 'grow', 'pack', 'score']

const refusal = (w: World, blip: number, at = new Date().toISOString().replace('T', ' ').slice(0, 19)): number =>
  Number(w.db.prepare(`INSERT INTO refusals (plan, step, fingerprint, diff, blip, at) VALUES (1, 0, ?, NULL, ?, ?)`)
    .run('0'.repeat(64), blip, at).lastInsertRowid)

const comms = (): World => {
  const w = world()
  w.db.prepare("UPDATE plans SET template = 'comms' WHERE id = 1").run()
  return w
}

/** A comms lane that is on but shut by 20:30, so the daily plan stays queued. */
const clocked = (): World => {
  const w = world()
  w.db.prepare("UPDATE plans SET state = 'done' WHERE id = 1").run()
  w.db.prepare(`INSERT INTO pipes (name, enabled, window_start, window_end, max_concurrent)
    VALUES ('comms', 1, '07:00', '20:00', 1)`).run()
  return w
}

const dailies = (w: World): unknown[] =>
  w.db.prepare("SELECT title, state FROM plans WHERE template = 'comms' AND title LIKE 'daily %' ORDER BY id").all()

const titled = (w: World, id: number, title: string | null): unknown =>
  w.db.prepare('UPDATE plans SET title = ? WHERE id = ?').run(title, id)

const fenced = (): Record<string, unknown> => ({ ...drafted(fixture('reply.md')), post: undefined })

const desked = (w: World, fence: Record<string, unknown> | null = fenced(), draft = drafted(fixture('reply.md'))?.post ?? '',
  id = 1): ReturnType<typeof desk> => {
  put(w.root, id, 'draft.md', draft)
  if (fence !== null) put(w.root, id, 'fence.json', JSON.stringify(fence))
  return desk(w.db, w.root, plan(w.db, id))
}

const learned = (w: World): unknown[] => w.db.prepare('SELECT * FROM desk_learnings').all()

const never: Provider = { name: 'claude-agent-sdk', fire: () => { throw new Error('no seat fires on comms') } }

const judged =(w: World, line: string): ReturnType<typeof facts> => {
  put(w.root, 1, 'draft.md', `# The day\n\n${line}\n`)
  return facts(w.root, plan(w.db, 1))
}

test('D2 D7 D6: a comms plan ticks gather through capture to done, no seat or rail runs, desk leaves one post and capture one voice note', async () => {
  const w = comms()
  const today = new Date().toISOString().slice(0, 10)
  reads(w.db, 1)
  titled(w, 1, `daily ${today}`)
  w.db.prepare(`INSERT INTO desk_posts (id, kind, dest, status, title, dek, body, edited_title, sources, checks, work_date, written_date)
    VALUES (2, 'daily', 'site', 'proof', 'The day', 'What moved', 'One job landed.', 'The whole day', '[]', '[]', ?, ?)`).run(today, today)
  put(w.root, 1, 'fence.json', JSON.stringify(fenced()))
  put(w.root, 1, 'draft.md', `# The day\n\nOne job was refused. [refusal:${String(refusal(w, 0))}]\n`)
  for (let n = 0; n < 11 && plan(w.db, 1).state !== 'done'; n += 1) await tick(w.db, w.root, never)
  expect(plan(w.db, 1).state).toBe('done')
  expect(w.db.prepare('SELECT kind, outcome FROM events WHERE plan = 1 ORDER BY id').all())
    .toEqual(NAMES.map((kind) => ({ kind, outcome: 'pass' })))
  expect(w.db.prepare('SELECT (SELECT count(*) FROM runs) + (SELECT count(*) FROM verdicts) AS n').get()).toEqual({ n: 0 })
  expect(w.db.prepare('SELECT id FROM desk_posts').all()).toEqual([{ id: 1 }, { id: 2 }])
  expect(readFileSync(join(w.root, 'comms/voice-notes.md'), 'utf8')).toBe(`# Voice notes\n\n- ${today} 2 title: lengthened (7 → 13 chars)\n`)
})

test('two ticks after 20:30 on one local day file one daily comms plan', async () => {
  const w = clocked()
  await tick(w.db, w.root, never, new Date('2026-09-28T02:31Z'))
  await tick(w.db, w.root, never, new Date('2026-09-28T02:45Z'))
  expect(dailies(w)).toEqual([{ title: 'daily 2026-09-27', state: 'queued' }])
})

test('a tick before 20:30 files no daily plan, and the next day after 20:30 files a second', async () => {
  const w = clocked()
  await tick(w.db, w.root, never, new Date('2026-09-28T02:29Z'))
  expect(dailies(w)).toEqual([])
  await tick(w.db, w.root, never, new Date('2026-09-28T02:31Z'))
  await tick(w.db, w.root, never, new Date('2026-09-29T02:31Z'))
  expect(dailies(w)).toEqual([{ title: 'daily 2026-09-27', state: 'queued' }, { title: 'daily 2026-09-28', state: 'queued' }])
})

const growths = (w: World): unknown[] =>
  w.db.prepare("SELECT title, state FROM plans WHERE template = 'comms' AND title LIKE 'growth %' ORDER BY id").all()

test('weekly D1: two ticks on one local Thursday file one growth plan, filed once by the weekly clock', async () => {
  const w = clocked()
  await tick(w.db, w.root, never, new Date('2026-10-02T03:00Z'))
  await tick(w.db, w.root, never, new Date('2026-10-02T03:30Z'))
  expect(growths(w)).toEqual([{ title: 'growth 2026-10-01', state: 'queued' }])
  expect(w.db.prepare(`SELECT e.actor FROM events e JOIN plans p ON p.id = e.plan
    WHERE p.title = 'growth 2026-10-01' AND e.kind = 'filed'`).all()).toEqual([{ actor: 'weekly clock' }])
})

test('weekly D2: a UTC Thursday that is local Wednesday, and a local Friday, file no growth plan', async () => {
  const w = clocked()
  await tick(w.db, w.root, never, new Date('2026-10-01T03:00Z'))
  await tick(w.db, w.root, never, new Date('2026-10-03T03:00Z'))
  expect(growths(w)).toEqual([])
})

test.each([
  { why: 'missing', sql: "DELETE FROM pipes WHERE name = 'comms'" },
  { why: 'off', sql: "UPDATE pipes SET enabled = 0 WHERE name = 'comms'" },
])('weekly D3: a local Thursday with the comms lane $why files no growth plan', async ({ sql }) => {
  const w = clocked()
  w.db.prepare(sql).run()
  await tick(w.db, w.root, never, new Date('2026-10-02T03:00Z'))
  expect(growths(w)).toEqual([])
})

test('D3: facts refuses each line that names an issue, an outside login, or no packet entry', () => {
  const w = comms()
  const id = refusal(w, 0)
  gather(w.db, w.root, plan(w.db, 1))
  for (const line of [`Fixed #12 today. [refusal:${String(id)}]`, `See /issues/12 [refusal:${String(id)}]`,
    `See https://github.com/acme/widget/pull/7 [refusal:${String(id)}]`, `Thanks @someone [refusal:${String(id)}]`,
    'One job was refused.', 'One job was refused. [refusal:999]', 'One job landed. [landed:999]',
    `#12 was refused. [refusal:${String(id)}]`, '## Fixed #12', '## Thanks @someone']) {
    expect(judged(w, line)).toMatchObject({ outcome: 'refuse', spans: ['draft.md:3'] })
  }
})

test('D4: facts passes a draft whose every line cites the packet and names no issue or outside login', () => {
  const w = comms()
  const id = refusal(w, 0)
  gather(w.db, w.root, plan(w.db, 1))
  expect(judged(w, `One job was refused. [refusal:${String(id)}]\nThanks @${FORK} [refusal:${String(id)}]`))
    .toMatchObject({ outcome: 'pass', spans: [] })
})

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, '../..', 'seats/writer/tests', name), 'utf8')

test('writer D3: the reply reads as learnings and a post facts passes', () => {
  const w = comms()
  const reply = drafted(fixture('reply.md'))
  expect(reply?.learnings).toMatch(/\S/)
  expect(reply?.post).toMatch(/\S/)
  expect(reply?.dest).toBe('site')
  expect(reply?.dek).toMatch(/\S/)
  expect(reply?.sources).toEqual([{ claim: 'the writer reads the packet', ref: 'templates/comms.ts:16' }])
  expect(reply?.checks).toEqual([{ label: 'every line cites the packet', ok: true }])
  put(w.root, 1, 'packet.json', JSON.stringify({ landed: [{ plan: 7, origin: '', digest: '' }], refusals: [{ id: 3 }] }))
  put(w.root, 1, 'draft.md', reply?.post ?? '')
  expect(facts(w.root, plan(w.db, 1))).toMatchObject({ outcome: 'pass', spans: [] })
})

const varied = (key: string, value: string | null): string => fixture('reply.md').split('\n')
  .flatMap((l) => (l.startsWith(`${key}:`) ? (value === null ? [] : [`${key}: ${value}`]) : [l])).join('\n')

test.each([
  ...['dest', 'dek', 'sources', 'checks', 'learnings'].map((key) => [key, null]),
  ['dek', 'a'.repeat(161)], ['dek', 'a # b'], ['dek', 'a * b'], ['dek', 'a ` b'], ['dest', 'blog'],
  ['checks', '[{"label": "x", "ok": "true"}]'], ['sources', '[{"claim": "x", "ref": "templates/comms.ts"}]'],
  ['sources', '[{"claim": "x", "ref"'],
] as [string, string | null][])('writer D2, D3: a fence with %s as %s reads as null', (key, value) => {
  expect(drafted(varied(key, value))).toBeNull()
})

test('writer D4: a reply with no learnings fence reads as null', () => {
  expect(drafted(fixture('no-learnings.md'))).toBeNull()
})

test('D5: gather writes what landed and today\'s refusals, leaving blips and earlier days out', () => {
  const w = comms()
  const today = refusal(w, 0)
  refusal(w, 1)
  refusal(w, 0, '2000-01-01 00:00:00')
  expect(gather(w.db, w.root, plan(w.db, 1))).toMatchObject({ outcome: 'pass', note: '0 landed, 1 refused' })
  const packet = JSON.parse(get(w.root, 1, 'packet.json')) as { landed: unknown[]; refusals: { id: number }[] }
  expect(packet.landed).toEqual(landed(w.db))
  expect(packet.refusals.map((r) => r.id)).toEqual([today])
})

test('D2: desk writes the post in proof and its day\'s learnings', () => {
  const w = comms()
  titled(w, 1, 'daily 2026-09-27')
  const reply = drafted(fixture('reply.md'))
  expect(desked(w)).toMatchObject({ outcome: 'pass' })
  expect(w.db.prepare('SELECT id, kind, status, dest, title, dek, body, sources, checks, work_date FROM desk_posts').all()).toEqual([{
    id: 1, kind: 'daily', status: 'proof', dest: 'site', title: 'The day', dek: reply?.dek, body: reply?.post.split('\n').slice(1).join('\n').trim(),
    sources: JSON.stringify(reply?.sources), checks: JSON.stringify(reply?.checks), work_date: '2026-09-27',
  }])
  expect(learned(w)).toEqual([{ date: '2026-09-27', numbers: '[]', sources: '["templates/comms.ts:16"]',
    items: JSON.stringify([{ title: reply?.learnings, what: '', lesson: '', fix: '', status: 'noted' }]) }])
})

test('D5: desk stamps proof_at in datetime(\'now\') form', () => {
  const w = comms()
  titled(w, 1, 'daily 2026-09-27')
  desked(w)
  const { form, minutes } = w.db.prepare(`SELECT proof_at = datetime(proof_at) AS form,
    (julianday('now') - julianday(proof_at)) * 1440 AS minutes FROM desk_posts`).get() as { form: number; minutes: number }
  expect(form).toBe(1)
  expect(minutes).toBeGreaterThanOrEqual(0)
  expect(minutes).toBeLessThan(1)
})

test.each([
  ['no fence.json', (w: World) => desked(w, null)],
  ...['dest', 'dek', 'sources', 'checks'].map((key) => [`no ${key}`, (w: World) => desked(w, { ...fenced(), [key]: undefined })]),
  ['no # line', (w: World) => desked(w, fenced(), 'The day\n\nA line.\n')],
  ['no body', (w: World) => desked(w, fenced(), '# The day\n\n')],
  ['no title', (w: World) => { titled(w, 1, null); return desked(w) }],
].map(([why, run]) => ({ why, run })) as { why: string; run: (w: World) => ReturnType<typeof desk> }[])('D3: desk refuses $why and writes no row', ({ run }) => {
  const w = comms()
  titled(w, 1, 'daily 2026-09-27')
  expect(run(w)).toMatchObject({ outcome: 'refuse' })
  expect(w.db.prepare('SELECT (SELECT count(*) FROM desk_posts) + (SELECT count(*) FROM desk_learnings) AS n').get()).toEqual({ n: 0 })
})

test('D4: a fence with no learnings writes the post and a learnings row with no items', () => {
  const w = comms()
  titled(w, 1, 'daily 2026-09-27')
  expect(desked(w, { ...fenced(), learnings: undefined })).toMatchObject({ outcome: 'pass' })
  expect(w.db.prepare('SELECT count(*) AS n FROM desk_posts').get()).toEqual({ n: 1 })
  expect(learned(w)).toMatchObject([{ date: '2026-09-27', items: '[]' }])
})

test('D5: two plans on one work day share one learnings row, and a second desk on one plan doubles nothing', () => {
  const w = comms()
  titled(w, 1, 'daily 2026-09-27')
  w.db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, step, retries, title)
    VALUES (2, 1, 'comms', 'queued', '2026-09-27T10:00:00.000Z', 0, 0, 'ship post acme/widget#7')`).run()
  desked(w)
  desked(w)
  desked(w, { ...fenced(), learnings: 'a second line', sources: [{ claim: 'x', ref: 'cli/plan.ts:1' }] }, undefined, 2)
  expect(w.db.prepare('SELECT id, kind, work_date FROM desk_posts ORDER BY id').all())
    .toEqual([{ id: 1, kind: 'daily', work_date: '2026-09-27' }, { id: 2, kind: 'ship', work_date: '2026-09-27' }])
  const [row] = learned(w) as { items: string; sources: string }[]
  expect(learned(w)).toHaveLength(1)
  expect((JSON.parse(row?.items ?? '[]') as { title: string }[]).map((i) => i.title))
    .toEqual([drafted(fixture('reply.md'))?.learnings, 'a second line'])
  expect(JSON.parse(row?.sources ?? '[]')).toEqual(['templates/comms.ts:16', 'cli/plan.ts:1'])
})

test('D6: desk passes a plan with no draft and writes no row', () => {
  const w = comms()
  titled(w, 1, 'daily 2026-09-27')
  expect(desk(w.db, w.root, plan(w.db, 1))).toEqual({ outcome: 'pass', spans: [], note: 'no draft' })
  expect(w.db.prepare('SELECT (SELECT count(*) FROM desk_posts) + (SELECT count(*) FROM desk_learnings) AS n').get()).toEqual({ n: 0 })
})
