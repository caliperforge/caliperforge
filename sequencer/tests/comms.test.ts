import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { all } from '../../cli/inbox.ts'
import type { Provider } from '../../providers/kind.ts'
import { amend, approved, learnings, learningsIn, paste, placed, postOf, posts, putPost, sentBack } from '../../store/desk.ts'
import { eventsOf, kindsOf, newestMode, runRows } from '../../store/events.ts'
import { set, zone } from '../../store/lanes.ts'
import { retried } from '../../store/holds.ts'
import { addPipe, briefed, dropPlan, end, needsCeo, plansOf, putPlan, requeue, retry } from '../../store/plans.ts'
import { refusalAt, WHY } from '../../store/refusals.ts'
import { verdictRows } from '../../store/verdict.ts'
import { desk, draft, drafted, facts, gather, grow, review } from '../../templates/comms.ts'
import { tick } from '../index.ts'
import { weekly as clock } from '../signals.ts'
import { publish, push } from '../site.ts'
import { mapOf } from '../steps.ts'
import { rule } from '../rule.ts'
import { afresh, drop, FORK, get, git, maybe, put } from '../workspace.ts'
import { plan, reads, stub, world, type World } from './world.ts'

const NAMES = ['gather', 'draft', 'facts', 'text_review', 'desk', 'publish', 'capture', 'grow', 'pack', 'score']

const refusal = (w: World, blip: number, at = new Date().toISOString().replace('T', ' ').slice(0, 19)): number =>
  refusalAt(w.db, 1, blip, at)

const local = (w: World): string => new Date(Date.now() + zone(w.db) * 60000).toISOString().slice(0, 10)

const comms = (): World => {
  const w = world()
  const { queued_at } = plan(w.db, 1)
  dropPlan(w.db, 1)
  putPlan(w.db, { id: 1, pipe_id: 1, target_id: 1, template: 'comms', state: 'queued', queued_at, step: 0, retries: 0 })
  return w
}

/** A comms lane that is on but shut by 20:30, so the daily plan stays queued. */
const clocked = (enabled: number | null = 1): World => {
  const w = world()
  end(w.db, 1, 'done')
  if (enabled !== null) addPipe(w.db, { name: 'comms', enabled, window_start: '07:00', window_end: '20:00', max_concurrent: 1 })
  return w
}

const filed = (w: World, prefix: string): unknown[] =>
  plansOf(w.db, 'comms').filter((p) => p.title?.startsWith(prefix) === true).map(({ title, state }) => ({ title, state }))

const dailies = (w: World): unknown[] => filed(w, 'daily ')

const titled = (w: World, id: number, title: string | null): void => {
  briefed(w.db, id, { title, what: null, why: null, ends: null })
}

const fenced = (): Record<string, unknown> => ({ ...drafted(fixture('reply.md')), post: undefined })

const desked = (w: World, fence: Record<string, unknown> | null = fenced(), draft = drafted(fixture('reply.md'))?.post ?? '',
  id = 1): ReturnType<typeof desk> => {
  put(w.root, id, 'draft.md', draft)
  if (fence !== null) put(w.root, id, 'fence.json', JSON.stringify(fence))
  return desk(w.db, w.root, plan(w.db, id))
}

const events = (w: World): unknown[] => kindsOf(w.db, 1)

const learned = (w: World): unknown[] => learnings(w.db)

const never: Provider = { name: 'claude-agent-sdk', fire: () => { throw new Error('no seat fires on comms') } }

const judged =(w: World, line: string, sources: { claim: string; ref: string }[] = []): ReturnType<typeof facts> => {
  put(w.root, 1, 'draft.md', `# The day\n\n${line}\n`)
  put(w.root, 1, 'fence.json', JSON.stringify({ sources }))
  return facts(w.root, plan(w.db, 1))
}

