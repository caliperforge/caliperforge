import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Read } from '../gh.ts'
import { doneIds } from '../../sequencer/workspace.ts'
import { add, laneOf, parse, priorityOf, seatOf, unfiled } from '../plan.ts'
import type { Db } from '../../store/index.ts'

const schema = join(import.meta.dirname, '../../schema')

const URL = 'https://github.com/caliperforge/caliperforge/issues/25'

interface Fixture { number: number; title: string; body: string; url: string; labels: string[] }

const ISSUE: Fixture = {
  number: 25,
  title: 'An issue is a ticket only once something queues it',
  body: 'cf plan add --issue files the row.',
  url: URL,
  labels: ['lane:machine'],
}

/** The two `gh` shapes the plan verb parses; no test is allowed past this function. */
function canned(rows: Fixture[], log: string[] = []): Read {
  return (args) => {
    log.push(args.join(' '))
    if (args[0] === 'search') {
      return rows.map((r) => ({ number: r.number, title: r.title, url: r.url,
        repository: { nameWithOwner: 'caliperforge/caliperforge' }, labels: r.labels.map((name) => ({ name })) }))
    }
    const hit = rows.find((r) => String(r.number) === args[2])
    if (hit === undefined) throw new Error(`no fixture for ${args.join(' ')}`)
    return { ...hit, labels: hit.labels.map((name) => ({ name })) }
  }
}

function piped(): Db {
  const db = fresh(schema)
  db.prepare("INSERT INTO pipes (name, enabled, window_start, window_end, max_concurrent) VALUES ('internal', 1, '00:00', '23:59', 1)").run()
  return db
}

/** `cf plan add` writes into `.cf/work/<plan>/`, so every test files against a root of its own. */
let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cf-plan-')) })

test('a labelled issue files one queued plan row on its lane, seat, and origin', () => {
  const db = piped()
  const filed = add(db, root, 'caliperforge/caliperforge#25', 'internal', canned([ISSUE]))
  expect(filed).toMatchObject({ state: 'queued', lane: 'machine', seat: 'typescript_specialist', origin: null })
  expect(db.prepare('SELECT lane, seat, origin, template, state, priority FROM plans WHERE id = ?').get(filed.plan))
    .toEqual({ lane: 'machine', seat: 'typescript_specialist', origin: URL, template: 'pr_path', state: 'queued', priority: 1 })
})

test('a seat label wins over the lane template, and each lane files on its own template', () => {
  const db = piped()
  const rows = [
    { ...ISSUE, number: 30, url: `${URL.slice(0, -2)}30`, labels: ['lane:comms', 'seat:kotlin_specialist'] },
    { ...ISSUE, number: 31, url: `${URL.slice(0, -2)}31`, labels: ['lane:research'] },
  ]
  expect(add(db, root, 'caliperforge/caliperforge#30', 'internal', canned(rows)))
    .toMatchObject({ lane: 'comms', seat: 'kotlin_specialist' })
  expect(add(db, root, 'caliperforge/caliperforge#31', 'internal', canned(rows))).toMatchObject({ lane: 'research' })
  expect(db.prepare('SELECT template FROM plans ORDER BY id').all())
    .toEqual([{ template: 'comms' }, { template: 'research' }])
})

test('an issue with no lane label is refused, naming every label that would settle it, with a ruling', () => {
  const db = piped()
  const filed = add(db, root, 'caliperforge/caliperforge#25', 'internal', canned([{ ...ISSUE, labels: ['bug'] }]))
  expect(filed.state).toBe('refused')
  expect(filed.plan).toBeNull()
  expect(filed.why).toContain('lane:machine, lane:atelier, lane:comms, lane:research')
  expect(filed.origin).toEqual({ origin_kind: 'ruling', origin_ref: 'plan.lane_label' })
  expect(db.prepare('SELECT subject FROM rulings WHERE id = ?').get(filed.ruling)).toEqual({ subject: 'plan.lane_label' })
  expect(db.prepare('SELECT count(*) AS n FROM plans').get()).toEqual({ n: 0 })
  expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 0 })
})

