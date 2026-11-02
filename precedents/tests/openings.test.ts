import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { dump } from '../../store/index.ts'
import { type Opening, opened, vouched } from '../openings.ts'
import type { Source } from '../store.ts'

const pr: Source = { repo: 'o/r', number: 7, title: 'Fix', merged_at: '2026-10-01T00:00:00Z', merger: null, files: ['a.ts'], issues: [] }
const row: Opening = { kind: 'deferred', area: 'a.ts', quote: 'a follow-up', said_by: 'm', source: 'https://github.com/o/r/pull/7#discussion_r1' }

function dumped(db: ReturnType<typeof fresh>): string[] {
  const out = join(mkdtempSync(join(tmpdir(), 'cf-openings-')), 'dump.sql')
  dump(db, out)
  return readFileSync(out, 'utf8').split('\n').filter((l) => l.startsWith('INSERT INTO "openings"'))
}

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
