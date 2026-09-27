import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { tickNote } from '../../cli/brief.ts'
import { WINDOW, type Read } from '../../cli/gh.ts'
import { gates } from '../../store/approvals.ts'
import { pushedRow } from '../../store/deliverables.ts'
import { ofKind } from '../../store/events.ts'
import { addRule, type Db } from '../../store/index.ts'
import { addPart, allParts } from '../../store/parts.ts'
import { addPipe, addPlan, allPlans, type PlanRow } from '../../store/plans.ts'
import { allTickets, recordListing } from '../../store/tickets.ts'
import { intake } from '../capture.ts'
import { tick } from '../index.ts'
import { CARRIED, stub } from './world.ts'

const schema = join(import.meta.dirname, '../../schema')

const REPO = 'caliperforge/caliperforge'

const url = (n: number): string => `https://github.com/${REPO}/issues/${String(n)}`

interface Fixture { number: number; labels: string[]; parts?: number; title?: string; body?: string; createdAt?: string; closedAt?: string }

const TWO: Fixture[] = [{ number: 40, labels: ['lane:machine'] }, { number: 41, labels: ['lane:machine', 'P2'] }]

const OPENED = '2026-09-20T09:00:00Z'

const shape = (r: Fixture) => ({ number: r.number, title: r.title ?? `issue ${String(r.number)}`, body: r.body ?? 'the ask',
  url: url(r.number), labels: r.labels.map((name) => ({ name })), createdAt: r.createdAt ?? OPENED, closedAt: r.closedAt ?? null })

function canned(rows: Fixture[], log: string[] = [], closed: Fixture[] = []): Read {
  return (args) => {
    log.push(args.join(' '))
    const shaped = rows.map(shape)
    if (args[1] === 'list') return args[5] === 'closed' ? closed.map(shape) : shaped
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
  addPipe(db, { name: 'internal', enabled, window_start: '00:00', window_end: '23:59', max_concurrent: 1 })
  return db
}

function queue(db: Db, n: number, state: PlanRow['state'] = 'queued', step = 0): void {
  addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state, queued_at: '2026-09-18', lane: 'machine', seat: 'typescript_specialist', origin: url(n), step })
}

const states = (db: Db): unknown[] => allPlans(db).map((p) => ({ origin: p.origin, state: p.state }))

let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cf-intake-')) })

