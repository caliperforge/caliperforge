import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { WINDOW, type Read } from '../../cli/gh.ts'
import type { Db } from '../../store/index.ts'
import { intake } from '../capture.ts'
import { tick } from '../index.ts'
import { CARRIED, stub } from './world.ts'

const schema = join(import.meta.dirname, '../../schema')

const REPO = 'caliperforge/caliperforge'

const url = (n: number): string => `https://github.com/${REPO}/issues/${String(n)}`

interface Fixture { number: number; labels: string[]; parts?: number; title?: string; body?: string }

const TWO: Fixture[] = [{ number: 40, labels: ['lane:machine'] }, { number: 41, labels: ['lane:machine', 'P2'] }]

function canned(rows: Fixture[], log: string[] = []): Read {
  return (args) => {
    log.push(args.join(' '))
    const shaped = rows.map((r) => ({ number: r.number, title: r.title ?? `issue ${String(r.number)}`, body: r.body ?? 'the ask',
      url: url(r.number), labels: r.labels.map((name) => ({ name })) }))
    if (args[1] === 'list') return shaped
    if (args[0] === 'api') {
      const no = Number(args[1]?.split('/').at(-1))
      return { sub_issues_summary: { total: rows.find((r) => r.number === no)?.parts ?? 0 } }
    }
    const hit = shaped.find((r) => String(r.number) === args[2])
    if (hit === undefined) throw new Error(`no fixture for ${args.join(' ')}`)
    return hit
  }
}

function piped(enabled = 1): Db {
  const db = fresh(schema)
  db.prepare("INSERT INTO pipes (name, enabled, window_start, window_end, max_concurrent) VALUES ('internal', ?, '00:00', '23:59', 1)")
    .run(enabled)
  return db
}

function queue(db: Db, n: number, state = 'queued'): void {
  db.prepare(`INSERT INTO plans (pipe_id, template, state, queued_at, lane, seat, origin)
    VALUES (1, 'pr_path', ?, '2026-09-18', 'machine', 'typescript_specialist', ?)`).run(state, url(n))
}

const states = (db: Db): unknown[] => db.prepare('SELECT origin, state FROM plans ORDER BY id').all()

let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cf-intake-')) })

test('D1: each open lane issue on a switched-on lane home becomes a queued plan with its ask written', () => {
  const db = piped()
  intake(db, root, canned(TWO))
  expect(db.prepare('SELECT id, origin, state, priority FROM plans ORDER BY id').all()).toEqual([
    { id: 1, origin: url(40), state: 'queued', priority: 1 },
    { id: 2, origin: url(41), state: 'queued', priority: 2 },
  ])
  for (const id of [1, 2]) expect(existsSync(join(root, '.cf/work', String(id), 'ask.md'))).toBe(true)
})

test('D2: the same list again adds no row, views no issue and leaves each ask alone', () => {
  const db = piped()
  intake(db, root, canned(TWO))
  const ask = join(root, '.cf/work/1/ask.md')
  writeFileSync(ask, 'edited')
  const log: string[] = []
  intake(db, root, canned(TWO, log))
  expect(db.prepare('SELECT count(*) AS n FROM plans').get()).toEqual({ n: 2 })
  expect(log.filter((l) => l.startsWith('issue view'))).toEqual([])
  expect(readFileSync(ask, 'utf8')).toBe('edited')
})

test('D3: a queued plan whose issue left the list is halted, and a running or blocked one keeps its state', () => {
  const db = piped()
  queue(db, 50)
  queue(db, 51, 'running')
  queue(db, 52, 'blocked_on_ceo')
  intake(db, root, canned([{ number: 50, labels: ['bug'] }]))
  expect(states(db)).toEqual([
    { origin: url(50), state: 'halted' },
    { origin: url(51), state: 'running' },
    { origin: url(52), state: 'blocked_on_ceo' },
  ])
})

test('D4: an issue a part of a split names is not adopted', () => {
  const db = piped()
  queue(db, 30, 'done')
  db.prepare("INSERT INTO parts (parent, n, url, title, body) VALUES (1, 0, ?, 'part', 'the part')").run(url(40))
  intake(db, root, canned(TWO))
  expect(states(db)).toEqual([{ origin: url(30), state: 'done' }, { origin: url(41), state: 'queued' }])
})

test('D4: a lane whose pipe is off or missing has its home left unlisted', () => {
  for (const db of [piped(0), fresh(schema)]) {
    const log: string[] = []
    intake(db, root, canned(TWO, log))
    expect(log).toEqual([])
    expect(db.prepare('SELECT count(*) AS n FROM plans').get()).toEqual({ n: 0 })
  }
})

test('D4: a read that throws halts no plan', () => {
  const db = piped()
  queue(db, 50)
  intake(db, root, () => { throw new Error('gh is down') })
  expect(states(db)).toEqual([{ origin: url(50), state: 'queued' }])
})

test('D4: a list exactly WINDOW long halts no plan', () => {
  const db = piped()
  queue(db, 50)
  const full = [...Array(WINDOW).keys()].map((i) => ({ number: 1000 + i, labels: ['bug'] }))
  intake(db, root, canned(full))
  expect(states(db)).toEqual([{ origin: url(50), state: 'queued' }])
})

