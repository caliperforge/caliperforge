import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { distilled, keep, precedents, type Source, type Thread } from '../../precedents/store.ts'
import type { Provider } from '../../providers/kind.ts'
import type { Db } from '../../store/index.ts'
import { registerPrecedents } from '../cf-precedents.ts'
import type { Read } from '../gh.ts'

const repo = join(import.meta.dirname, '../..')
const pr = (number: number, title: string, merged_at: string): Source =>
  ({ repo: 'o/r', number, title, merged_at, merger: null, files: ['a.ts'], issues: [] })
const said: Thread = { kind: 'inline', author: 'm', role: 'maintainer', text: 'keep the cache', path: 'a.ts', line: 4,
  url: 'https://github.com/o/r/pull/7#discussion_r1' }
const ROW = `- area: a.ts | decision: keep the cache | why: callers rely on it | said_by: m (maintainer) | source: ${said.url}`

function replies(fired: string[]): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (p) => {
      fired.push(p.prompt)
      return Promise.resolve({ text: ROW, transcript_path: p.transcript, usage: { input: 1, cache: 1, output: 1 }, seconds: 0.5,
        ended: 'completed', exit: 0, stop_reason: 'end_turn', denials: 0 })
    },
  }
}

async function distilling(db: Db, fired: string[]): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'cf-precedents-'))
  for (const dir of ['rules', 'seats']) cpSync(join(repo, dir), join(root, dir), { recursive: true })
  let printed = ''
  const cf = new Command().exitOverride()
  registerPrecedents(cf, { root, db: () => db, out: (text) => { printed += text } }, replies(fired))
  await cf.parseAsync(['precedents', 'distill', 'o/r'], { from: 'user' })
  return printed
}

test('D1 distill fires each undistilled source, oldest first', async () => {
  const db = fresh(join(repo, 'schema'))
  const old = pr(3, 'Done', '2026-09-01T00:00:00Z')
  keep(db, old, [said])
  distilled(db, old, [], 0)
  keep(db, pr(9, 'Later', '2026-10-03T00:00:00Z'), [said])
  keep(db, pr(7, 'Sooner', '2026-10-01T00:00:00Z'), [said])
  const fired: string[] = []
  expect(await distilling(db, fired)).toBe('o/r\t2 distilled, 2 stored\n')
  expect(fired.map((p) => ['# Done', '# Sooner', '# Later'].filter((t) => p.includes(t)))).toEqual([['# Sooner'], ['# Later']])
  expect(precedents(db, 'o/r')).toHaveLength(2)
})

test('D2 with nothing undistilled distill fires nothing', async () => {
  const fired: string[] = []
  expect(await distilling(fresh(join(repo, 'schema')), fired)).toBe('o/r\t0 distilled, 0 stored\n')
  expect(fired).toEqual([])
})

test('D6 for prints each match as its stored row, or nothing', async () => {
  const db = fresh(join(repo, 'schema'))
  const source = pr(7, 'Fix', '2026-10-01T00:00:00Z')
  keep(db, source, [said])
  distilled(db, source, [{ area: 'a.ts', decision: 'keep the cache', why: 'callers rely on it', said_by: 'm', role: 'maintainer', source: said.url }], 0)
  const read: Read = (args) => (args[1] === 'repos/o/r' ? { default_branch: 'main' } : { tree: [{ path: 'a.ts' }], truncated: false })
  let printed = ''
  const cf = new Command().exitOverride()
  registerPrecedents(cf, { root: repo, db: () => db, out: (text) => { printed += text } }, replies([]), read)
  await cf.parseAsync(['precedents', 'for', 'o/r', 'a.ts'], { from: 'user' })
  expect(printed).toBe(`${ROW}\n`)
  await cf.parseAsync(['precedents', 'for', 'o/r', 'b.ts'], { from: 'user' })
  expect(printed).toBe(`${ROW}\n`)
})