test('dailyLogs D1 D4: a daily logs items and writes no post', async () => {
  const w = comms()
  const today = new Date().toISOString().slice(0, 10)
  reads(w.db, 1)
  titled(w, 1, `daily ${local(w)}`)
  putPost(w.db, { id: 2, kind: 'daily', dest: 'site', status: 'proof', title: 'The day', dek: 'What moved', body: 'One job landed.',
    edited_title: 'The whole day', sources: '[]', checks: '[]', work_date: today, written_date: today })
  const seats = seated(listing(items('a', 'b', 'c')))
  for (let n = 0; n < 11 && plan(w.db, 1).state !== 'done'; n += 1) await tick(w.db, w.root, seats)
  expect(plan(w.db, 1).state).toBe('done')
  expect(events(w)).toEqual(NAMES.map((kind) => ({ kind, outcome: 'pass' })))
  expect(ran(w)).toEqual(['writer', 'text_review'])
  expect(verdictRows(w.db, 1)).toEqual([])
  expect([maybe(w.root, 1, 'draft.md'), maybe(w.root, 1, 'fence.json')]).toEqual([null, null])
  expect(posts(w.db).map(({ id }) => ({ id }))).toEqual([{ id: 2 }])
  expect(learned(w)).toEqual([{ date: local(w), numbers: '[]', items: JSON.stringify(items('a', 'b', 'c')), sources: '[]' }])
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

const growths = (w: World): unknown[] => filed(w, 'growth ')

test('weekly D1: two local Thursday ticks file one growth plan', async () => {
  const w = clocked()
  await tick(w.db, w.root, never, new Date('2026-10-02T03:00Z'))
  await tick(w.db, w.root, never, new Date('2026-10-02T03:30Z'))
  expect(growths(w)).toEqual([{ title: 'growth 2026-10-01', state: 'queued' }])
  const id = plansOf(w.db, 'comms').find((p) => p.title === 'growth 2026-10-01')?.id ?? 0
  expect(eventsOf(w.db, id, 'filed').map(({ actor }) => ({ actor }))).toEqual([{ actor: 'weekly clock' }])
})

test('weekly D2: no growth plan on a local Wednesday or Friday', async () => {
  const w = clocked()
  await tick(w.db, w.root, never, new Date('2026-10-01T03:00Z'))
  await tick(w.db, w.root, never, new Date('2026-10-03T03:00Z'))
  expect(growths(w)).toEqual([])
})

test.each([
  { why: 'missing', enabled: null },
  { why: 'off', enabled: 0 },
])('weekly D3: a local Thursday with the comms lane $why files no growth plan', async ({ enabled }) => {
  const w = clocked(enabled)
  await tick(w.db, w.root, never, new Date('2026-10-02T03:00Z'))
  expect(growths(w)).toEqual([])
})

const weeklies = (w: World): unknown[] => filed(w, 'weekly ')

test('weeklyPost D1: two Thursday 07:01 ticks file one weekly plan', () => {
  const w = clocked()
  clock(w.db, new Date('2026-10-01T13:01Z'))
  clock(w.db, new Date('2026-10-01T13:01Z'))
  expect(weeklies(w)).toEqual([{ title: 'weekly 2026-09-28', state: 'queued' }])
  const id = plansOf(w.db, 'comms').find((p) => p.title === 'weekly 2026-09-28')?.id ?? 0
  expect(eventsOf(w.db, id, 'filed').map(({ actor }) => ({ actor }))).toEqual([{ actor: 'weekly clock' }])
})

test('weeklyPost D2: Thursday 06:59 files growth and no weekly', () => {
  const w = clocked()
  clock(w.db, new Date('2026-10-01T12:59Z'))
  expect([...weeklies(w), ...growths(w)]).toEqual([{ title: 'growth 2026-10-01', state: 'queued' }])
})

test.each([
  { why: 'a Wednesday', at: '2026-09-30T13:01Z', enabled: 1 },
  { why: 'a Friday', at: '2026-10-02T13:01Z', enabled: 1 },
  { why: 'the comms lane missing', at: '2026-10-01T13:01Z', enabled: null },
  { why: 'the comms lane off', at: '2026-10-01T13:01Z', enabled: 0 },
])('weeklyPost D2: $why at 07:01 files no weekly plan', ({ at, enabled }) => {
  const w = clocked(enabled)
  clock(w.db, new Date(at))
  expect(weeklies(w)).toEqual([])
})

test('D2-D5: facts refuses a tag, issue, login, number or ref', () => {
  const w = comms()
  const id = String(refusal(w, 0))
  gather(w.db, w.root, plan(w.db, 1))
  const sources = [{ claim: `jobs 1, 7, 12 and ${id} were refused`, ref: `refusal:${id}` }]
  for (const line of ['Fixed #12 today.', 'See /issues/12', 'See https://github.com/acme/widget/pull/7', 'Thanks @someone',
    `One job was refused. [refusal:${id}]`, 'One job landed. [landed:1]', '40 jobs were refused.',
    '## Fixed #12', '## Thanks @someone', '## 40 refused']) {
    expect(judged(w, line, sources)).toMatchObject({ outcome: 'refuse', spans: ['draft.md:3'] })
  }
  expect(judged(w, 'One job was refused.', [{ claim: 'one job', ref: 'refusal:999' }]))
    .toMatchObject({ outcome: 'refuse', spans: ['fence.json:refusal:999'] })
})

test('D1: facts passes tagless lines whose numbers are claimed', () => {
  const w = comms()
  const id = refusal(w, 0)
  gather(w.db, w.root, plan(w.db, 1))
  expect(judged(w, `## 2 refused\n2 jobs were refused.\nThanks @${FORK}`, [{ claim: '2 jobs were refused', ref: `refusal:${String(id)}` }]))
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
  expect(reply?.sources).toEqual([{ claim: 'the writer seat drafts the post', ref: 'landed:7' },
    { claim: 'one build was refused for a weakened test', ref: 'refusal:3' }])
  expect(reply?.checks).toEqual([{ label: 'every number is in a source claim', ok: true }])
  put(w.root, 1, 'packet.json', JSON.stringify({ landed: [{ plan: 7, origin: '', digest: '' }], refusals: [{ id: 3 }] }))
  put(w.root, 1, 'draft.md', reply?.post ?? '')
  put(w.root, 1, 'fence.json', JSON.stringify(fenced()))
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

test('D5 D7: gather keys an untitled plan to the local day', () => {
  const w = comms()
  const today = refusal(w, 0)
  refusal(w, 1)
  refusal(w, 0, '2000-01-01 00:00:00')
  expect(gather(w.db, w.root, plan(w.db, 1))).toMatchObject({ outcome: 'pass', note: '0 landed, 1 refused' })
  const packet = JSON.parse(get(w.root, 1, 'packet.json')) as { day: string; learned: unknown[]; landed: unknown[]; refusals: unknown[] }
  expect(packet).toMatchObject({ day: local(w), learned: [], landed: [], refusals: [{ id: today, plan: 1, step: 0, title: null }] })
})

test('D1-D6: gather packs the titled day at local time', () => {
  const w = comms()
  titled(w, 1, 'daily 2026-09-27')
  const [late, early, d] = ['2026-09-28 03:00:00', '2026-09-27 05:00:00', 'd'.repeat(64)]
  w.db.exec(`INSERT INTO desk_learnings (date, numbers, items, sources) VALUES ('2026-09-27', '[]', '[{"title":"a lesson"}]', '[]');
    INSERT INTO tickets (repo, number, title, lane, opened_at) VALUES
      ('r', 1, 'Drift: hq is off', 'machine', '${late}'), ('r', 2, 'Drift: desk is off', 'machine', '${early}'), ('r', 3, 'not drift', 'machine', '${late}');
    INSERT INTO events (plan, at, kind, actor, outcome, message) VALUES (1, '${late}', 'hold', 'coo_lite', 'pass', 'coo_lite hold'),
      (1, '${late}', 'return', 'director', 'pass', 'director return'), (1, '${late}', 'retry', 'ceo', 'pass', 'ceo retry'),
      (1, '${early}', 'hold', 'coo_lite', 'pass', 'coo_lite hold');
    INSERT INTO plans (id, pipe_id, template, state, queued_at, step, retries, title, lane, seat, origin, head_digest) VALUES
      (2, 1, 'pr_path', 'done', '${late}', 0, 0, 'job 2', 'machine', 'typescript_specialist', 'https://github.com/r/issues/2', '${d}'),
      (3, 1, 'pr_path', 'done', '${early}', 0, 0, 'job 3', 'machine', 'typescript_specialist', 'https://github.com/r/issues/3', '${d}');
    INSERT INTO approvals (subject_kind, subject_id, subject_digest, who, decision, approved_at) VALUES
      ('plan', 2, '${d}', 'gates', 'approved', '${late}'), ('plan', 3, '${d}', 'gates', 'approved', '${early}')`)
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
    landed: [{ plan: 2, origin: 'https://github.com/r/issues/2', digest: d, title: 'job 2', at }],
    refusals: [{ id: kept, plan: 1, step: 0, title: 'daily 2026-09-27', at }],
  })
})

test('D2: desk writes the post in proof and its day\'s learnings', () => {
  const w = comms()
  titled(w, 1, 'daily 2026-09-27')
  const reply = drafted(fixture('reply.md'))
  expect(desked(w)).toMatchObject({ outcome: 'pass' })
  expect(posts(w.db)).toMatchObject([{
    id: 1, kind: 'daily', status: 'proof', dest: 'site', title: 'The day', dek: reply?.dek, body: reply?.post.split('\n').slice(1).join('\n').trim(),
    sources: JSON.stringify(reply?.sources), checks: JSON.stringify(reply?.checks), work_date: '2026-09-27',
  }])
  expect(learned(w)).toEqual([{ date: '2026-09-27', numbers: '[]', sources: '["landed:7","refusal:3"]',
    items: JSON.stringify([{ title: reply?.learnings, what: '', lesson: '', fix: '', status: 'noted' }]) }])
})

test('D5: desk stamps proof_at in datetime(\'now\') form', () => {
  const w = comms()
  titled(w, 1, 'daily 2026-09-27')
  desked(w)
  const at = posts(w.db)[0]?.proof_at ?? ''
  expect(at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  const minutes = (Date.now() - Date.parse(`${at.replace(' ', 'T')}Z`)) / 60000
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
  expect([...posts(w.db), ...learnings(w.db)]).toEqual([])
})

test('D4: no learnings writes the post and an empty learnings row', () => {
  const w = comms()
  titled(w, 1, 'daily 2026-09-27')
  expect(desked(w, { ...fenced(), learnings: undefined })).toMatchObject({ outcome: 'pass' })
  expect(posts(w.db)).toHaveLength(1)
  expect(learned(w)).toMatchObject([{ date: '2026-09-27', items: '[]' }])
})

test('D5: one learnings row a day; a second desk doubles nothing', () => {
  const w = comms()
  titled(w, 1, 'daily 2026-09-27')
  putPlan(w.db, { id: 2, pipe_id: 1, target_id: null, template: 'comms', state: 'queued', queued_at: '2026-09-27T10:00:00.000Z',
    step: 0, retries: 0 })
  titled(w, 2, 'ship post acme/widget#7')
  desked(w)
  desked(w)
  desked(w, { ...fenced(), learnings: 'a second line', sources: [{ claim: 'x', ref: 'cli/plan.ts:1' }] }, undefined, 2)
  expect(posts(w.db).map(({ id, kind, work_date }) => ({ id, kind, work_date })))
    .toEqual([{ id: 1, kind: 'daily', work_date: '2026-09-27' }, { id: 2, kind: 'ship', work_date: '2026-09-27' }])
  const [row] = learned(w) as { items: string; sources: string }[]
  expect(learned(w)).toHaveLength(1)
  expect((JSON.parse(row?.items ?? '[]') as { title: string }[]).map((i) => i.title))
    .toEqual([drafted(fixture('reply.md'))?.learnings, 'a second line'])
  expect(JSON.parse(row?.sources ?? '[]')).toEqual(['landed:7', 'refusal:3', 'cli/plan.ts:1'])
})

test('D6: desk passes a plan with no draft and writes no row', () => {
  const w = comms()
  titled(w, 1, 'daily 2026-09-27')
  expect(desk(w.db, w.root, plan(w.db, 1))).toEqual({ outcome: 'pass', spans: [], note: 'no draft' })
  expect([...posts(w.db), ...learnings(w.db)]).toEqual([])
})

const verdict = (name: string): string =>
  readFileSync(join(import.meta.dirname, '../..', 'seats/text_review/tests', name), 'utf8')

const ITEM = { what: 'a build was refused', lesson: 'name the test', fix: 'named it', status: 'fixed' }

const items = (...titles: string[]): Record<string, string>[] => titles.map((title) => ({ title, ...ITEM }))

const listing = (list: Record<string, string>[]): string => `The day.\n\n---\nitems: ${JSON.stringify(list)}\n---\n`

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

test('draftWrites D1: a ship reply fills draft.md and fence.json', async () => {
  const w = posting('ship post acme/widget#7')
  expect(await draft(w.db, w.root, plan(w.db, 1), mapOf('comms').at(1), seated(fixture('reply.md')))).toMatchObject({ outcome: 'pass' })
  expect(get(w.root, 1, 'draft.md')).toBe(drafted(fixture('reply.md'))?.post)
  expect(JSON.parse(get(w.root, 1, 'fence.json'))).toEqual(fenced())
  expect(ran(w)).toEqual(['writer'])
})

test('draftBadFence D2: a bad fence refuses and writes no draft', async () => {
  const w = posting('ship post acme/widget#7')
  expect(await draft(w.db, w.root, plan(w.db, 1), mapOf('comms').at(1), seated(fixture('no-learnings.md'))))
    .toMatchObject({ outcome: 'refuse', spans: ['writer.fence'] })
  expect(maybe(w.root, 1, 'draft.md')).toBeNull()
})

test.each([
  { title: 'daily 2026-09-27', mode: 'log', reply: listing(items('a', 'b', 'c')) },
  { title: 'ship post acme/widget#7', mode: 'ship', reply: fixture('reply.md') },
  { title: 'weekly 2026-10-02', mode: 'weekly', reply: fixture('weekly.md') },
])('writerMode D1 D2: a $title writer runs in $mode', async ({ title, mode, reply }) => {
  const w = posting(title)
  const prompts: string[] = []
  const writer = seated(reply)
  await draft(w.db, w.root, plan(w.db, 1), mapOf('comms').at(1), { ...writer, fire: (packet) => {
    prompts.push(packet.prompt)
    return writer.fire(packet)
  } })
  expect(prompts[0]).toContain(readFileSync(join(import.meta.dirname, '../../seats/modes', `${mode}.md`), 'utf8'))
  expect(newestMode(w.db)).toBe(mode)
})

test.each([
  { why: '2 items', reply: listing(items('a', 'b')) },
  { why: '6 items', reply: listing(items('a', 'b', 'c', 'd', 'e', 'f')) },
  { why: 'a status of done', reply: listing([...items('a', 'b'), { title: 'c', ...ITEM, status: 'done' }]) },
  { why: 'only the ship fence', reply: fixture('reply.md') },
])('dailyRefuses D2: a daily reply of $why refuses on writer.fence and writes no items.json', async ({ reply }) => {
  const w = posting('daily 2026-09-27')
  expect(await draft(w.db, w.root, plan(w.db, 1), mapOf('comms').at(1), seated(reply)))
    .toMatchObject({ outcome: 'refuse', spans: ['writer.fence'] })
  expect(maybe(w.root, 1, 'items.json')).toBeNull()
})

test('dailyReviews D3: text_review reads items.json on a daily', async () => {
  const w = posting('daily 2026-09-27')
  put(w.root, 1, 'items.json', JSON.stringify(items('a', 'b', 'c')))
  expect(await review(w.db, w.root, plan(w.db, 1), mapOf('comms').at(3), seated('', verdict('wording.reply.md'))))
    .toMatchObject({ outcome: 'pass' })
  expect(ran(w)).toEqual(['text_review'])
})

test('dailyMerges D5: a title already in the day is added once', async () => {
  const w = posting('daily 2026-09-27')
  w.db.exec(`INSERT INTO desk_learnings (date, numbers, items, sources) VALUES ('2026-09-27', '[1]', '[{"title":"a lesson"}]', '["x.ts:1"]')`)
  gather(w.db, w.root, plan(w.db, 1))
  await draft(w.db, w.root, plan(w.db, 1), mapOf('comms').at(1), seated(listing(items('a lesson', 'b', 'c'))))
  expect(desk(w.db, w.root, plan(w.db, 1))).toEqual({ outcome: 'pass', spans: [], note: '2 item(s) added to 2026-09-27' })
  expect(learned(w)).toEqual([{ date: '2026-09-27', numbers: '[1]', sources: '["x.ts:1"]',
    items: JSON.stringify([{ title: 'a lesson' }, ...items('b', 'c')]) }])
  expect(posts(w.db)).toEqual([])
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

const REFUSED = '# Refused — answer what this names'

const prompted = async (w: World): Promise<string> => {
  const prompts: string[] = []
  const writer = seated(listing(items('a', 'b', 'c')))
  await draft(w.db, w.root, plan(w.db, 1), mapOf('comms').at(1), { ...writer, fire: (packet) => {
    prompts.push(packet.prompt)
    return writer.fire(packet)
  } })
  return prompts[0] ?? ''
}

test('refusedDraft D1: the writer prompt carries refusal.md', async () => {
  const w = posting('daily 2026-09-27')
  put(w.root, 1, 'refusal.md', 'item b is unsourced')
  expect(await prompted(w)).toContain(`${REFUSED}, keep every item it does not name\n\nitem b is unsourced`)
})

test('unrefusedDraft D2: no refusal.md, no # Refused heading', async () => {
  const w = posting('daily 2026-09-27')
  const prompt = await prompted(w)
  expect(prompt).toContain(`# packet.json\n\n${get(w.root, 1, 'packet.json')}`)
  expect(prompt).not.toContain('# Refused')
  expect(prompt).not.toContain('# Returned from the desk')
})

test('reviewDrops D3: a pass drops refusal.md, a refuse keeps it', async () => {
  const w = posting('daily 2026-09-27')
  put(w.root, 1, 'refusal.md', 'was refused')
  await reviewing(w, verdict('unsourced.reply.md'))
  expect(maybe(w.root, 1, 'refusal.md')).toBe('was refused')
  expect(await reviewing(w, verdict('wording.reply.md'))).toMatchObject({ outcome: 'pass' })
  expect(maybe(w.root, 1, 'refusal.md')).toBeNull()
})

test('prevDraft D1: no refusal.md carries refusal.prev.md', async () => {
  const w = posting('daily 2026-09-27')
  put(w.root, 1, 'refusal.prev.md', 'item c is unsourced')
  expect(await prompted(w)).toContain(`${REFUSED}, keep every item it does not name\n\nitem c is unsourced`)
  put(w.root, 1, 'refusal.md', 'item b is unsourced')
  const prompt = await prompted(w)
  expect(prompt).toContain(`${REFUSED}, keep every item it does not name\n\nitem b is unsourced`)
  expect(prompt).not.toContain('item c is unsourced')
})

test('prevDrops D2: a pass drops refusal.prev.md, refuse keeps', async () => {
  const w = posting('daily 2026-09-27')
  put(w.root, 1, 'refusal.prev.md', 'was refused')
  await reviewing(w, verdict('unsourced.reply.md'))
  expect(maybe(w.root, 1, 'refusal.prev.md')).toBe('was refused')
  expect(await reviewing(w, verdict('wording.reply.md'))).toMatchObject({ outcome: 'pass' })
  expect(maybe(w.root, 1, 'refusal.prev.md')).toBeNull()
})

const turns = (writer: string[], review: string[]): Provider => ({
  name: 'claude-agent-sdk',
  fire: (packet) => stub('', 0, (packet.prompt.includes('# text_review') ? review : writer).shift() ?? '').fire(packet),
})

const rerun = async (second: string): Promise<World> => {
  const w = posting('daily 2026-09-27', 1)
  const seats = turns([listing(items('a', 'b', 'c')), second], [verdict('item.reply.md'), verdict('unsourced.reply.md')])
  for (let n = 0; n < 6; n += 1) await tick(w.db, w.root, seats)
  return w
}

test('rerunChanged D3: a new items.json goes round again', async () => {
  const w = await rerun(listing(items('a', 'b', 'd')))
  expect(plan(w.db, 1).step).toBe(1)
  expect(plan(w.db, 1).state).not.toBe('blocked_on_ceo')
  expect(get(w.root, 1, 'refusal.md')).not.toContain('# Stopped')
})

test('rerunSame D4: the same items.json stops as unchanged', async () => {
  const w = await rerun(listing(items('a', 'b', 'c')))
  const stop = `# Stopped\n\n${WHY.unchanged}.\n`
  expect(plan(w.db, 1).state).toBe('blocked_on_ceo')
  expect(get(w.root, 1, 'refusal.md').slice(-stop.length)).toBe(stop)
})

test('deskThenRefused D4: the desk note comes before the refusal', async () => {
  const w = posting('daily 2026-09-27')
  putPost(w.db, { id: 1, kind: 'daily', dest: 'site', status: 'proof', title: 'The day', dek: 'What moved', body: 'One job landed.',
    edited_title: null, sources: '[]', checks: '[]', work_date: '2026-09-27', written_date: '2026-09-27' })
  sentBack(w.db, 1, 'warmer', 'ceo')
  put(w.root, 1, 'refusal.md', 'was refused')
  const prompt = await prompted(w)
  expect(prompt).toContain('# Returned from the desk\n\nwarmer')
  expect(prompt.indexOf('# Returned from the desk')).toBeLessThan(prompt.indexOf(REFUSED))
})

test('retry D1: comms 3 goes to 1; comms 7, pr_path 3 and 4 to 2', () => {
  const at = (w: World, step: number): number[] => {
    requeue(w.db, 1, step)
    return [retry(w.db, plan(w.db, 1)), plan(w.db, 1).step]
  }
  expect([at(comms(), 3), at(comms(), 7), at(world(), 3), at(world(), 4)]).toEqual([[1, 1], [2, 2], [2, 2], [2, 2]])
})

test('retried D2: the writer reruns with the step-3 refusal', async () => {
  const w = posting('daily 2026-09-27', 3)
  put(w.root, 1, 'refusal.md', 'item b is unsourced')
  needsCeo(w.db, plan(w.db, 1))
  afresh(w.root, 1, retried(w.db, 1, 'ceo'))
  const prompts: string[] = []
  const writer = seated(listing(items('a', 'b', 'c')))
  await tick(w.db, w.root, { ...writer, fire: (packet) => {
    prompts.push(packet.prompt)
    return writer.fire(packet)
  } })
  expect(ran(w)).toEqual(['writer'])
  expect(prompts[0]).toContain(`${REFUSED}, keep every item it does not name\n\nitem b is unsourced`)
})

test('ruledComms D3: a reviewed comms plan gets issue.md', async () => {
  const w = posting('daily 2026-09-27', 3)
  await reviewing(w, verdict('wording.reply.md'))
  expect(rule(w.db, w.root, plan(w.db, 1), 'director', 'keep item b')).toBe('issue.md')
  expect(get(w.root, 1, 'issue.md')).toContain(`## Answer from the director (${new Date().toISOString().slice(0, 10)})\n\nkeep item b\n`)
})

test('ruledDraft D4: issue.md goes under # Rulings, none without', async () => {
  const w = posting('daily 2026-09-27')
  put(w.root, 1, 'refusal.md', 'was refused')
  put(w.root, 1, 'issue.md', 'keep item b')
  const prompt = await prompted(w)
  expect(prompt).toContain('# Rulings\n\nkeep item b')
  expect(prompt.indexOf('# Rulings')).toBeLessThan(prompt.indexOf(REFUSED))
  drop(w.root, 1, 'issue.md')
  drop(w.root, 1, 'ask.md')
  expect(await prompted(w)).not.toContain('# Rulings')
})

test.each(['growth 2026-09-28', 'scorecard 2026-09-28'])('D5: a %s plan passes steps 1 and 3 with no run and no draft', async (title) => {
  const w = posting(title, 1)
  for (let n = 0; n < 3; n += 1) await tick(w.db, w.root, never)
  expect(events(w)).toEqual(['draft', 'facts', 'text_review'].map((kind) => ({ kind, outcome: 'pass' })))
  expect(eventsOf(w.db, 1, 'text_review')).toEqual([{ actor: 'text_review', outcome: 'pass', message: 'skipped: no draft' }])
  expect(ran(w)).toEqual([])
  expect(maybe(w.root, 1, 'draft.md')).toBeNull()
})

test('growUnchanged D6: step 7 still runs growth_lead', async () => {
  const w = posting('growth 2026-09-28', 7)
  await tick(w.db, w.root, stub('', 0, 'the pack'))
  expect(ran(w)).toEqual(['growth_lead'])
  expect(get(w.root, 1, 'growth.md')).toBe('the pack')
})

test('weeklyGrows D2: a weekly plan runs text_review, growth_lead', async () => {
  const w = posting('weekly 2026-10-05')
  expect(await reviewing(w, verdict('wording.reply.md'))).toMatchObject({ outcome: 'pass' })
  expect(await grow(w.db, w.root, plan(w.db, 1), mapOf('comms').at(7), stub('', 0, 'the pack'))).toMatchObject({ outcome: 'pass' })
  expect(ran(w)).toEqual(['text_review', 'growth_lead'])
})

const storied = (dir: string): World => {
  const w = comms()
  titled(w, 1, 'weekly 2026-10-02')
  set(w.db, 'comms.story_dir', dir, 'ceo', '2026-10-02')
  return w
}

test('weeklyPacket D1 D2 D5: learnings in the window, .md by name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-story-'))
  mkdirSync(join(dir, 'sub'))
  for (const [name, text] of [['b.md', 'bee'], ['a.md', 'ay'], ['notes.txt', 'no'], ['sub/c.md', 'sea']] as const) writeFileSync(join(dir, name), text)
  const w = storied(dir)
  w.db.exec(`INSERT INTO desk_learnings (date, numbers, items, sources) VALUES ${['2026-10-03', '2026-09-25', '2026-10-02', '2026-09-26']
    .map((d) => `('${d}', '[]', '[{"title":"${d}"}]', '[]')`).join(', ')}`)
  const kept = [{ date: '2026-09-26', items: [{ title: '2026-09-26' }] }, { date: '2026-10-02', items: [{ title: '2026-10-02' }] }]
  expect(learningsIn(w.db, '2026-09-26', '2026-10-02')).toEqual(kept)
  expect(gather(w.db, w.root, plan(w.db, 1))).toMatchObject({ outcome: 'pass' })
  expect(JSON.parse(get(w.root, 1, 'packet.json'))).toEqual({ learnings: kept, story: [{ name: 'a.md', text: 'ay' }, { name: 'b.md', text: 'bee' }] })
})

test.each([
  { dir: '', spans: ['comms.story_dir'], named: 'comms.story_dir' },
  { dir: '~/cf-no-story-dir', spans: [`${homedir()}/cf-no-story-dir`], named: `${homedir()}/cf-no-story-dir` },
])('storyDir D3 D4: story_dir "$dir" refuses and writes no packet', ({ dir, spans, named }) => {
  const w = storied(dir)
  const got = gather(w.db, w.root, plan(w.db, 1))
  expect(got).toMatchObject({ outcome: 'refuse', spans })
  expect(got.note).toContain(named)
  expect(maybe(w.root, 1, 'packet.json')).toBeNull()
})

test('weeklyDraft D1: a substack reply with a script passes', async () => {
  const w = posting('weekly 2026-10-02')
  expect(await draft(w.db, w.root, plan(w.db, 1), mapOf('comms').at(1), seated(fixture('weekly.md')))).toMatchObject({ outcome: 'pass' })
  expect(get(w.root, 1, 'draft.md')).toBe(drafted(fixture('weekly.md'))?.post)
  expect(JSON.parse(get(w.root, 1, 'fence.json'))).toEqual({ ...drafted(fixture('weekly.md')), post: undefined })
})

test.each([
  { why: 'dest site', reply: fixture('weekly.md').replace('dest: substack', 'dest: site') },
  { why: 'dest note', reply: fixture('weekly.md').replace('dest: substack', 'dest: note') },
  { why: 'no ## Script', reply: fixture('weekly.md').replace('## Script', '## The script') },
])('weeklyFence D2: a weekly reply with $why refuses', async ({ reply }) => {
  const w = posting('weekly 2026-10-02')
  expect(await draft(w.db, w.root, plan(w.db, 1), mapOf('comms').at(1), seated(reply)))
    .toMatchObject({ outcome: 'refuse', spans: ['writer.fence'] })
  expect(maybe(w.root, 1, 'draft.md')).toBeNull()
})

test('weeklyFacts D3: untagged passes, links and logins refuse', () => {
  const w = comms()
  put(w.root, 1, 'packet.json', JSON.stringify({ learnings: [], story: [] }))
  for (const line of ['One untagged line.', `Thanks @${FORK}`]) expect(judged(w, line)).toMatchObject({ outcome: 'pass', spans: [] })
  for (const line of ['Fixed #12 today.', 'See /issues/12', 'See https://github.com/acme/widget/pull/7', 'Thanks @someone']) {
    expect(judged(w, line)).toMatchObject({ outcome: 'refuse', spans: ['draft.md:3'] })
  }
})

test('weeklyDesk D4: a weekly plan lands a substack post', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-story-'))
  writeFileSync(join(dir, 'README.md'), '# The story\n')
  const w = storied(dir)
  reads(w.db, 1)
  const prompts: string[] = []
  const writer = seated(fixture('weekly.md'))
  const lead = stub('', 0, readFileSync(join(import.meta.dirname, '../../seats/growth_lead/tests/reply.md'), 'utf8'))
  const seats: Provider = { ...writer, fire: (packet) => {
    prompts.push(packet.prompt)
    return (packet.prompt.includes('# growth_lead') ? lead : writer).fire(packet)
  } }
  for (let n = 0; n < 11 && plan(w.db, 1).state !== 'done'; n += 1) await tick(w.db, w.root, seats)
  expect(plan(w.db, 1).state).toBe('done')
  const written = prompts.find((p) => p.includes('# writer')) ?? ''
  for (const part of ['"learnings"', '"story"', '# The story']) expect(written).toContain(part)
  expect(posts(w.db)).toMatchObject([{ id: 1, kind: 'weekly', dest: 'substack', status: 'proof', work_date: '2026-10-02' },
    { id: 2_000_001, kind: 'growth', dest: 'pack', status: 'proof', work_date: '2026-10-02' }])
  expect(posts(w.db)[0]?.body).toContain('## Script')
})

const POST05 = 'blog/05_jito-tippayment-and-ai-invariant-suggester-live.html'

const SITE = { [POST05]: '<html><head><title>x</title></head><body><h1>x</h1><article>x</article></body></html>', 'blog/index.html': '<ul>\n</ul>' }

const SEED = { id: 2, kind: 'ship', dest: 'site', status: 'approved', title: 'A <post> & more', dek: 'd', body: '## Why\n\nOne <b> line.\n\nTwo.',
  edited_title: null, sources: '[]', checks: '[]', work_date: '2026-10-01', written_date: '2026-10-02' } satisfies Parameters<typeof putPost>[1]

const sited = (files: Record<string, string> = SITE): string => {
  const [origin, dir] = [mkdtempSync(join(tmpdir(), 'cf-origin-')), mkdtempSync(join(tmpdir(), 'cf-site-'))]
  git(origin, ['init', '--bare', '-b', 'main'])
  git(dir, ['init', '-b', 'main'])
  for (const [key, value] of [['user.name', 'cf'], ['user.email', 'cf@example.com'], ['commit.gpgsign', 'false']] as const) git(dir, ['config', key, value])
  mkdirSync(join(dir, 'blog'))
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text)
  git(dir, ['add', '.'])
  git(dir, ['commit', '--allow-empty', '-m', 'seed'])
  git(dir, ['remote', 'add', 'origin', origin])
  git(dir, ['push', '-u', 'origin', 'main'])
  return dir
}

