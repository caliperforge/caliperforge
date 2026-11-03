import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { type Opening, opened, openings } from '../../precedents/openings.ts'
import { distilled, keep, precedents, type Source, type Thread } from '../../precedents/store.ts'
import type { Provider } from '../../providers/kind.ts'
import { planDir } from '../../sequencer/workspace.ts'
import type { Db } from '../../store/index.ts'
import { mismatched } from '../../store/parity.ts'
import { addPipe, addPlan, pipeNamed } from '../../store/plans.ts'
import { addAccount, addTarget } from '../../store/targets.ts'
import { registerPrecedents } from '../cf-precedents.ts'
import type { Read } from '../gh.ts'

const repo = join(import.meta.dirname, '../..')
const pr = (number: number, title: string, merged_at: string): Source =>
  ({ repo: 'o/r', number, title, merged_at, merger: null, files: ['a.ts'], issues: [] })
const said: Thread = { kind: 'inline', author: 'm', role: 'maintainer', text: 'keep the cache', path: 'a.ts', line: 4,
  url: 'https://github.com/o/r/pull/7#discussion_r1' }
const ROW = `- area: a.ts | decision: keep the cache | why: callers rely on it | said_by: m (maintainer) | source: ${said.url}`

function replies(fired: string[], text = ROW): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (p) => {
      fired.push(p.prompt)
      return Promise.resolve({ text, transcript_path: p.transcript, usage: { input: 1, cache: 1, output: 1 }, seconds: 0.5,
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

test('D7 escapes prints each PR count and its escapes', async () => {
  const db = fresh(join(repo, 'schema'))
  const root = mkdtempSync(join(tmpdir(), 'cf-escapes-'))
  addAccount(db, { id: 1, repo: 'o/r', measured_at: '2026-10-01', maintainers: 1, doors: 1, last_outsider_merge: '2026-09-01',
    open_pr_age_p50_days: 0, cross_repo_activity: 0, pulse: 'cold', evidence: 'https://github.com/o/r/pulse' })
  addPipe(db, { name: 'escapes', enabled: 1, window_start: '00:00', window_end: '23:59', max_concurrent: 1 })
  const target = addTarget(db, { account_id: 1, repo: 'o/r', issue_no: 7, named_merger: 'm', state: 'queued',
    evidence_measured_at: '2026-10-01', evidence: 'https://github.com/o/r/pull/7' })
  const plan = addPlan(db, { pipe_id: Number(pipeNamed(db, 'escapes')?.id), target_id: target, template: 'pr_path', state: 'queued',
    queued_at: '2026-10-01T00:00:00.000Z', lane: null, seat: null, origin: null, step: 0 })
  mkdirSync(planDir(root, plan), { recursive: true })
  writeFileSync(join(planDir(root, plan), 'findings-abc.md'), '- G1 src/a.rs:4 x\n')
  const nine = { ...said, path: 'src/a.rs', line: 9, url: 'https://github.com/o/r/pull/7#discussion_r2' }
  keep(db, pr(7, 'Fix', '2026-10-01T00:00:00Z'), [{ ...said, path: 'src/a.rs', line: 4 }, nine])
  let printed = ''
  const cf = new Command().exitOverride()
  registerPrecedents(cf, { root, db: () => db, out: (text) => { printed += text } }, replies([]))
  await cf.parseAsync(['precedents', 'escapes', 'o/r'], { from: 'user' })
  expect(printed).toBe(`o/r#7\t1\n  src/a.rs:9\t${nine.url}\n`)
})

test('D1 D2 openings lists open rows newest first, one repo or all', async () => {
  const db = fresh(join(repo, 'schema'))
  const opening = (area: string): Opening => ({ kind: 'deferred', area, quote: 'later', said_by: 'm', source: said.url })
  opened(db, pr(7, 'Old', '2026-10-01T00:00:00Z'), [opening('a.ts'), opening('b.ts')])
  opened(db, pr(9, 'New', '2026-10-03T00:00:00Z'), [opening('c.ts')])
  opened(db, { ...pr(2, 'Theirs', '2026-10-05T00:00:00Z'), repo: 'x/y' }, [opening('d.ts')])
  db.exec("UPDATE openings SET status = 'taken' WHERE area = 'b.ts'")
  let printed = ''
  const cf = new Command().exitOverride()
  registerPrecedents(cf, { root: repo, db: () => db, out: (text) => { printed += text } }, replies([]))
  const line = (at: string, r: string, area: string): string => `${at}\t${r}\tdeferred\t${area}\tm\t${said.url}\tlater\n`
  await cf.parseAsync(['openings', 'o/r'], { from: 'user' })
  expect(printed).toBe(line('2026-10-03T00:00:00Z', 'o/r', 'c.ts') + line('2026-10-01T00:00:00Z', 'o/r', 'a.ts'))
  printed = ''
  await cf.parseAsync(['openings'], { from: 'user' })
  expect(printed).toBe(line('2026-10-05T00:00:00Z', 'x/y', 'd.ts') + line('2026-10-03T00:00:00Z', 'o/r', 'c.ts') + line('2026-10-01T00:00:00Z', 'o/r', 'a.ts'))
})

test('openings prints a mismatch and its curls until dropped', async () => {
  const db = fresh(join(repo, 'schema'))
  const surfpool = 'solana-foundation/surfpool'
  mismatched(db, surfpool, '2026-11-01', [{ method: 'getSlot', case: 'empty', mainnet: '1', surfpool: '2', curls: ['curl a', 'curl b'] }])
  let printed = ''
  const cf = new Command().exitOverride()
  registerPrecedents(cf, { root: repo, db: () => db, out: (text) => { printed += text } }, replies([]))
  await cf.parseAsync(['openings', surfpool], { from: 'user' })
  expect(printed).toBe(`2026-11-01\t${surfpool}\tmismatch\tgetSlot empty\tparity_compare\tmainnet, surfpool\tmainnet: 1\nsurfpool: 2\ncurl a\ncurl b\n`)
  mismatched(db, surfpool, '2026-11-02', [])
  printed = ''
  await cf.parseAsync(['openings', surfpool], { from: 'user' })
  expect(printed).toBe('')
})

test('D1 D2 openings parity prints drift, a rerun fires nothing', async () => {
  const db = fresh(join(repo, 'schema'))
  const root = mkdtempSync(join(tmpdir(), 'cf-parity-'))
  for (const dir of ['rules', 'seats']) cpSync(join(repo, dir), join(root, dir), { recursive: true })
  mkdirSync(join(root, 'precedents'))
  writeFileSync(join(root, 'precedents/parity.yaml'), 'o/r:\n  contract: Signer\n  files:\n    rust: a.rs\n    go: a.go\n')
  const files: Record<string, string> = { 'a.rs': 'trait Signer {\n  async fn sign();\n}\n', 'a.go': 'type Signer interface {\n\tSign()\n}\n' }
  const read: Read = (args) => {
    const text = files[(args[1] ?? '').replace('repos/o/r/contents/', '')] ?? ''
    return { size: text.length, content: Buffer.from(text).toString('base64') }
  }
  const quote = 'sign | rust: async fn sign | go: func Sign | kind: sync-async | files: a.rs:2, a.go:2'
  const fired: string[] = []
  let printed = ''
  const cf = new Command().exitOverride()
  registerPrecedents(cf, { root, db: () => db, out: (text) => { printed += text } }, replies(fired, `- drift: ${quote}`), read)
  await cf.parseAsync(['openings', 'parity', 'o/r'], { from: 'user' })
  const row = `${String(openings(db, 'o/r')[0]?.first_seen)}\to/r\tdrift\tsign (sync-async)\tshape_compare\ta.rs, a.go\t${quote}\n`
  expect(printed).toBe(row)
  await cf.parseAsync(['openings', 'parity', 'o/r'], { from: 'user' })
  expect(printed).toBe(row + row)
  expect(fired).toHaveLength(1)
})
