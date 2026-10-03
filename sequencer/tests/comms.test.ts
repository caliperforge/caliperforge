import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Provider } from '../../providers/kind.ts'
import { runRows } from '../../store/events.ts'
import { zone } from '../../store/lanes.ts'
import { requeue } from '../../store/plans.ts'
import { desk, draft, drafted, facts, gather, review } from '../../templates/comms.ts'
import { tick } from '../index.ts'
import { mapOf } from '../steps.ts'
import { FORK, get, maybe, put } from '../workspace.ts'
import { plan, reads, stub, world, type World } from './world.ts'

const NAMES = ['gather', 'draft', 'facts', 'text_review', 'desk', 'publish', 'capture', 'grow', 'pack', 'score']

const refusal = (w: World, blip: number, at = new Date().toISOString().replace('T', ' ').slice(0, 19)): number =>
  Number(w.db.prepare(`INSERT INTO refusals (plan, step, fingerprint, diff, blip, at) VALUES (1, 0, ?, NULL, ?, ?)`)
    .run('0'.repeat(64), blip, at).lastInsertRowid)

const local = (w: World): string => new Date(Date.now() + zone(w.db) * 60000).toISOString().slice(0, 10)

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

const events = (w: World): unknown[] => w.db.prepare('SELECT kind, outcome FROM events WHERE plan = 1 ORDER BY id').all()

const learned = (w: World): unknown[] => w.db.prepare('SELECT * FROM desk_learnings').all()

const never: Provider = { name: 'claude-agent-sdk', fire: () => { throw new Error('no seat fires on comms') } }

const judged =(w: World, line: string): ReturnType<typeof facts> => {
  put(w.root, 1, 'draft.md', `# The day\n\n${line}\n`)
  return facts(w.root, plan(w.db, 1))
}

test('D2 D7 D6: a comms plan runs writer and text_review to done', async () => {
  const w = comms()
  const today = new Date().toISOString().slice(0, 10)
  reads(w.db, 1)
  titled(w, 1, `daily ${local(w)}`)
  w.db.prepare(`INSERT INTO desk_posts (id, kind, dest, status, title, dek, body, edited_title, sources, checks, work_date, written_date)
    VALUES (2, 'daily', 'site', 'proof', 'The day', 'What moved', 'One job landed.', 'The whole day', '[]', '[]', ?, ?)`).run(today, today)
  const seats = seated(writing(`# The day\n\nOne job was refused. [refusal:${String(refusal(w, 0))}]`))
  for (let n = 0; n < 11 && plan(w.db, 1).state !== 'done'; n += 1) await tick(w.db, w.root, seats)
  expect(plan(w.db, 1).state).toBe('done')
  expect(events(w)).toEqual(NAMES.map((kind) => ({ kind, outcome: 'pass' })))
  expect(ran(w)).toEqual(['writer', 'text_review'])
  expect(w.db.prepare('SELECT count(*) AS n FROM verdicts').get()).toEqual({ n: 0 })
  expect(w.db.prepare('SELECT id FROM desk_posts').all()).toEqual([{ id: 1 }, { id: 2 }])
  expect(readFileSync(join(w.root, 'comms/voice-notes.md'), 'utf8')).toBe(`# Voice notes\n\n- ${today} 2 title: lengthened (7 → 13 chars)\n`)
})

test('two ticks past 20:30 on one local day file one daily plan', async () => {
  const w = clocked()
  await tick(w.db, w.root, never, new Date('2026-09-28T02:31Z'))
  await tick(w.db, w.root, never, new Date('2026-09-28T02:45Z'))
  expect(dailies(w)).toEqual([{ title: 'daily 2026-09-27', state: 'queued' }])
})

test('a tick before 20:30 files none; next day after, a second', async () => {
  const w = clocked()
  await tick(w.db, w.root, never, new Date('2026-09-28T02:29Z'))
  expect(dailies(w)).toEqual([])
  await tick(w.db, w.root, never, new Date('2026-09-28T02:31Z'))
  await tick(w.db, w.root, never, new Date('2026-09-29T02:31Z'))
  expect(dailies(w)).toEqual([{ title: 'daily 2026-09-27', state: 'queued' }, { title: 'daily 2026-09-28', state: 'queued' }])
})

const growths = (w: World): unknown[] =>
  w.db.prepare("SELECT title, state FROM plans WHERE template = 'comms' AND title LIKE 'growth %' ORDER BY id").all()