test('D1: each open lane issue on a switched-on lane home becomes a queued plan with its ask written', () => {
  const db = piped()
  intake(db, root, canned(TWO))
  expect(allPlans(db).map((p) => ({ id: p.id, origin: p.origin, state: p.state, priority: p.priority }))).toEqual([
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
  expect(allPlans(db).length).toBe(2)
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
  addPart(db, { parent: 1, n: 0, url: url(40), title: 'part', body: 'the part' })
  intake(db, root, canned(TWO))
  expect(states(db)).toEqual([{ origin: url(30), state: 'done' }, { origin: url(41), state: 'queued' }])
})

test('D4: a lane whose pipe is off or missing has its home left unlisted', () => {
  for (const db of [piped(0), fresh(schema)]) {
    const log: string[] = []
    intake(db, root, canned(TWO, log))
    expect(log).toEqual([])
    expect(allPlans(db).length).toBe(0)
  }
})

test('D4: a read that throws halts no plan and names the repo', () => {
  const db = piped()
  queue(db, 50)
  expect(intake(db, root, () => { throw new Error('gh is down') })).toEqual([`${REPO}: gh is down`])
  expect(states(db)).toEqual([{ origin: url(50), state: 'queued' }])
})

test('a parent read that throws skips that issue alone, names it, and makes no ticket its part', () => {
  const db = piped()
  const read = canned(TWO)
  const lines = intake(db, root, (args) => {
    if (args[1] === `repos/${REPO}/issues/40`) throw new Error('HTTP 502\nbody')
    return read(args)
  })
  expect(lines).toEqual([`${REPO}#40: HTTP 502`])
  expect(states(db)).toEqual([{ origin: url(41), state: 'queued' }])
  expect(allTickets(db).filter((t) => t.parent === 40)).toEqual([])
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
  expect(allPlans(db).length).toBe(0)
  const log: string[] = []
  await tick(db, root, stub(CARRIED), undefined, undefined, undefined, 0, (args) => {
    log.push(args.join(' '))
    throw new Error('gh is down')
  })
  expect(log).toEqual([`issue list --repo ${REPO} --state open --limit ${String(WINDOW)} --json number,title,body,url,labels,createdAt,closedAt`])
  const sink: string[] = []
  await tick(db, root, stub(CARRIED), undefined, undefined, undefined, 0, () => { throw new Error('gh is down') }, undefined, undefined, sink)
  expect(tickNote([], [], sink)).toContain(`${REPO}: gh is down`)
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
  addPart(db, { parent: 1, n: 0, url: url(223), title: 'part', body: 'the part', plan: 2 })
  intake(db, root, canned([{ number: 280, labels: ['lane:machine'], title: '223a: first' },
    { number: 281, labels: ['lane:machine'], title: '223b: second' }]))
  expect(allParts(db).filter((p) => p.parent === 2).map((p) => ({ n: p.n, url: p.url, plan: p.plan }))).toEqual([
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
  recordListing(db, REPO, [shape({ number: n, labels: ['lane:machine'], title: 'earlier' })], false)
}

const tickets = (db: Db): unknown[] => allTickets(db).map((t) =>
  ({ number: t.number, title: t.title, lane: t.lane, priority: t.priority, after: t.after, parent: t.parent }))

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
  expect(allTickets(db).map((t) => ({ number: t.number }))).toEqual([{ number: 50 }, { number: 1000 }])
})

test('D4: an issue with two P labels is recorded unpriced and the rest of its repo is still queued', () => {
  const db = piped()
  intake(db, root, canned([{ number: 40, labels: ['lane:machine', 'P1', 'P2'] }, { number: 41, labels: ['lane:machine'] }]))
  expect(allTickets(db).map((t) => ({ number: t.number, priority: t.priority }))).toEqual([
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
  expect(allParts(db).length).toBe(0)
})

test('D6: the same listing again leaves the same tickets', () => {
  const db = five()
  intake(db, root, canned(FIVE))
  expect(tickets(db)).toEqual(RECORDED)
})

function waiting(): Db {
  const db = piped()
  queue(db, 30, 'done')
  addPart(db, { parent: 1, n: 0, url: url(53), title: '30a: first', body: 'the part' })
  addPart(db, { parent: 1, n: 1, url: url(54), title: '30b: second', body: 'After: #53' })
  return db
}

const B: Fixture = { number: 54, labels: ['lane:machine'], title: '30b: second', body: 'After: #53' }

const unblocked = (db: Db): unknown[] => ofKind(db, 'unblocked').map(({ plan, message }) => ({ plan, message }))

const waits = (db: Db): unknown => ({ plan: allParts(db).find((p) => p.n === 1)?.plan })

test('D1: a part whose After: issue closed off the machine is queued as its parent\'s, with its ask, and says so', () => {
  const db = waiting()
  intake(db, root, canned([B]))
  const kin = allPlans(db).map((p) => ({ pipe_id: p.pipe_id, lane: p.lane, seat: p.seat, priority: p.priority }))
  expect(kin[1]).toEqual(kin[0])
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
  expect(allPlans(db).filter((p) => p.origin === url(54)).length).toBe(1)
  expect(unblocked(db)).toHaveLength(1)
})

test('D4: a list exactly WINDOW long queues no part', () => {
  const db = waiting()
  intake(db, root, canned([B, ...[...Array(WINDOW - 1).keys()].map((i) => ({ number: 1000 + i, labels: ['bug'] }))]))
  expect(waits(db)).toEqual({ plan: null })
})

const A: Fixture = { number: 300, labels: ['lane:machine'] }

const HAND: Fixture = { number: 301, labels: ['lane:machine'], body: 'After: #300' }

test('D1: a hand-filed ticket whose After: issue is open gets no plan and its ticket records the wait', () => {
  const db = piped()
  intake(db, root, canned([A, HAND]))
  expect(states(db)).toEqual([{ origin: url(300), state: 'queued' }])
  expect(allTickets(db).find((t) => t.number === 301)).toMatchObject({ after: 300 })
})

test('D2: once its After: issue leaves the list, the held ticket is queued with its ask', () => {
  const db = piped()
  intake(db, root, canned([A, HAND]))
  intake(db, root, canned([HAND]))
  expect(states(db)).toEqual([{ origin: url(300), state: 'halted' }, { origin: url(301), state: 'queued' }])
  expect(existsSync(join(root, '.cf/work/2/ask.md'))).toBe(true)
})

test('D3: an After: issue missing from a whole list holds nothing', () => {
  const db = piped()
  intake(db, root, canned([HAND]))
  expect(states(db)).toEqual([{ origin: url(301), state: 'queued' }])
})

test('D4: a list exactly WINDOW long holds a ticket whose After: issue is missing from it', () => {
  const db = piped()
  intake(db, root, canned([HAND, ...[...Array(WINDOW - 1).keys()].map((i) => ({ number: 1000 + i, labels: ['bug'] }))]))
  expect(states(db)).toEqual([])
})

test('D5: a held ticket listed again still gets no plan', () => {
  const db = piped()
  intake(db, root, canned([A, HAND]))
  intake(db, root, canned([A, HAND]))
  expect(states(db)).toEqual([{ origin: url(300), state: 'queued' }])
})

function pushed(db: Db, plans: number[]): void {
  addRule(db, { id: 'typescript_specialist', kind: 'roster', path: 'seats/typescript_specialist', content_hash: '0'.repeat(64), loaded_at: '2026-09-25' })
  for (const plan of plans) {
    pushedRow(db, { plan, step: 7, seat: 'typescript_specialist', diff_digest: 'd'.repeat(64),
      evidence: 'https://github.com/caliperforge/caliperforge/commit/abc' }, gates(db, plan, 'd'.repeat(64)))
  }
}

test('#257: a running or blocked plan whose work was pushed and whose issue closed is done', () => {
  const db = piped()
  queue(db, 60, 'blocked_on_ceo')
  queue(db, 61, 'running')
  queue(db, 62, 'blocked_on_ceo')
  pushed(db, [1, 2])
  intake(db, root, canned([]))
  expect(states(db)).toEqual([
    { origin: url(60), state: 'done' },
    { origin: url(61), state: 'done' },
    { origin: url(62), state: 'blocked_on_ceo' },
  ])
})

const SHUT = '2026-09-25T10:00:00Z'

const CLOSED: Fixture = { number: 90, labels: ['lane:machine'], createdAt: '2026-09-25T09:00:00Z', closedAt: SHUT }

test('D1: an issue opened and closed between ticks has both times, and a ticket that closed keeps its row', () => {
  const db = piped()
  intake(db, root, canned([{ number: 60, labels: ['lane:machine'] }]))
  intake(db, root, canned([], [], [CLOSED, { number: 60, labels: ['lane:machine'], closedAt: SHUT }]))
  expect(allTickets(db).map((t) => ({ number: t.number, opened_at: t.opened_at, closed_at: t.closed_at }))).toEqual([
    { number: 60, opened_at: OPENED, closed_at: SHUT },
    { number: 90, opened_at: '2026-09-25T09:00:00Z', closed_at: SHUT },
  ])
})

test('D2: one tick records kind fix for a fix-labelled issue and build for one without', () => {
  const db = piped()
  intake(db, root, canned([{ number: 40, labels: ['lane:machine', 'fix'] }], [], [{ ...CLOSED, number: 41 }]))
  expect(allTickets(db).map((t) => ({ number: t.number, kind: t.kind }))).toEqual([
    { number: 40, kind: 'fix' },
    { number: 41, kind: 'build' },
  ])
})

test('D3: an issue only in the closed listing is not queued, holds and releases nothing, and is not open', () => {
  const db = waiting()
  queue(db, 300)
  intake(db, root, canned([HAND], [], [{ ...A, closedAt: SHUT }, { ...B, closedAt: SHUT }, CLOSED]))
  expect(waits(db)).toEqual({ plan: null })
  expect(states(db)).toEqual([
    { origin: url(30), state: 'done' },
    { origin: url(300), state: 'halted' },
    { origin: url(301), state: 'queued' },
  ])
})

test('D1-D3: a queued plan at step 8 whose issue closed is done if pushed, halted if not, and queued while its issue is open', () => {
  const db = piped()
  queue(db, 70, 'queued', 8)
  queue(db, 71, 'queued', 8)
  queue(db, 72, 'queued', 8)
  pushed(db, [1, 3])
  intake(db, root, canned([{ number: 72, labels: ['lane:machine'] }]))
  expect(states(db)).toEqual([
    { origin: url(70), state: 'done' },
    { origin: url(71), state: 'halted' },
    { origin: url(72), state: 'queued' },
  ])
})