const published = (w: World, dir: string, title = 'ship post acme/widget#7'): ReturnType<typeof publish> => {
  titled(w, 1, title)
  set(w.db, 'comms.site_dir', dir, 'ceo', '2026-10-04')
  return publish(w.db, w.root, plan(w.db, 1), mapOf('comms').at(5))
}

const ahead = (dir: string): string => git(dir, ['rev-list', '--count', 'origin/main..HEAD']).trim()

test('publish D1 D2 D3 D6: a site row is written and committed', () => {
  const w = comms()
  const dir = sited()
  putPost(w.db, SEED)
  expect(published(w, dir)).toEqual({ outcome: 'pass', spans: [], note: `1 post(s) written to ${dir}` })
  const [name, title] = ['06_a-post-more', 'A &lt;post&gt; &amp; more']
  expect(readFileSync(join(dir, `blog/${name}.html`), 'utf8')).toBe(`<html><head><title>${title}</title></head><body>\n<h1>${title}</h1>
<p class="dateline">Work completed 2026-10-01 · written up 2026-10-02.</p>\n<h2>Why</h2>\n<p>One &lt;b&gt; line.</p>\n<p>Two.</p>
</article></body></html>`)
  expect(readFileSync(join(dir, 'blog/index.html'), 'utf8')).toBe(`<ul>\n<li><a href="${name}.html">${title}</a> · 2026-10-02</li>\n</ul>`)
  expect(postOf(w.db, 2)).toMatchObject({ status: 'approved', url: `https://caliperforge.com/blog/${name}.html`, published_at: null })
  expect([git(dir, ['log', '-1', '--format=%s']).trim(), ahead(dir)]).toEqual([`post: ${name}`, '1'])
  expect(all(w.root)).toMatchObject([{ kind: 'signoff', plan: 1, step: 5, name: 'publish', note: 'site post ready: run `cf site push`' }])
})