test('the P label on the issue is the priority it files at, and two of them file nothing', () => {
  const db = piped()
  const rows = [{ ...ISSUE, labels: ['lane:machine', 'P2'] },
    { ...ISSUE, number: 26, url: `${URL.slice(0, -2)}26`, labels: ['lane:machine', 'P0', 'P2'] }]
  const filed = add(db, root, 'caliperforge/caliperforge#25', 'internal', canned(rows))
  expect(db.prepare('SELECT priority FROM plans WHERE id = ?').get(filed.plan)).toEqual({ priority: 2 })

  const refused = add(db, root, 'caliperforge/caliperforge#26', 'internal', canned(rows))
  expect(refused).toMatchObject({ plan: null, state: 'refused',
    origin: { origin_kind: 'ruling', origin_ref: 'plan.priority_label' } })
  expect(refused.why).toContain('P0 and P2')
  expect(db.prepare('SELECT subject FROM rulings WHERE id = ?').get(refused.ruling))
    .toEqual({ subject: 'plan.priority_label' })
  expect(db.prepare('SELECT count(*) AS n FROM plans').get()).toEqual({ n: 1 })
})

test('the same issue twice is one row, and the second call returns the first plan', () => {
  const db = piped()
  const first = add(db, root, 'caliperforge/caliperforge#25', 'internal', canned([ISSUE]))
  const again = add(db, root, 'caliperforge/caliperforge#25', 'internal', canned([ISSUE]))
  expect(again.plan).toBe(first.plan)
  expect(db.prepare('SELECT count(*) AS n FROM plans WHERE origin = ?').get(URL)).toEqual({ n: 1 })
  expect(db.prepare('SELECT plan, kind, actor, outcome, message FROM events').all())
    .toEqual([{ plan: first.plan, kind: 'filed', actor: 'cf plan add', outcome: 'pass', message: URL }])
})

test('the schema, not the code, is what holds one plan per issue', () => {
  const db = piped()
  add(db, root, 'caliperforge/caliperforge#25', 'internal', canned([ISSUE]))
  expect(() => db.prepare(`INSERT INTO plans (pipe_id, template, state, queued_at, lane, seat, origin)
    VALUES (1, 'pr_path', 'queued', '2026-09-18', 'machine', 'typescript_specialist', ?)`).run(URL)).toThrow()
})

test('cf plans --unfiled lists the open issues no plan row names, and drops the one it does', () => {
  const db = piped()
  const rows = [ISSUE, { ...ISSUE, number: 26, url: `${URL.slice(0, -2)}26`, labels: [] }]
  const log: string[] = []
  expect(unfiled(db, canned(rows, log))).toHaveLength(2)
  add(db, root, 'caliperforge/caliperforge#25', 'internal', canned(rows))
  expect(unfiled(db, canned(rows))).toEqual([
    { repo: 'caliperforge/caliperforge', no: 26, title: ISSUE.title, url: `${URL.slice(0, -2)}26`, lane: null },
  ])
  expect(log[0]).toContain('search issues --owner caliperforge --state open')
})

test('the filed plan carries the raw issue on disk as the ask step 1 briefs from', () => {
  const db = piped()
  const carried = { ...ISSUE, body: 'What: run our own plan.\n\n- **D1** steps 0 and 1 pass\n- **D2** ask.md is written\n' }
  const filed = add(db, root, 'caliperforge/caliperforge#25', 'internal', canned([carried]))
  const body = readFileSync(join(root, '.cf/work', String(filed.plan), 'ask.md'), 'utf8')
  expect(body).toBe(`# ${carried.title}\n\n${carried.body}\n`)
  expect(doneIds(body)).toEqual(['D1', 'D2'])
})

test('the reference, the lane label, the seat label and the priority label are read off exactly', () => {
  expect(parse('caliperforge/caliperforge#25')).toEqual({ repo: 'caliperforge/caliperforge', no: 25 })
  expect(() => parse('caliperforge#25')).toThrow('is not an <owner/repo>#<n> issue reference')
  expect(laneOf([{ name: 'lane:atelier' }])).toBe('atelier')
  expect(laneOf([{ name: 'lane:kitchen' }, { name: 'lanes' }])).toBeNull()
  expect(seatOf([{ name: 'seat:kotlin_specialist' }])).toBe('kotlin_specialist')
  expect(seatOf([{ name: 'bug' }])).toBeNull()
  expect(priorityOf([{ name: 'P2' }])).toBe(2)
  expect(priorityOf([{ name: 'bug' }, { name: 'P10' }, { name: 'p2' }])).toBeNull()
  expect(() => priorityOf([{ name: 'P0' }, { name: 'P2' }])).toThrow('P0 and P2')
})