test('weekly D1: two local Thursday ticks file one growth plan', async () => {
  const w = clocked()
  await tick(w.db, w.root, never, new Date('2026-10-02T03:00Z'))
  await tick(w.db, w.root, never, new Date('2026-10-02T03:30Z'))
  expect(growths(w)).toEqual([{ title: 'growth 2026-10-01', state: 'queued' }])
  expect(w.db.prepare(`SELECT e.actor FROM events e JOIN plans p ON p.id = e.plan
    WHERE p.title = 'growth 2026-10-01' AND e.kind = 'filed'`).all()).toEqual([{ actor: 'weekly clock' }])
})

test('weekly D2: no growth plan on a local Wednesday or Friday', async () => {
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

test('D3: facts refuses a line with an issue, login or no entry', () => {
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

test('D4: facts passes a cited draft with no issue or login', () => {
  const w = comms()
  const id = refusal(w, 0)
  gather(w.db, w.root, plan(w.db, 1))
  expect(judged(w, `One job was refused. [refusal:${String(id)}]\nThanks @${FORK} [refusal:${String(id)}]`))
    .toMatchObject({ outcome: 'pass', spans: [] })
})

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, '../..', 'seats/writer/tests', name), 'utf8')

test('writer D3: the reply reads as learnings and a passing post', () => {
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

test('D5 D7: gather on an untitled plan keys to the local day\'s titled, non-blip refusals', () => {
  const w = comms()
  const today = refusal(w, 0)
  refusal(w, 1)
  refusal(w, 0, '2000-01-01 00:00:00')
  expect(gather(w.db, w.root, plan(w.db, 1))).toMatchObject({ outcome: 'pass', note: '0 landed, 1 refused' })
  const packet = JSON.parse(get(w.root, 1, 'packet.json')) as { day: string; learned: unknown[]; landed: unknown[]; refusals: unknown[] }
  expect(packet).toMatchObject({ day: local(w), learned: [], landed: [], refusals: [{ id: today, plan: 1, step: 0, title: null }] })
})

test('D1-D6: gather writes the titled day\'s learnings, drift, decisions, landings and refusals at local time', () => {
  const w = comms()
  titled(w, 1, 'daily 2026-09-27')
  const [late, early] = ['2026-09-28 03:00:00', '2026-09-27 05:00:00']
  w.db.prepare("INSERT INTO desk_learnings (date, numbers, items, sources) VALUES ('2026-09-27', '[]', ?, '[]')").run('[{"title":"a lesson"}]')
  w.db.prepare(`INSERT INTO tickets (repo, number, title, lane, opened_at) VALUES
    ('r', 1, 'Drift: hq is off', 'machine', ?), ('r', 2, 'Drift: desk is off', 'machine', ?), ('r', 3, 'not drift', 'machine', ?)`).run(late, early, late)
  const event = w.db.prepare("INSERT INTO events (plan, at, kind, actor, outcome, message) VALUES (1, ?, ?, ?, 'pass', ?)")
  for (const [at, kind, actor] of [[late, 'hold', 'coo_lite'], [late, 'return', 'director'], [late, 'retry', 'ceo'], [early, 'hold', 'coo_lite']] as const) {
    event.run(at, kind, actor, `${actor} ${kind}`)
  }
  for (const [id, at] of [[2, late], [3, early]] as const) {
    w.db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, step, retries, title, lane, seat, origin, head_digest)
      VALUES (?, 1, 'pr_path', 'done', ?, 0, 0, ?, 'machine', 'typescript_specialist', ?, ?)`).run(id, at, `job ${String(id)}`, `https://github.com/r/issues/${String(id)}`, 'd'.repeat(64))
    w.db.prepare(`INSERT INTO approvals (subject_kind, subject_id, subject_digest, who, decision, approved_at)
      VALUES ('plan', ?, ?, 'gates', 'approved', ?)`).run(id, 'd'.repeat(64), at)
  }
  const kept = refusal(w, 0, late)
  refusal(w, 0, early)
  refusal(w, 1, late)
  gather(w.db, w.root, plan(w.db, 1))
  const at = '2026-09-27 21:00:00'
  expect(JSON.parse(get(w.root, 1, 'packet.json'))).toEqual({
    day: '2026-09-27',
    learned: [{ title: 'a lesson' }],
    drift: [{ number: 1, title: 'Drift: hq is off', at }],
    decisions: [{ plan: 1, title: 'daily 2026-09-27', actor: 'coo_lite', kind: 'hold', why: 'coo_lite hold', at },
      { plan: 1, title: 'daily 2026-09-27', actor: 'director', kind: 'return', why: 'director return', at }],
    landed: [{ plan: 2, origin: 'https://github.com/r/issues/2', digest: 'd'.repeat(64), title: 'job 2', at }],
    refusals: [{ id: kept, plan: 1, step: 0, title: 'daily 2026-09-27', at }],
  })
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

test('D4: no learnings writes the post and an empty learnings row', () => {
  const w = comms()
  titled(w, 1, 'daily 2026-09-27')
  expect(desked(w, { ...fenced(), learnings: undefined })).toMatchObject({ outcome: 'pass' })
  expect(w.db.prepare('SELECT count(*) AS n FROM desk_posts').get()).toEqual({ n: 1 })
  expect(learned(w)).toMatchObject([{ date: '2026-09-27', items: '[]' }])
})

test('D5: one learnings row a day; a second desk doubles nothing', () => {
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

const verdict = (name: string): string =>
  readFileSync(join(import.meta.dirname, '../..', 'seats/text_review/tests', name), 'utf8')

/** `post` under reply.md's fence, as the writer answers. */
const writing = (post: string): string => `${post}\n\n${fixture('reply.md').slice(fixture('reply.md').indexOf('---'))}`

/** The text_review seat answers `review`; every other seat answers `writer`. */
const seated = (writer: string, review = verdict('wording.reply.md')): Provider => ({
  name: 'claude-agent-sdk',
  fire: (packet) => stub('', 0, packet.prompt.includes('# text_review') ? review : writer).fire(packet),
})

const ran = (w: World): string[] => runRows(w.db).map((r) => r.seat)

const posting = (title: string, step = 0): World => {
  const w = comms()
  titled(w, 1, title)
  requeue(w.db, 1, step)
  put(w.root, 1, 'packet.json', JSON.stringify({ landed: [{ plan: 7, origin: '', digest: '' }], refusals: [{ id: 3 }] }))
  return w
}

const reviewing = (w: World, reply: string): ReturnType<typeof review> => {
  put(w.root, 1, 'draft.md', drafted(fixture('reply.md'))?.post ?? '')
  return review(w.db, w.root, plan(w.db, 1), mapOf('comms').at(3), seated('', reply))
}

test('draftWrites D1: a daily reply fills draft.md and fence.json', async () => {
  const w = posting('daily 2026-09-27')
  expect(await draft(w.db, w.root, plan(w.db, 1), mapOf('comms').at(1), seated(fixture('reply.md')))).toMatchObject({ outcome: 'pass' })
  expect(get(w.root, 1, 'draft.md')).toBe(drafted(fixture('reply.md'))?.post)
  expect(JSON.parse(get(w.root, 1, 'fence.json'))).toEqual(fenced())
  expect(ran(w)).toEqual(['writer'])
})

test('draftBadFence D2: a bad fence refuses and writes no draft', async () => {
  const w = posting('daily 2026-09-27')
  expect(await draft(w.db, w.root, plan(w.db, 1), mapOf('comms').at(1), seated(fixture('no-learnings.md'))))
    .toMatchObject({ outcome: 'refuse', spans: ['writer.fence'] })
  expect(maybe(w.root, 1, 'draft.md')).toBeNull()
})

test('reviewRefuses D3: a refuse goes back to step 1 on its spans', async () => {
  expect(await reviewing(posting('daily 2026-09-27'), verdict('unsourced.reply.md')))
    .toMatchObject({ outcome: 'refuse', spans: ['draft.md:3'], to: 1 })
})

test('reviewPasses D4: a pass keeps its prose in review.md', async () => {
  const w = posting('daily 2026-09-27')
  expect(await reviewing(w, verdict('wording.reply.md'))).toMatchObject({ outcome: 'pass' })
  expect(get(w.root, 1, 'review.md')).toContain('seamlessly')
})

test.each(['growth 2026-09-28', 'scorecard 2026-09-28'])('D5: a %s plan passes steps 1 and 3 with no run and no draft', async (title) => {
  const w = posting(title, 1)
  for (let n = 0; n < 3; n += 1) await tick(w.db, w.root, never)
  expect(events(w)).toEqual(['draft', 'facts', 'text_review'].map((kind) => ({ kind, outcome: 'pass' })))
  expect(ran(w)).toEqual([])
  expect(maybe(w.root, 1, 'draft.md')).toBeNull()
})

test('growUnchanged D6: step 7 still runs growth_lead', async () => {
  const w = posting('growth 2026-09-28', 7)
  await tick(w.db, w.root, stub('', 0, 'the pack'))
  expect(ran(w)).toEqual(['growth_lead'])
  expect(get(w.root, 1, 'growth.md')).toBe('the pack')
})
