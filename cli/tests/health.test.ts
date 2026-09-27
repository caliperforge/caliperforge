import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh, rejects } from '../../checks/sqlite.ts'
import type { Db } from '../../store/index.ts'
import { counted } from '../../store/health.ts'
import { health } from '../health.ts'

const schema = join(import.meta.dirname, '../../schema')

const TODAY = '2026-09-26'

const WEEK_AGO = '2026-09-19'

function bench(): { db: Db; tree: string } {
  const db = fresh(schema)
  db.exec(`INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin)
    VALUES (1, 1, 'pr_path', 'running', '2026-09-21T00:00:00.000Z', 'machine', 'typescript_specialist',
      'https://github.com/caliperforge/caliperforge/issues/76')`)
  const tree = mkdtempSync(join(tmpdir(), 'health-'))
  writeFileSync(join(tree, 'a.ts'), 'export const a = 1\nexport const b = 2\n')
  return { db, tree }
}

const metricLines = (text: string): string[] => text.split('\n').slice(0, 5)

test('records five rows for today and replaces them on rerun', () => {
  const { db, tree } = bench()
  health(db, tree, TODAY)
  health(db, tree, TODAY)
  expect(counted(db, TODAY)).toEqual(new Map([
    ['citing-comment', 0], ['lines', 2], ['prepare', 0], ['silent-catch', 0], ['test-name', 0],
  ]))
})

test('a row seven days back gives a signed delta', () => {
  const { db, tree } = bench()
  db.exec(`INSERT INTO ratchet_counts (day, metric, count) VALUES
    ('${WEEK_AGO}', 'citing-comment', 0), ('${WEEK_AGO}', 'lines', 5), ('${WEEK_AGO}', 'prepare', 0),
    ('${WEEK_AGO}', 'silent-catch', 0), ('${WEEK_AGO}', 'test-name', 0)`)
  expect(metricLines(health(db, tree, TODAY))).toEqual([
    'citing-comment\t0\t0', 'lines\t2\t-3', 'prepare\t0\t0', 'silent-catch\t0\t0', 'test-name\t0\t0',
  ])
  db.exec(`UPDATE ratchet_counts SET count = 1 WHERE day = '${WEEK_AGO}' AND metric = 'lines'`)
  expect(metricLines(health(db, tree, TODAY))[1]).toBe('lines\t2\t+1')
})

test('with no row seven days back every delta is a dash', () => {
  const { db, tree } = bench()
  expect(metricLines(health(db, tree, TODAY))).toEqual([
    'citing-comment\t0\t-', 'lines\t2\t-', 'prepare\t0\t-', 'silent-catch\t0\t-', 'test-name\t0\t-',
  ])
})

test('warns only on recent would-refuse ratchet events', () => {
  const { db, tree } = bench()
  db.exec(`INSERT INTO events (plan, at, kind, actor, outcome, message) VALUES
    (1, '2026-09-20 10:00:00', 'ratchet', 'ratchet', 'pass', 'would refuse: a.ts lines 400 over budget 300'),
    (1, '2026-09-18 10:00:00', 'ratchet', 'ratchet', 'pass', 'would refuse: old'),
    (1, '2026-09-21 10:00:00', 'rail', 'ratchet', 'pass', 'would refuse: other kind')`)
  const warns = health(db, tree, TODAY).split('\n').filter((l) => l.startsWith('warn'))
  expect(warns).toEqual(['warn\tplan 1\t2026-09-20 10:00:00\twould refuse: a.ts lines 400 over budget 300'])
})

test('prints each raise with its reason and never ratchet.mode', () => {
  const { db, tree } = bench()
  db.exec(`INSERT OR REPLACE INTO settings (key, value, who, origin_kind, origin_ref, set_at) VALUES
    ('ratchet.raise.lines.cli.cf.ts', '520', 'pr', 'ruling', 'r1', '2026-09-20'),
    ('ratchet.mode', 'warn', 'ceo', 'ruling', 'r0', '2026-09-20')`)
  const raised = health(db, tree, TODAY).split('\n').filter((l) => l.startsWith('raise'))
  expect(raised).toEqual(['raise\tratchet.raise.lines.cli.cf.ts\t520\truling:r1\t2026-09-20'])
})

test('refuses a bad metric, a negative count and a bad day', () => {
  const db = fresh(schema)
  expect(rejects(db, `INSERT INTO ratchet_counts VALUES ('${TODAY}', 'bogus', 1)`)).toBe(true)
  expect(rejects(db, `INSERT INTO ratchet_counts VALUES ('${TODAY}', 'lines', -1)`)).toBe(true)
  expect(rejects(db, "INSERT INTO ratchet_counts VALUES ('26-09-2026', 'lines', 1)")).toBe(true)
})
