import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Read } from '../../cli/gh.ts'
import { ofKind } from '../../store/events.ts'
import type { Db } from '../../store/index.ts'
import { set } from '../../store/lanes.ts'
import { addPipe, addPlan, allPlans } from '../../store/plans.ts'
import { refill } from '../capture.ts'

const schema = join(import.meta.dirname, '../../schema')

const REPO = 'caliperforge/caliperforge'

interface Fixture { number: number; labels: string[]; repo?: string }

const url = (r: Fixture): string => `https://github.com/${r.repo ?? REPO}/issues/${String(r.number)}`

const NOON = new Date('2026-10-04T18:00:00Z')

const NINE = new Date('2026-10-05T03:30:00Z')

function canned(rows: Fixture[], log: string[] = []): Read {
  return (args) => {
    log.push(args.join(' '))
    const labels = (r: Fixture) => r.labels.map((name) => ({ name }))
    if (args[0] === 'search') {
      return rows.map((r) => ({ number: r.number, title: 'ask', url: url(r), repository: { nameWithOwner: r.repo ?? REPO }, labels: labels(r) }))
    }
    const hit = rows.find((r) => String(r.number) === args[2] && (r.repo ?? REPO) === args[4])
    if (hit === undefined) throw new Error(`no fixture for ${args.join(' ')}`)
    return { number: hit.number, title: 'ask', body: 'the ask', url: url(hit), labels: labels(hit) }
  }
}

function dialled(dial: number, queued: number): Db {
  const db = fresh(schema)
  set(db, 'lanes.dial', String(dial), 'ceo', '2026-10-04')
  addPipe(db, { name: 'internal', enabled: 1, window_start: '00:00', window_end: '23:59', max_concurrent: 1 })
  for (let n = 0; n < queued; n += 1) {
    addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-10-04', lane: 'machine',
      seat: 'typescript_specialist', origin: url({ number: 900 + n, labels: [] }), step: 0 })
  }
  return db
}

const refills = (db: Db): unknown[] => ofKind(db, 'refill')

let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cf-refill-')) })

test('D1: below the dial every unfiled lane issue is filed by tick', () => {
  const db = dialled(2, 1)
  expect(refill(db, root, canned([{ number: 40, labels: ['lane:machine'] }, { number: 41, labels: ['lane:machine'] }]), NOON)).toEqual([])
  expect(allPlans(db).slice(1).map((p) => p.origin)).toEqual([url({ number: 40, labels: [] }), url({ number: 41, labels: [] })])
  expect(ofKind(db, 'filed').map((e) => e.actor)).toEqual(['tick', 'tick'])
  expect(refills(db)).toEqual([{ plan: null, kind: 'refill', actor: 'tick', outcome: 'pass', message: '2' }])
})

test('D2: at the dial before 21:00 nothing is read or logged', () => {
  const db = dialled(1, 1)
  const log: string[] = []
  expect(refill(db, root, canned([{ number: 40, labels: ['lane:machine'] }], log), NOON)).toEqual([])
  expect(log).toEqual([])
  expect(refills(db)).toEqual([])
  expect(allPlans(db).length).toBe(1)
})

test('D3: at the dial the evening refill runs once a night', () => {
  const db = dialled(1, 1)
  const read = canned([])
  refill(db, root, read, NINE)
  refill(db, root, read, new Date('2026-10-05T05:00:00Z'))
  expect(refills(db)).toHaveLength(1)
  refill(db, root, read, new Date('2026-10-06T03:10:00Z'))
  expect(refills(db)).toHaveLength(2)
})

test('D4: no lane is skipped and a refusal is not counted', () => {
  const db = dialled(2, 0)
  const log: string[] = []
  refill(db, root, canned([{ number: 40, labels: ['bug'] }, { number: 41, labels: ['lane:machine'], repo: 'caliperforge/other' },
    { number: 42, labels: ['lane:machine'] }], log), NOON)
  expect(log.filter((l) => l.startsWith('issue view'))).toEqual([
    'issue view 41 --repo caliperforge/other --json number,title,body,url,labels',
    `issue view 42 --repo ${REPO} --json number,title,body,url,labels`,
  ])
  expect(allPlans(db).map((p) => p.origin)).toEqual([url({ number: 42, labels: [] })])
  expect(ofKind(db, 'refill').map((e) => e.message)).toEqual(['1'])
})

test('D4: a throwing read becomes a line and logs no refill', () => {
  const db = dialled(2, 0)
  expect(refill(db, root, () => { throw new Error('gh is down\nmore') }, NOON)).toEqual(['refill: gh is down'])
  expect(refills(db)).toEqual([])
})

test('D4: a throwing add names its issue and the loop goes on', () => {
  const db = dialled(2, 0)
  const read = canned([{ number: 40, labels: ['lane:machine'] }, { number: 41, labels: ['lane:machine'] }])
  const lines = refill(db, root, (args) => {
    if (args[2] === '40') throw new Error('HTTP 502')
    return read(args)
  }, NOON)
  expect(lines).toEqual([`${REPO}#40: HTTP 502`])
  expect(ofKind(db, 'refill').map((e) => e.message)).toEqual(['1'])
})
