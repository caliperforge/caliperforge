import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Provider } from '../../providers/kind.ts'
import { ofKind } from '../../store/events.ts'
import { dump } from '../../store/index.ts'
import { distill } from '../distill.ts'
import { keep, precedents, type Source, type Thread } from '../store.ts'

const root = join(import.meta.dirname, '../..')

const pr: Source = { repo: 'o/r', number: 7, title: 'Fix', merged_at: '2026-10-01T00:00:00Z', merger: null, files: ['a.ts'], issues: [] }
const explains: Thread = { kind: 'inline', author: 'm', role: 'maintainer', text: 'keep the cache: callers rely on it', path: 'a.ts', line: 4,
  url: 'https://github.com/o/r/pull/7#discussion_r1' }
const nit: Thread = { kind: 'comment', author: 'c', role: 'contributor', text: 'I chose a map', path: null, line: null,
  url: 'https://github.com/o/r/pull/7#issuecomment-2' }

const row = (said_by: string, role: string, source: string) =>
  `- area: a.ts | decision: keep the cache | why: "callers rely on it" | said_by: ${said_by} (${role}) | source: ${source}`

function replies(text: string, fired: string[] = []): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (p) => {
      fired.push(p.prompt)
      return Promise.resolve({ text, transcript_path: p.transcript, usage: { input: 5, cache: 6, output: 7 }, seconds: 0.5, ended: 'completed', exit: 0, stop_reason: 'end_turn', denials: 0 })
    },
  }
}

function stored(threads: Thread[]) {
  const db = fresh(join(root, 'schema'))
  keep(db, pr, threads)
  return db
}

function dumped(db: ReturnType<typeof fresh>, table: string): string[] {
  const out = join(mkdtempSync(join(tmpdir(), 'cf-distill-')), 'dump.sql')
  dump(db, out)
  return readFileSync(out, 'utf8').split('\n').filter((l) => l.startsWith(`INSERT INTO "${table}"`))
}

it('D1 a maintainer row keeps its source, number and merged_at', async () => {
  const db = stored([explains, nit])
  expect(await distill(db, root, 'o/r', replies(row('m', 'maintainer', explains.url)))).toBe(1)
  expect(precedents(db, 'o/r')).toEqual([{ area: 'a.ts', decision: 'keep the cache', why: '"callers rely on it"', said_by: 'm', role: 'maintainer', source: explains.url }])
  expect(dumped(db, 'precedents')).toEqual([
    `INSERT INTO "precedents" VALUES (1, 'o/r', 7, '2026-10-01T00:00:00Z', 'a.ts', 'keep the cache', '"callers rely on it"', 'm', 'maintainer', '${explains.url}');`])
})

it('D2 a none answer stores no row but marks the PR distilled', async () => {
  const db = stored([nit])
  expect(await distill(db, root, 'o/r', replies(' none\n'))).toBe(0)
  expect(precedents(db, 'o/r')).toEqual([])
  expect(dumped(db, 'precedent_distilled')).toHaveLength(1)
  expect(ofKind(db, 'precedent_refused')).toEqual([])
})

it.each(['', 'https://github.com/o/r/pull/7#discussion_r9'])('D3 a row with source "%s" is refused', async (source) => {
  const db = stored([explains])
  const line = row('m', 'maintainer', source).trim()
  expect(await distill(db, root, 'o/r', replies(line))).toBe(0)
  expect(precedents(db, 'o/r')).toEqual([])
  expect(ofKind(db, 'precedent_refused')).toEqual([{ plan: null, kind: 'precedent_refused', actor: 'cf', outcome: 'refuse', message: line }])
})

it('D4 a maintainer claim from a contributor stores contributor', async () => {
  const db = stored([explains, nit])
  await distill(db, root, 'o/r', replies(row('c', 'maintainer', nit.url)))
  expect(precedents(db, 'o/r').map((p) => p.role)).toEqual(['contributor'])
})

it('D5 the PR records input + cache + output tokens', async () => {
  const db = stored([nit])
  await distill(db, root, 'o/r', replies('none'))
  expect(dumped(db, 'precedent_distilled')).toEqual([`INSERT INTO "precedent_distilled" VALUES ('o/r', 7, 18);`])
})

it('D6 the next call takes the next-oldest, then none fires', async () => {
  const db = stored([explains])
  keep(db, { ...pr, number: 9, title: 'Later', merged_at: '2026-10-03T00:00:00Z' }, [])
  const fired: string[] = []
  await distill(db, root, 'o/r', replies('none', fired))
  await distill(db, root, 'o/r', replies('none', fired))
  expect(fired.map((p) => p.includes('# Later'))).toEqual([false, true])
  expect(await distill(db, root, 'o/r', replies('none', fired))).toBeNull()
  expect(fired).toHaveLength(2)
})
