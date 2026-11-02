import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { dump } from '../../store/index.ts'
import { finished, type Opening, opened, vouched } from '../openings.ts'
import type { Source } from '../store.ts'

const pr: Source = { repo: 'o/r', number: 7, title: 'Fix', merged_at: '2026-10-01T00:00:00Z', merger: null, files: ['a.ts'], issues: [] }
const row: Opening = { kind: 'deferred', area: 'a.ts', quote: 'a follow-up', said_by: 'm', source: 'https://github.com/o/r/pull/7#discussion_r1' }

function dumped(db: ReturnType<typeof fresh>): string[] {
  const out = join(mkdtempSync(join(tmpdir(), 'cf-openings-')), 'dump.sql')
  dump(db, out)
  return readFileSync(out, 'utf8').split('\n').filter((l) => l.startsWith('INSERT INTO "openings"'))
}

const statuses = (db: ReturnType<typeof fresh>) => dumped(db).map((l) => /'(\w+)'\);$/.exec(l)?.[1])

function by(db: ReturnType<typeof fresh>, number: number, source = `https://github.com/o/r/pull/${String(number)}#discussion_r1`): void {
  const day = String(number).padStart(2, '0')
  opened(db, { ...pr, number, merged_at: `2026-10-${day}T00:00:00Z` }, [{ ...row, quote: `q${day}`, said_by: `m${day}`, source }])
}

const later = { merged_at: '2026-10-02T00:00:00Z', files: ['a.ts'], issues: [], text: `see ${row.source}` }

it('D1 openings on one area from three PRs add one repeated row', () => {
  const db = fresh(join(import.meta.dirname, '../../schema'))
  by(db, 7)
  by(db, 8)
  expect(dumped(db).filter((l) => l.includes("'repeated'"))).toEqual([])
  by(db, 9)
  expect(dumped(db).filter((l) => l.includes("'repeated'"))).toEqual([`INSERT INTO "openings" VALUES (4, 'o/r', 'repeated', 'a.ts', 'q09', 'm09', \
'https://github.com/o/r/pull/9#discussion_r1', '2026-10-09T00:00:00Z', 'open');`])
})

it('D2 a fourth PR adds no second repeated row', () => {
  const db = fresh(join(import.meta.dirname, '../../schema'))
  for (const n of [7, 8, 9, 10]) by(db, n)
  expect(dumped(db).filter((l) => l.includes("'repeated'"))).toHaveLength(1)
})

it('D2 three openings from two PRs add no repeated row', () => {
  const db = fresh(join(import.meta.dirname, '../../schema'))
  by(db, 7)
  by(db, 7, 'https://github.com/o/r/pull/7#discussion_r2')
  by(db, 8)
  expect(dumped(db).filter((l) => l.includes("'repeated'"))).toEqual([])
})

it('D4 an opening stays open unless a later PR touches and links', () => {
  const db = fresh(join(import.meta.dirname, '../../schema'))
  opened(db, pr, [row])
  finished(db, 'o/r', { ...later, text: 'unrelated' })
  finished(db, 'o/r', { ...later, files: ['b.ts'] })
  finished(db, 'o/r', { ...later, merged_at: '2026-10-01T00:00:00Z' })
  finished(db, 'o/r', { ...later, merged_at: '2026-09-30T00:00:00Z' })
  expect(statuses(db)).toEqual(['open'])
})

it('D5 an opening whose quote links a closed issue goes done', () => {
  const db = fresh(join(import.meta.dirname, '../../schema'))
  opened(db, pr, [{ ...row, quote: 'left for #45' }, { ...row, quote: 'see https://github.com/o/r/issues/46', source: `${row.source}6` },
    { ...row, quote: 'left for #47', source: `${row.source}7` }])
  finished(db, 'o/r', { ...later, files: [], issues: [45, 46], text: '' })
  expect(statuses(db)).toEqual(['done', 'done', 'open'])
})

it('D6 a dismissed opening stays dismissed', () => {
  const db = fresh(join(import.meta.dirname, '../../schema'))
  opened(db, pr, [row])
  db.exec("UPDATE openings SET status = 'dismissed'")
  finished(db, 'o/r', later)
  expect(statuses(db)).toEqual(['dismissed'])
})

it('D5 a repeat opening keeps one row and its first first_seen', () => {
  const db = fresh(join(import.meta.dirname, '../../schema'))
  opened(db, pr, [row])
  opened(db, { ...pr, number: 9, merged_at: '2026-10-05T00:00:00Z' }, [row])
  expect(dumped(db)).toEqual([
    `INSERT INTO "openings" VALUES (1, 'o/r', 'deferred', 'a.ts', 'a follow-up', 'm', '${row.source}', '2026-10-01T00:00:00Z', 'open');`])
})

it('D4 vouched keeps open deferred and asked rows, newest first', () => {
  const db = fresh(join(import.meta.dirname, '../../schema'))
  const asked: Opening = { ...row, kind: 'asked', source: `${row.source}0` }
  opened(db, pr, [row, ...['done', 'taken', 'dismissed'].map((s) => ({ ...row, area: s }))])
  opened(db, { ...pr, merged_at: '2026-10-05T00:00:00Z' }, [asked])
  opened(db, { ...pr, repo: 'o/other' }, [row])
  db.exec(`UPDATE openings SET status = area WHERE area IN ('done', 'taken', 'dismissed');
    INSERT INTO openings (repo, kind, area, quote, said_by, source, first_seen) VALUES ('o/r', 'repeated', 'a.ts', 'q', 'm', 'u', '2026-10-09')`)
  expect(vouched(db, 'o/r')).toEqual([asked, row])
})

it('a kind outside the three is thrown by the CHECK', () => {
  const db = fresh(join(import.meta.dirname, '../../schema'))
  expect(() => { opened(db, pr, [{ ...row, kind: 'wanted' as Opening['kind'] }]) }).toThrow(/CHECK constraint/)
})
