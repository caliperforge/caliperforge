import { join } from 'node:path'
import { expect, test } from 'vitest'
import { migrate, open, type Db } from './index.ts'
import { blipped, clear, fingerprint, refused, ROUNDS } from './refusals.ts'

const root = join(import.meta.dirname, '..')

const PLAN = 1

const A = fingerprint(3, ['src/a.ts:4 function_lines'])

const B = fingerprint(4, ['src/b.ts:9'])

const D1 = 'a'.repeat(64)

const D2 = 'b'.repeat(64)

function bench(): Db {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin)
    VALUES (?, 1, 'pr_path', 'running', '2026-09-21T00:00:00.000Z', 'machine', 'typescript_specialist',
      'https://github.com/caliperforge/caliperforge/issues/76')`).run(PLAN)
  return db
}

test('timings do not change a check fingerprint', () => {
  const run = (ms: number, name: string): string =>
    fingerprint(3, ['checks:test'], ` FAIL  store/x.test.ts > ${name} ${String(ms)}ms\nAssertionError: expected 1 to be 2`)
  expect(run(94604, 'reads')).toBe(run(1200, 'reads'))
  expect(run(94604, 'reads')).not.toBe(run(94604, 'writes'))
})

test('a new refusal goes round again', () => {
  const db = bench()
  expect(refused(db, { plan: PLAN, step: 3, fingerprint: A, diff: D1 })).toBe('again')
  expect(refused(db, { plan: PLAN, step: 4, fingerprint: B, diff: D2 })).toBe('again')
})

test('the same failure on another job stops as shared, until a person clears it', () => {
  const db = bench()
  db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin)
    VALUES (2, 1, 'pr_path', 'running', '2026-09-21T00:00:00.000Z', 'machine', 'typescript_specialist',
      'https://github.com/caliperforge/caliperforge/issues/77')`).run()
  refused(db, { plan: 2, step: 3, fingerprint: A, diff: D1 })
  expect(refused(db, { plan: PLAN, step: 3, fingerprint: A, diff: D2 })).toBe('shared')
  clear(db, 2)
  clear(db, PLAN)
  expect(refused(db, { plan: PLAN, step: 3, fingerprint: A, diff: D2 })).toBe('again')
})

test('the same brief refusal on two jobs is not shared', () => {
  const db = bench()
  db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin)
    VALUES (2, 1, 'pr_path', 'running', '2026-09-21T00:00:00.000Z', 'machine', 'typescript_specialist',
      'https://github.com/caliperforge/caliperforge/issues/77')`).run()
  const title = fingerprint(1, ['# <title>'])
  refused(db, { plan: 2, step: 1, fingerprint: title, diff: null })
  expect(refused(db, { plan: PLAN, step: 1, fingerprint: title, diff: null })).toBe('again')
})

test('the same refusal twice stops', () => {
  const db = bench()
  refused(db, { plan: PLAN, step: 3, fingerprint: A, diff: D1 })
  refused(db, { plan: PLAN, step: 4, fingerprint: B, diff: D2 })
  expect(refused(db, { plan: PLAN, step: 3, fingerprint: A, diff: 'c'.repeat(64) })).toBe('repeat')
})

test('a build that changed nothing stops', () => {
  const db = bench()
  refused(db, { plan: PLAN, step: 4, fingerprint: A, diff: D1 })
  expect(refused(db, { plan: PLAN, step: 4, fingerprint: B, diff: D1 })).toBe('unchanged')
})

test('the last round stops however new it is', () => {
  const db = bench()
  const whys = [...Array(ROUNDS).keys()].map((n) =>
    refused(db, { plan: PLAN, step: 3, fingerprint: fingerprint(3, [`src/a.ts:${String(n)}`]), diff: String(n).padStart(64, '0') }))
  expect(whys.slice(0, -1).every((w) => w === 'again')).toBe(true)
  expect(whys.at(-1)).toBe('spent')
})

test('a third blip in a row stops, a real refusal breaks the run', () => {
  const db = bench()
  expect(blipped(db, PLAN, 1)).toBe('again')
  expect(blipped(db, PLAN, 1)).toBe('again')
  refused(db, { plan: PLAN, step: 1, fingerprint: A, diff: null })
  expect(blipped(db, PLAN, 1)).toBe('again')
  expect(blipped(db, PLAN, 1)).toBe('again')
  expect(blipped(db, PLAN, 1)).toBe('blips')
})

test('blips never count as rounds', () => {
  const db = bench()
  for (let n = 0; n < ROUNDS; n += 1) blipped(db, PLAN, 1)
  expect(refused(db, { plan: PLAN, step: 3, fingerprint: A, diff: D1 })).toBe('again')
})

test('a cleared plan starts its count over', () => {
  const db = bench()
  refused(db, { plan: PLAN, step: 3, fingerprint: A, diff: D1 })
  clear(db, PLAN)
  expect(refused(db, { plan: PLAN, step: 3, fingerprint: A, diff: D1 })).toBe('again')
})