test.each([
  { why: 'a proof row', row: { status: 'proof' as const }, url: null, title: undefined },
  { why: 'a note row', row: { dest: 'note' as const }, url: null, title: undefined },
  { why: 'a placed row', row: {}, url: 'https://caliperforge.com/blog/05_x.html', title: undefined },
  { why: 'a daily plan', row: {}, url: null, title: 'daily 2026-10-04' },
])('publish D4: $why writes and commits nothing', ({ row, url, title }) => {
  const w = comms()
  const dir = sited()
  putPost(w.db, { ...SEED, ...row })
  if (url !== null) placed(w.db, 2, url)
  expect(published(w, dir, title)).toMatchObject({ outcome: 'pass' })
  expect(readdirSync(join(dir, 'blog')).sort()).toEqual([POST05.slice('blog/'.length), 'index.html'])
  expect([ahead(dir), postOf(w.db, 2).url, all(w.root)]).toEqual(['0', url, []])
})

test('publish D5: an unset comms.site_dir refuses', () => {
  const w = comms()
  putPost(w.db, SEED)
  expect(published(w, '')).toEqual({ outcome: 'refuse', spans: ['comms.site_dir'], note: 'comms.site_dir is unset' })
})

test.each([POST05, 'blog/index.html'])('publish D5: a site with no %s throws', (missing) => {
  const w = comms()
  const dir = sited(Object.fromEntries(Object.entries(SITE).filter(([path]) => path !== missing)))
  putPost(w.db, SEED)
  expect(() => published(w, dir)).toThrow(/ENOENT/)
  expect([postOf(w.db, 2).url, ahead(dir)]).toEqual([null, '0'])
})

