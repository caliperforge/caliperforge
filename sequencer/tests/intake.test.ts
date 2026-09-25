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

interface Fixture { number: number; labels: string[] }

const TWO: Fixture[] = [{ number: 40, labels: ['lane:machine'] }, { number: 41, labels: ['lane:machine', 'P2'] }]

function canned(rows: Fixture[], log: string[] = []): Read {
  return (args) => {
    log.push(args.join(' '))
    const shaped = rows.map((r) => ({ number: r.number, title: `issue ${String(r.number)}`, body: 'the ask',
      url: url(r.number), labels: r.labels.map((name) => ({ name })) }))
    if (args[1] === 'list') return shaped
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
  expect(log).toEqual([`issue list --repo ${REPO} --state open --limit ${String(WINDOW)} --json number,title,url,labels`])
})