test('D5: the tick lists issues only when handed a reader', async () => {
  const db = piped()
  await tick(db, root, stub(CARRIED))
  expect(db.prepare('SELECT count(*) AS n FROM plans').get()).toEqual({ n: 0 })
  const log: string[] = []
  await tick(db, root, stub(CARRIED), undefined, undefined, undefined, 0, (args) => {
    log.push(args.join(' '))
    throw new Error('gh is down')
  })
  expect(log).toEqual([`issue list --repo ${REPO} --state open --limit ${String(WINDOW)} --json number,title,body,url,labels`])
})

test('#260: an issue with sub-issues is a parent and is not adopted; its parts are', () => {
  const db = piped()
  intake(db, root, canned([{ number: 85, labels: ['lane:machine'], parts: 3 }, { number: 121, labels: ['lane:machine'] }]))
  expect(states(db)).toEqual([{ origin: url(121), state: 'queued' }])
})

test('#260: a parent split by hand, named only by its parts\' titles, is not adopted', () => {
  const db = piped()
  intake(db, root, canned([{ number: 85, labels: ['lane:machine'] },
    { number: 121, labels: ['lane:machine'], title: '85a: each changed declaration whole' }]))
  expect(states(db)).toEqual([{ origin: url(121), state: 'queued' }])
})

test('D3: a part\'s own parts filed by the COO join that part\'s plan, part a queued, and neither is its own plan', () => {
  const db = piped()
  queue(db, 200, 'done')
  queue(db, 223, 'blocked_on_ceo')
  db.prepare("INSERT INTO parts (parent, n, url, title, body, plan) VALUES (1, 0, ?, 'part', 'the part', 2)").run(url(223))
  intake(db, root, canned([{ number: 280, labels: ['lane:machine'], title: '223a: first' },
    { number: 281, labels: ['lane:machine'], title: '223b: second' }]))
  expect(db.prepare('SELECT n, url, plan FROM parts WHERE parent = 2 ORDER BY n').all()).toEqual([
    { n: 0, url: url(280), plan: 3 },
    { n: 1, url: url(281), plan: null },
  ])
  expect(states(db)).toEqual([
    { origin: url(200), state: 'done' },
    { origin: url(223), state: 'blocked_on_ceo' },
    { origin: url(280), state: 'queued' },
  ])
  expect(readFileSync(join(root, '.cf/work/3/ask.md'), 'utf8')).toBe('# 223a: first\n\nthe ask')
})

const FIVE: Fixture[] = [
  { number: 40, labels: ['lane:machine', 'P2'] },
  { number: 121, labels: ['lane:machine', 'P1'], title: '85a: each changed declaration whole', body: 'After: #120' },
  { number: 85, labels: ['lane:machine', 'P1'], parts: 3 },
  { number: 70, labels: ['lane:machine'] },
]

function ticket(db: Db, n: number): void {
  db.prepare("INSERT INTO tickets (repo, number, title, lane) VALUES (?, ?, 'earlier', 'machine')").run(REPO, n)
}

const tickets = (db: Db): unknown[] => db.prepare('SELECT number, title, lane, priority, after, parent FROM tickets ORDER BY number').all()

const RECORDED = [
  { number: 40, title: 'issue 40', lane: 'machine', priority: 2, after: null, parent: null },
  { number: 70, title: 'issue 70', lane: 'machine', priority: null, after: null, parent: null },
  { number: 85, title: 'issue 85', lane: 'machine', priority: 1, after: null, parent: null },
  { number: 121, title: '85a: each changed declaration whole', lane: 'machine', priority: 1, after: 120, parent: 85 },
]

function five(): Db {
  const db = piped()
  queue(db, 40)
  ticket(db, 60)
  intake(db, root, canned(FIVE))
  return db
}

test('D1: every open lane issue listed is a ticket, and one closed since the last listing is gone', () => {
  expect(tickets(five())).toEqual(RECORDED)
})

test('D2: a listed issue that lost its lane label loses its ticket, even from a list WINDOW long', () => {
  const db = piped()
  ticket(db, 50)
  intake(db, root, canned([...Array(WINDOW).keys()].map((i) => ({ number: 50 + i, labels: ['bug'] }))))
  expect(tickets(db)).toEqual([])
})

test('D3: a list exactly WINDOW long drops no ticket for an issue missing from it', () => {
  const db = piped()
  ticket(db, 50)
  intake(db, root, canned([...Array(WINDOW).keys()].map((i) => ({ number: 1000 + i, labels: i === 0 ? ['lane:machine'] : ['bug'] }))))
  expect(db.prepare('SELECT number FROM tickets ORDER BY number').all()).toEqual([{ number: 50 }, { number: 1000 }])
})