test('push D1 D2 D3: pushes and marks placed rows published', () => {
  const w = comms()
  const dir = sited()
  putPost(w.db, SEED)
  published(w, dir)
  putPost(w.db, { ...SEED, id: 3 })
  const now = new Date('2026-10-04T12:00:00.000Z')
  expect(push(w.db, now)).toBe(1)
  expect([ahead(dir), git(dir, ['ls-remote', 'origin', 'main']).split('\t')[0]]).toEqual(['0', git(dir, ['rev-parse', 'HEAD']).trim()])
  expect(postOf(w.db, 2)).toMatchObject({ status: 'published', published_at: now.toISOString() })
  expect(postOf(w.db, 3)).toMatchObject({ status: 'approved', url: null, published_at: null })
})

test('push D4: a failed push marks nothing', () => {
  const w = comms()
  const dir = sited()
  putPost(w.db, SEED)
  published(w, dir)
  git(dir, ['remote', 'set-url', 'origin', join(dir, 'missing')])
  expect(() => push(w.db, new Date())).toThrow()
  expect(postOf(w.db, 2)).toMatchObject({ status: 'approved', published_at: null })
})

test('push D5: an unset comms.site_dir throws', () => {
  const w = comms()
  set(w.db, 'comms.site_dir', '', 'ceo', '2026-10-04')
  expect(() => push(w.db, new Date())).toThrow('comms.site_dir is unset')
})

