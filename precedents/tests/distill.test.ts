import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Read } from '../../cli/gh.ts'
import type { Provider } from '../../providers/kind.ts'
import { ofKind } from '../../store/events.ts'
import { dump } from '../../store/index.ts'
import { flagged } from '../../store/precedent-findings.ts'
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

const later: Thread = { kind: 'inline', author: 'm', role: 'maintainer', text: "let's do that in a follow-up", path: 'a.ts', line: 9,
  url: 'https://github.com/o/r/pull/7#discussion_r3' }
const echoed: Thread = { kind: 'comment', author: 'c', role: 'contributor', text: "let's do that in a follow-up", path: null, line: null,
  url: 'https://github.com/o/r/pull/7#issuecomment-4' }

const opening = (said_by: string, source: string) =>
  `- opening: deferred | area: a.ts | quote: "do that in a follow-up" | said_by: ${said_by} | source: ${source}`

it('opening D1 a maintainer deferral stores one open row', async () => {
  const db = stored([later, echoed])
  expect(await distill(db, root, 'o/r', replies(opening('m', later.url)))).toBe(0)
  expect(dumped(db, 'openings')).toEqual([
    `INSERT INTO "openings" VALUES (1, 'o/r', 'deferred', 'a.ts', '"do that in a follow-up"', 'm', '${later.url}', '2026-10-01T00:00:00Z', 'open');`])
  expect(ofKind(db, 'precedent_refused')).toEqual([])
})

it.each([
  { from: 'the contributor', said_by: 'c', source: echoed.url },
  { from: 'an empty source', said_by: 'm', source: '' },
  { from: 'a source no thread holds', said_by: 'm', source: 'https://github.com/o/r/pull/7#discussion_r9' },
  { from: "another author's thread", said_by: 'm', source: echoed.url },
])('opening D2/D3 $from is refused', async ({ said_by, source }) => {
  const db = stored([later, echoed])
  const line = opening(said_by, source).trim()
  await distill(db, root, 'o/r', replies(line))
  expect(dumped(db, 'openings')).toEqual([])
  expect(ofKind(db, 'precedent_refused')).toEqual([{ plan: null, kind: 'precedent_refused', actor: 'cf', outcome: 'refuse', message: line }])
})

it('opening D4 a decision and an opening store one of each', async () => {
  const db = stored([explains, later])
  expect(await distill(db, root, 'o/r', replies(`${row('m', 'maintainer', explains.url)}\n${opening('m', later.url)}`))).toBe(1)
  expect(precedents(db, 'o/r')).toHaveLength(1)
  expect(dumped(db, 'openings')).toHaveLength(1)
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

const bot: Thread = { kind: 'inline', author: 'greptile-apps[bot]', role: 'bot', text: 'the cache goes stale', path: 'a.ts', line: 4,
  url: 'https://github.com/o/r/pull/7#discussion_r5' }

const finding = (acted_on: string, source = bot.url) => `- bot: the cache goes stale | area: a.ts | acted_on: ${acted_on} | source: ${source}`

function reads(patch: string): Read {
  const got: Record<string, unknown> = {
    'repos/o/r/pulls/7/comments?per_page=100': [{ id: 5, commit_id: 'c2', original_commit_id: 'c1', path: 'a.ts', line: 4, original_line: 4,
      body: bot.text, user: { login: bot.author } }],
    'repos/o/r/pulls/7/commits?per_page=100': [{ sha: 'c1' }, { sha: 'c2' }],
    'repos/o/r/commits/c2': { files: [{ filename: 'a.ts', patch }] },
  }
  return (args) => got[args[1] ?? '']
}

const never: Read = () => {
  throw new Error('read')
}

const refusal = (message: string) => [{ plan: null, kind: 'precedent_refused', actor: 'cf', outcome: 'refuse', message }]

it('bot D1 a fixed row the next commit leaves alone is refused', async () => {
  const db = stored([bot])
  expect(await distill(db, root, 'o/r', replies(finding('fixed')), reads('@@ -10,2 +10,2 @@\n-x\n+y\n z'))).toBe(0)
  expect(flagged(db, 'o/r')).toEqual([])
  expect(ofKind(db, 'precedent_refused')).toEqual(refusal(finding('fixed')))
})

it('bot D2 a fixed row the next commit changes is stored', async () => {
  const db = stored([bot])
  await distill(db, root, 'o/r', replies(finding('fixed')), reads('@@ -3,3 +3,3 @@\n a\n-b\n+c\n d'))
  expect(flagged(db, 'o/r')).toEqual([{ number: 7, finding: 'the cache goes stale', area: 'a.ts', acted_on: 'fixed', source: bot.url }])
  expect(ofKind(db, 'precedent_refused')).toEqual([])
})

it('bot D3 an ignored row is stored without a read', async () => {
  const db = stored([bot])
  await distill(db, root, 'o/r', replies(finding('ignored')), never)
  expect(flagged(db, 'o/r').map((f) => f.acted_on)).toEqual(['ignored'])
})

it('bot D4 an agreed row with a maintainer at its line is stored', async () => {
  const db = stored([bot, explains])
  await distill(db, root, 'o/r', replies(finding('agreed')), never)
  expect(flagged(db, 'o/r').map((f) => f.acted_on)).toEqual(['agreed'])
})

it('bot D4 an agreed row with no maintainer there is refused', async () => {
  const db = stored([bot, later])
  await distill(db, root, 'o/r', replies(finding('agreed')), never)
  expect(flagged(db, 'o/r')).toEqual([])
  expect(ofKind(db, 'precedent_refused')).toEqual(refusal(finding('agreed')))
})

it('bot D5 a row whose source names no thread is refused', async () => {
  const db = stored([bot])
  const line = finding('ignored', 'https://github.com/o/r/pull/7#discussion_r9')
  await distill(db, root, 'o/r', replies(line), never)
  expect(flagged(db, 'o/r')).toEqual([])
  expect(ofKind(db, 'precedent_refused')).toEqual(refusal(line))
})