test('D4: an issue with two P labels is recorded unpriced and the rest of its repo is still queued', () => {
  const db = piped()
  intake(db, root, canned([{ number: 40, labels: ['lane:machine', 'P1', 'P2'] }, { number: 41, labels: ['lane:machine'] }]))
  expect(db.prepare('SELECT number, priority FROM tickets ORDER BY number').all()).toEqual([
    { number: 40, priority: null },
    { number: 41, priority: null },
  ])
  expect(states(db)).toEqual([{ origin: url(41), state: 'queued' }])
})

test('D5: recording the tickets queues only what add made', () => {
  const db = five()
  expect(states(db)).toEqual([
    { origin: url(40), state: 'queued' },
    { origin: url(121), state: 'queued' },
    { origin: url(70), state: 'queued' },
  ])
  expect(db.prepare('SELECT count(*) AS n FROM parts').get()).toEqual({ n: 0 })
})

test('D6: the same listing again leaves the same tickets', () => {
  const db = five()
  intake(db, root, canned(FIVE))
  expect(tickets(db)).toEqual(RECORDED)
})

function waiting(): Db {
  const db = piped()
  queue(db, 30, 'done')
  db.prepare("INSERT INTO parts (parent, n, url, title, body) VALUES (1, 0, ?, '30a: first', 'the part')").run(url(53))
  db.prepare("INSERT INTO parts (parent, n, url, title, body) VALUES (1, 1, ?, '30b: second', 'After: #53')").run(url(54))
  return db
}

const B: Fixture = { number: 54, labels: ['lane:machine'], title: '30b: second', body: 'After: #53' }

const unblocked = (db: Db): unknown[] => db.prepare("SELECT plan, message FROM events WHERE kind = 'unblocked'").all()

const waits = (db: Db): unknown => db.prepare('SELECT plan FROM parts WHERE n = 1').get()

test('D1: a part whose After: issue closed off the machine is queued as its parent\'s, with its ask, and says so', () => {
  const db = waiting()
  intake(db, root, canned([B]))
  const kin = 'SELECT pipe_id, lane, seat, priority FROM plans WHERE id = ?'
  expect(db.prepare(kin).get(2)).toEqual(db.prepare(kin).get(1))
  expect(states(db)).toEqual([{ origin: url(30), state: 'done' }, { origin: url(54), state: 'queued' }])
  expect(waits(db)).toEqual({ plan: 2 })
  expect(readFileSync(join(root, '.cf/work/2/ask.md'), 'utf8')).toBe('# 30b: second\n\nAfter: #53')
  expect(unblocked(db)).toEqual([{ plan: 2, message: '#53 closed' }])
})

test('D2: a part whose After: issue is still open, lane-labelled or not, is not queued', () => {
  for (const labels of [['lane:machine'], ['bug']]) {
    const db = waiting()
    intake(db, root, canned([{ number: 53, labels, title: '30a: first' }, B]))
    expect(waits(db)).toEqual({ plan: null })
    expect(states(db)).toEqual([{ origin: url(30), state: 'done' }])
  }
})

test('D3: the same listing again makes no second plan and no second unblocked event', () => {
  const db = waiting()
  intake(db, root, canned([B]))
  intake(db, root, canned([B]))
  expect(db.prepare('SELECT count(*) AS n FROM plans WHERE origin = ?').get(url(54))).toEqual({ n: 1 })
  expect(unblocked(db)).toHaveLength(1)
})

test('D4: a list exactly WINDOW long queues no part', () => {
  const db = waiting()
  intake(db, root, canned([B, ...[...Array(WINDOW - 1).keys()].map((i) => ({ number: 1000 + i, labels: ['bug'] }))]))
  expect(waits(db)).toEqual({ plan: null })
})

test('#257: a running or blocked plan whose work was pushed and whose issue closed is done', () => {
  const db = piped()
  queue(db, 60, 'blocked_on_ceo')
  queue(db, 61, 'running')
  queue(db, 62, 'blocked_on_ceo')
  db.prepare(`INSERT INTO rules (id, kind, path, content_hash, loaded_at)
    VALUES ('typescript_specialist', 'roster', 'seats/typescript_specialist', ?, '2026-09-25')`).run('0'.repeat(64))
  for (const plan of [1, 2]) {
    const approval = db.prepare(`INSERT INTO approvals (subject_kind, subject_id, subject_digest, who, decision, approved_at)
      VALUES ('plan', ?, ?, 'gates', 'approved', '2026-09-25T00:00:00.000Z') RETURNING id`).get(plan, 'd'.repeat(64)) as { id: number }
    db.prepare(`INSERT INTO deliverables (plan_id, step, seat, diff_digest, state, tests_pass, byte_identical_elsewhere,
      fork_ci_green, bot_clean, target_warm, approval_id, evidence)
      VALUES (?, 7, 'typescript_specialist', ?, 'pushed', 1, 1, 1, 1, 1, ?, 'https://github.com/caliperforge/caliperforge/commit/abc')`)
      .run(plan, 'd'.repeat(64), approval.id)
  }
  intake(db, root, canned([]))
  expect(states(db)).toEqual([
    { origin: url(60), state: 'done' },
    { origin: url(61), state: 'done' },
    { origin: url(62), state: 'blocked_on_ceo' },
  ])
})
