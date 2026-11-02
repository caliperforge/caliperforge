import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Read } from '../../cli/gh.ts'
import { keep, precedents, type Thread } from '../../precedents/store.ts'
import type { Provider } from '../../providers/kind.ts'
import { ofKind, pointers } from '../../store/events.ts'
import type { Db } from '../../store/index.ts'
import { set } from '../../store/lanes.ts'
import { addPipe, pipeNamed, putPlan, type PlanRow } from '../../store/plans.ts'
import { addAccount, putTarget } from '../../store/targets.ts'
import { tick } from '../index.ts'
import { CARRIED, stub } from './world.ts'

const schema = join(import.meta.dirname, '../../schema')
const repo = join(import.meta.dirname, '../..')
const said: Thread = { kind: 'inline', author: 'm', role: 'maintainer', text: 'keep the cache', path: 'a.ts', line: 4,
  url: 'https://github.com/o/live/pull/1#discussion_r1' }

const REPOS: [string, PlanRow['state'], string][] = [['o/live', 'queued', '2026-08-01'], ['o/recent', 'done', '2026-10-21'],
  ['o/stale', 'done', '2026-09-01']]

function world(): Db {
  const db = fresh(schema)
  set(db, 'tick.zone_offset_minutes', '-360', 'ceo', '2026-10-01')
  addPipe(db, { name: 'internal', enabled: 0, window_start: '00:00', window_end: '23:59', max_concurrent: 1 })
  const pipe = Number(pipeNamed(db, 'internal')?.id)
  REPOS.forEach(([repo, state, queued], i) => {
    const id = i + 1
    addAccount(db, { id, repo, measured_at: '2026-08-01', maintainers: 2, doors: 1, last_outsider_merge: null,
      open_pr_age_p50_days: 3, cross_repo_activity: 4, pulse: 'cold', evidence: `https://github.com/${repo}` })
    putTarget(db, { id, account_id: id, repo, issue_no: 12, named_merger: 'maintainer', state: 'queued',
      evidence_measured_at: '2026-08-01', evidence: `https://github.com/${repo}/issues/12` })
    putPlan(db, { id, pipe_id: pipe, target_id: id, template: 'pr_path', state, queued_at: `${queued}T00:00:00.000Z`, step: 0, retries: 0 })
  })
  return db
}

function reader(down?: string): { harvested: string[]; read: Read } {
  const harvested: string[] = []
  return { harvested, read: (args) => {
    if (args[0] !== 'pr' || args[1] !== 'list') throw new Error(`unread: ${args.join(' ')}`)
    const repo = String(args[3])
    harvested.push(repo)
    if (repo === down) throw new Error(`${repo} is down`)
    return []
  } }
}

const at = (db: Db, when: string, read?: Read, provider: Provider = stub(CARRIED)): Promise<unknown> => {
  const root = mkdtempSync(join(tmpdir(), 'cf-precedents-'))
  for (const dir of ['rules', 'seats']) cpSync(join(repo, dir), join(root, dir), { recursive: true })
  return tick(db, root, provider, new Date(when), undefined, undefined, 0, read)
}

function sourced(db: Db, ...repos: string[]): void {
  for (const r of repos) keep(db, { repo: r, number: 1, title: r, merged_at: '2026-10-01T00:00:00Z', merger: null, files: ['a.ts'], issues: [] }, [said])
}

function writer(fired: string[], fails = false): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (p) => {
      fired.push(p.prompt)
      if (fails) return Promise.reject(new Error('the writer is down'))
      return Promise.resolve({ text: `- area: a.ts | decision: keep the cache | why: callers rely on it | said_by: m (maintainer) | source: ${said.url}`,
        transcript_path: p.transcript, usage: { input: 1, cache: 1, output: 1 }, seconds: 0.5, ended: 'completed', exit: 0,
        stop_reason: 'end_turn', denials: 0 })
    },
  }
}

test('D1-D3 each targeted repo is harvested once per local day', async () => {
  const db = world()
  const { harvested, read } = reader()
  await at(db, '2026-10-31T12:00:00Z', read)
  await at(db, '2026-11-01T03:00:00Z', read)
  expect(harvested).toEqual(['o/live', 'o/recent'])
  await at(db, '2026-11-01T12:00:00Z', read)
  expect(harvested).toEqual(['o/live', 'o/recent', 'o/live', 'o/recent'])
  expect(pointers(db, 'precedent_harvest')).toEqual(['2026-10-31 o/live', '2026-10-31 o/recent', '2026-11-01 o/live', '2026-11-01 o/recent'])
  expect(ofKind(db, 'precedent_harvest').map((e) => [e.actor, e.outcome, e.message])).toEqual(Array(4).fill(['cf', 'pass', '0 stored']))
})

test('D4 a failed harvest is logged and not retried that day', async () => {
  const db = world()
  const { harvested, read } = reader('o/live')
  await at(db, '2026-10-31T12:00:00Z', read)
  await at(db, '2026-10-31T13:00:00Z', read)
  expect(harvested).toEqual(['o/live', 'o/live', 'o/recent'])
  expect(ofKind(db, 'precedent_harvest').map((e) => [e.outcome, e.message])).toEqual([['refuse', 'o/live is down'], ['pass', '0 stored']])
})

test('D5 a tick with no reader harvests nothing', async () => {
  const db = world()
  await at(db, '2026-10-31T12:00:00Z')
  expect(ofKind(db, 'precedent_harvest')).toEqual([])
})

test('distill D3 a passed harvest distills its repo', async () => {
  const db = world()
  sourced(db, 'o/live')
  const fired: string[] = []
  await at(db, '2026-10-31T12:00:00Z', reader().read, writer(fired))
  expect(fired).toHaveLength(1)
  expect(precedents(db, 'o/live').map((p) => p.source)).toEqual([said.url])
})

test('distill D4 a refused harvest leaves its repo undistilled', async () => {
  const db = world()
  sourced(db, 'o/live', 'o/recent')
  const fired: string[] = []
  await at(db, '2026-10-31T12:00:00Z', reader('o/live').read, writer(fired))
  expect(fired.map((p) => p.includes('# o/live'))).toEqual([false])
  expect(precedents(db, 'o/live')).toEqual([])
})

test('distill D5 a thrown distill is logged, the next repo read', async () => {
  const db = world()
  sourced(db, 'o/live')
  const { harvested, read } = reader()
  await at(db, '2026-10-31T12:00:00Z', read, writer([], true))
  expect(harvested).toEqual(['o/live', 'o/recent'])
  expect(ofKind(db, 'precedent_refused').map((e) => e.message)).toEqual(['the writer is down'])
  expect(pointers(db, 'precedent_refused')).toEqual(['o/live'])
})