const PLACED = 'https://caliperforge.com/blog/06_week.html'

test('paste D1 D2: a placed weekly leaves one paste row, once', () => {
  const w = comms()
  putPost(w.db, { ...SEED, id: 1, kind: 'weekly', dest: 'substack', status: 'proof' })
  amend(w.db, 1, { title: 'T', dek: 'K', body: 'B' }, 'ceo')
  approved(w.db, 1, 'ceo')
  placed(w.db, 1, PLACED)
  expect(paste(w.db)).toBe(1)
  expect(postOf(w.db, 1_000_001)).toMatchObject({ kind: 'paste', dest: 'paste', status: 'proof', title: 'T', dek: 'K',
    body: 'B\n\nhttps://medium.com/p/import https://caliperforge.com/blog/06_week.html', work_date: '2026-10-01' })
  expect([paste(w.db), posts(w.db).length]).toEqual([0, 2])
})

test('paste D3: an unplaced weekly or a placed ship row gives none', () => {
  const w = comms()
  putPost(w.db, { ...SEED, kind: 'weekly', dest: 'substack', status: 'proof' })
  putPost(w.db, { ...SEED, id: 3, kind: 'weekly', dest: 'substack' })
  putPost(w.db, { ...SEED, id: 4, work_date: '2026-09-24' })
  placed(w.db, 4, PLACED)
  expect([paste(w.db), posts(w.db).length]).toEqual([0, 3])
})

test('publish D4: a placed weekly leaves its paste row', () => {
  const w = comms()
  putPost(w.db, { ...SEED, kind: 'weekly', dest: 'substack' })
  expect(published(w, sited())).toMatchObject({ outcome: 'pass' })
  const url = 'https://caliperforge.com/blog/06_a-post-more.html'
  expect(postOf(w.db, 2).url).toBe(url)
  expect(posts(w.db).filter((p) => p.kind === 'paste')).toMatchObject([{ id: 1_000_002, body: SEED.body.concat('\n\nhttps://medium.com/p/import ', url) }])
})
