import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { planDir } from '../../sequencer/workspace.ts'
import { escapeCounts, escapesOf } from '../../store/escapes.ts'
import type { Db } from '../../store/index.ts'
import { addPipe, addPlan, pipeNamed } from '../../store/plans.ts'
import { addAccount, addTarget } from '../../store/targets.ts'
import { counted } from '../escapes.ts'
import { keep, type Thread } from '../store.ts'

const schema = join(import.meta.dirname, '../../schema')

const said = (role: string, path: string, line: number, id: number, kind = 'inline'): Thread =>
  ({ kind, author: role, role, text: 'fix this', path, line, url: `https://github.com/o/r/pull/7#discussion_r${String(id)}` })

function world(): { db: Db; root: string; plan: (no: number) => number } {
  const db = fresh(schema)
  const root = mkdtempSync(join(tmpdir(), 'cf-escapes-'))
  addAccount(db, { id: 1, repo: 'o/r', measured_at: '2026-10-01', maintainers: 1, doors: 1, last_outsider_merge: '2026-09-01',
    open_pr_age_p50_days: 0, cross_repo_activity: 0, pulse: 'cold', evidence: 'https://github.com/o/r/pulse' })
  addPipe(db, { name: 'escapes', enabled: 1, window_start: '00:00', window_end: '23:59', max_concurrent: 1 })
  const plan = (no: number): number => {
    const target = addTarget(db, { account_id: 1, repo: 'o/r', issue_no: no, named_merger: 'm', state: 'queued',
      evidence_measured_at: '2026-10-01', evidence: `https://github.com/o/r/pull/${String(no)}` })
    return addPlan(db, { pipe_id: Number(pipeNamed(db, 'escapes')?.id), target_id: target, template: 'pr_path', state: 'queued',
      queued_at: '2026-10-01T00:00:00.000Z', lane: null, seat: null, origin: null, step: 0 })
  }
  return { db, root, plan }
}

function found(root: string, plan: number, name: string, text: string): void {
  mkdirSync(planDir(root, plan), { recursive: true })
  writeFileSync(join(planDir(root, plan), name), text)
}

function seven(db: Db, threads: Thread[]): void {
  keep(db, { repo: 'o/r', number: 7, title: 'Fix', merged_at: null, merger: null, files: ['src/a.rs'], issues: [] }, threads)
}

it('D1 a maintainer comment on an unflagged line is one escape', () => {
  const { db, root, plan } = world()
  const id = plan(7)
  found(root, id, 'findings-abc.md', '- G1 src/a.rs:4 x\n')
  seven(db, [said('maintainer', 'src/a.rs', 4, 1), said('maintainer', 'src/a.rs', 9, 2)])
  expect(counted(db, root, 'o/r')).toEqual([{ number: 7, escapes: 1 }])
  expect(escapeCounts(db, 'o/r')).toEqual([{ number: 7, plan: id, escapes: 1 }])
  expect(escapesOf(db, 'o/r', 7)).toEqual([{ area: 'src/a.rs', line: 9, author: 'maintainer', role: 'maintainer', text: 'fix this',
    url: 'https://github.com/o/r/pull/7#discussion_r2' }])
})

it('D2 a blind row in another findings file flags its line', () => {
  const { db, root, plan } = world()
  const id = plan(7)
  found(root, id, 'findings-abc.md', '- G1 src/a.rs:4 x\n')
  found(root, id, 'findings-tree.md', '- B1 P2 `src/a.rs:9` — z\n')
  seven(db, [said('maintainer', 'src/a.rs', 4, 1), said('maintainer', 'src/a.rs', 9, 2)])
  expect(counted(db, root, 'o/r')).toEqual([{ number: 7, escapes: 0 }])
  expect(escapesOf(db, 'o/r', 7)).toEqual([])
})

it('D3 only bot and maintainer inline comments count', () => {
  const { db, root, plan } = world()
  plan(7)
  seven(db, [said('bot', 'src/a.rs', 1, 1), said('contributor', 'src/a.rs', 2, 2), said('maintainer', 'src/a.rs', 3, 3, 'review'),
    said('maintainer', 'src/a.rs', 5, 4, 'comment')])
  expect(counted(db, root, 'o/r')).toEqual([{ number: 7, escapes: 1 }])
  expect(escapesOf(db, 'o/r', 7).map((e) => [e.role, e.line])).toEqual([['bot', 1]])
})

it('D4 a reply on the same unflagged line counts once', () => {
  const { db, root, plan } = world()
  plan(7)
  seven(db, [said('maintainer', 'src/a.rs', 9, 1), said('bot', 'src/a.rs', 9, 2)])
  expect(counted(db, root, 'o/r')).toEqual([{ number: 7, escapes: 1 }])
  expect(escapesOf(db, 'o/r', 7).map((e) => e.url)).toEqual(['https://github.com/o/r/pull/7#discussion_r1'])
})

it('D5 counting again replaces the rows', () => {
  const { db, root, plan } = world()
  const id = plan(7)
  seven(db, [said('maintainer', 'src/a.rs', 9, 1)])
  counted(db, root, 'o/r')
  counted(db, root, 'o/r')
  expect(escapeCounts(db, 'o/r')).toEqual([{ number: 7, plan: id, escapes: 1 }])
  expect(escapesOf(db, 'o/r', 7)).toHaveLength(1)
  found(root, id, 'findings-abc.md', '- G1 src/a.rs:9 x\n')
  counted(db, root, 'o/r')
  expect(escapeCounts(db, 'o/r')).toEqual([{ number: 7, plan: id, escapes: 0 }])
  expect(escapesOf(db, 'o/r', 7)).toEqual([])
})

it('D6 a PR harvest has not stored gets no count', () => {
  const { db, root, plan } = world()
  plan(7)
  plan(8)
  seven(db, [])
  expect(counted(db, root, 'o/r')).toEqual([{ number: 7, escapes: 0 }])
  expect(escapeCounts(db, 'o/r').map((c) => c.number)).toEqual([7])
})
