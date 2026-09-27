import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { gardened } from '../../store/gardens.ts'
import type { Db } from '../../store/index.ts'
import { garden } from '../garden.ts'
import { SELF } from '../workspace.ts'

const schema = join(import.meta.dirname, '../../schema')
const NOW = new Date('2026-09-26T10:00:00Z')
const DAY = '2026-09-26'
const URL = 'https://github.com/caliperforge/caliperforge/issues/'
const SILENT = 'try { f() } catch {}\n'

let root = ''
let filed: [string, string, string, string[]][] = []

const file = (repo: string, title: string, body: string, labels: string[]): string => {
  filed.push([repo, title, body, labels])
  return `${URL}${String(900 + filed.length)}`
}

function piped(enabled = 1, start = '00:00', end = '23:59', max = 1): Db {
  const db = fresh(schema)
  db.exec(`UPDATE settings SET value = '0' WHERE key = 'tick.zone_offset_minutes';
    INSERT INTO pipes (name, enabled, window_start, window_end, max_concurrent)
    VALUES ('internal', ${String(enabled)}, '${start}', '${end}', ${String(max)})`)
  return db
}

function queue(db: Db, priority: number): void {
  db.exec(`INSERT INTO plans (pipe_id, template, state, queued_at, lane, seat, origin, step, priority)
    VALUES ((SELECT id FROM pipes WHERE name = 'internal'), 'pr_path', 'queued', '${DAY}', 'machine', 'typescript_specialist', '${URL}1', 0, ${String(priority)})`)
}

function gardens(db: Db, open: boolean): void {
  for (const n of [11, 12]) {
    db.exec(`INSERT INTO gardens (day, metric, url) VALUES ('2026-09-${String(n)}', 'prepare', '${URL}${String(n)}')`)
    if (open) db.exec(`INSERT INTO tickets (repo, number, title, lane) VALUES ('caliperforge/caliperforge', ${String(n)}, 't', 'machine')`)
  }
}

beforeEach(() => {
  filed = []
  root = mkdtempSync(join(tmpdir(), 'cf-garden-'))
  writeFileSync(join(root, 'a.ts'), SILENT.repeat(2))
  for (const name of ['b', 'c', 'd', 'e', 'f']) writeFileSync(join(root, `${name}.ts`), SILENT)
})

test('D1: an idle lane files one P3 ticket naming its metric', () => {
  const db = piped()
  expect(garden(db, root, NOW, file)).toBe(`${URL}901`)
  expect(filed).toEqual([[SELF, 'Gardener: lower silent-catch in 5 files',
    '**What:** lower silent-catch in a.ts, b.ts, c.ts, d.ts, e.ts: rethrow or record an event with logged()\n' +
    '**Why:** cf health counts 7 silent-catch\n**When it ends:** cf health shows silent-catch at most 1\n',
    ['lane:machine', 'P3']]])
  expect(gardened(db, DAY)).toBe(true)
})

test.each([0, 1, 2])('D2: a live P%i plan on the pipe files nothing', (priority) => {
  const db = piped(1, '00:00', '23:59', 2)
  queue(db, priority)
  expect(garden(db, root, NOW, file)).toBeNull()
  expect(filed).toEqual([])
  expect(gardened(db, DAY)).toBe(false)
})

test('D3: two open gardener tickets file nothing', () => {
  const db = piped()
  gardens(db, true)
  expect(garden(db, root, NOW, file)).toBeNull()
  expect(filed).toEqual([])
})

test('D3: two closed gardener tickets still file', () => {
  const db = piped()
  gardens(db, false)
  expect(garden(db, root, NOW, file)).toBe(`${URL}901`)
})

test('D4: a second call on the same day files nothing', () => {
  const db = piped()
  garden(db, root, NOW, file)
  expect(garden(db, root, NOW, file)).toBeNull()
  expect(filed).toHaveLength(1)
})

test.each([
  { pipe: 'off', made: () => piped(0) },
  { pipe: 'out of its window', made: () => piped(1, '00:00', '00:01') },
  { pipe: 'at max_concurrent', made: () => { const db = piped(); queue(db, 5); return db } },
])('D5: a pipe $pipe files nothing', ({ made }) => {
  expect(garden(made(), root, NOW, file)).toBeNull()
  expect(filed).toEqual([])
})

test('D5: a tree with every non-lines metric at 0 files nothing', () => {
  const clean = mkdtempSync(join(tmpdir(), 'cf-garden-'))
  writeFileSync(join(clean, 'a.ts'), 'export const a = 1\n')
  expect(garden(piped(), clean, NOW, file)).toBeNull()
  expect(filed).toEqual([])
})

test('D6: a file that throws leaves no gardens row', () => {
  const db = piped()
  expect(() => garden(db, root, NOW, () => { throw new Error('gh down') })).toThrow('gh down')
  expect(gardened(db, DAY)).toBe(false)
  expect(garden(db, root, NOW, file)).toBe(`${URL}901`)
})
