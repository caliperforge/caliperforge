import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Desk } from '../../cli/gh.ts'
import { all } from '../../cli/inbox.ts'
import type { Db } from '../../store/index.ts'
import { late } from '../signals.ts'

const schema = join(import.meta.dirname, '../../schema')

const FRIDAY = new Date('2026-10-03T00:01:00.000Z')

function world(): { db: Db; root: string } {
  const db = fresh(schema)
  db.prepare("UPDATE settings SET value = '-360' WHERE key = 'tick.zone_offset_minutes'").run()
  return { db, root: mkdtempSync(join(tmpdir(), 'late-')) }
}

function fake(broken = false): Desk & { titles: string[] } {
  const titles: string[] = []
  const no = (): never => { throw new Error('not used') }
  return {
    titles,
    open: (title) => {
      if (broken) throw new Error('gh is down')
      titles.push(title)
      return { no: 100 + titles.length, url: `https://github.com/o/r/issues/${String(100 + titles.length)}` }
    },
    seen: no, unlabel: no, close: no, rehearsal: no, lines: no,
  }
}

function weekly(db: Db, day: string, status: string): void {
  db.prepare(`INSERT INTO desk_posts (kind, dest, status, title, dek, body, sources, checks, work_date, written_date)
    VALUES ('weekly', 'site', ?, 'The week', 'What moved', 'Body.', '[]', '[]', ?, ?)`).run(status, day, day)
}

test('Friday 18:01, no weekly post: one card, one event, once',() => {
  const { db, root } = world()
  const board = fake()
  late(db, root, board, FRIDAY)
  late(db, root, board, FRIDAY)
  late(db, root, board, new Date('2026-10-04T12:00:00.000Z'))
  expect(board.titles).toEqual(['Weekly post not on the desk'])
  expect(all(root)).toEqual([{ at: FRIDAY.toISOString(), plan: 0, ticket: 'week 2026-09-28', kind: 'late', step: 0,
    name: 'weekly', note: 'no weekly post on the desk: https://github.com/o/r/issues/101' }])
})

test('Friday 17:59 local and a Thursday raise nothing', () => {
  const { db, root } = world()
  const board = fake()
  late(db, root, board, new Date('2026-10-02T23:59:00.000Z'))
  late(db, root, board, new Date('2026-10-01T23:00:00.000Z'))
  expect(board.titles).toEqual([])
  expect(all(root)).toEqual([])
})

test('a weekly post this week, in any status, raises nothing',() => {
  for (const [day, status] of [['2026-09-28', 'proof'], ['2026-10-04', 'published']] as const) {
    const { db, root } = world()
    const board = fake()
    weekly(db, day, status)
    late(db, root, board, FRIDAY)
    expect(board.titles).toEqual([])
    expect(all(root)).toEqual([])
  }
})

test('a weekly post from last week still raises, once', () => {
  const { db, root } = world()
  const board = fake()
  weekly(db, '2026-09-27', 'published')
  late(db, root, board, FRIDAY)
  late(db, root, board, FRIDAY)
  expect(board.titles).toHaveLength(1)
  expect(all(root)).toHaveLength(1)
})

test('a failed open leaves no event; the next tick raises once',() => {
  const { db, root } = world()
  expect(() => { late(db, root, fake(true), FRIDAY) }).toThrow('gh is down')
  expect(all(root)).toEqual([])
  const board = fake()
  late(db, root, board, FRIDAY)
  expect(board.titles).toHaveLength(1)
  expect(all(root)).toHaveLength(1)
})
