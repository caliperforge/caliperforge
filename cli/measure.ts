import { z } from 'zod'
import type { Db } from '../store/index.ts'
import { gh, ours, WINDOW, type Read } from './gh.ts'

const Merged = z.array(z.object({
  author: z.object({ login: z.string() }).nullable(),
  mergedBy: z.object({ login: z.string() }).nullable(),
  mergedAt: z.string().nullable(),
}))

const Opened = z.array(z.object({
  createdAt: z.string(),
  headRepositoryOwner: z.object({ login: z.string() }).nullable(),
}))

const Elsewhere = z.array(z.object({ repository: z.object({ nameWithOwner: z.string() }) }))

/** Ruled at rev 4: no outsider merge in 21 days, or an open-PR median over 21 days, is a cold account. */
const COLD_DAYS = 21

/** Plan states a plan can still leave; a target under one of them is a loop of ours that is still open. */
const LIVE = "('queued', 'running', 'blocked_on_ceo')"

/** `gh search` is rate-limited at 30 a minute, so that is the window `elsewhere()` reads and the number of reads it makes. */
const SEARCHES = 30

export interface Pulse {
  repo: string
  measured_at: string
  maintainers: number
  doors: number
  last_outsider_merge: string | null
  open_pr_age_p50_days: number
  cross_repo_activity: number
  open_loop: boolean
  pulse: 'warm' | 'cold'
  evidence: string
}

export type { Read }

const UPSERT = `INSERT INTO accounts (repo, measured_at, maintainers, doors, last_outsider_merge,
  open_pr_age_p50_days, cross_repo_activity, open_loop, pulse, evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (repo, measured_at) DO UPDATE SET maintainers = excluded.maintainers, doors = excluded.doors,
    last_outsider_merge = excluded.last_outsider_merge, open_pr_age_p50_days = excluded.open_pr_age_p50_days,
    cross_repo_activity = excluded.cross_repo_activity, open_loop = excluded.open_loop,
    pulse = excluded.pulse, evidence = excluded.evidence`

export function measure(db: Db, repo: string, today: string, read: Read = gh): Pulse {
  const row = pulseOf(repo, today, read, planOpen(db, repo))
  db.prepare(UPSERT).run(row.repo, row.measured_at, row.maintainers, row.doors, row.last_outsider_merge,
    row.open_pr_age_p50_days, row.cross_repo_activity, row.open_loop ? 1 : 0, row.pulse, row.evidence)
  return row
}

export function planOpen(db: Db, repo: string): boolean {
  return db.prepare(`SELECT 1 FROM plans JOIN targets ON targets.id = plans.target_id
    WHERE targets.repo = ? AND plans.state IN ${LIVE} LIMIT 1`).get(repo) !== undefined
}

export function render(row: Pulse): string {
  return [row.repo, row.measured_at, row.pulse, `maintainers ${String(row.maintainers)}`,
    `doors ${String(row.doors)}`, `last outsider merge ${row.last_outsider_merge ?? '-'}`,
    `open pr age p50 ${String(row.open_pr_age_p50_days)}d`,
    `cross repo ${String(row.cross_repo_activity)}`,
    `open loop ${row.open_loop ? 'yes' : 'no'}`, row.evidence].join('\t').concat('\n')
}

function pulseOf(repo: string, today: string, read: Read, planned: boolean): Pulse {
  const merged = Merged.parse(read(['pr', 'list', '--repo', repo, '--state', 'merged',
    '--limit', String(WINDOW), '--json', 'author,mergedBy,mergedAt']))
  const mergers = logins(merged.map((p) => p.mergedBy))
  const outsiders = merged.filter((p) => p.author !== null && !mergers.includes(p.author.login))
  const last = outsiders.flatMap((p) => (p.mergedAt === null ? [] : [p.mergedAt])).sort().at(-1)?.slice(0, 10) ?? null
  const opened = Opened.parse(read(['pr', 'list', '--repo', repo, '--state', 'open',
    '--limit', String(WINDOW), '--json', 'createdAt,headRepositoryOwner']))
  const age = p50(opened.map((p) => days(today, p.createdAt)))
  const loop = planned || opened.some((p) => ours(p.headRepositoryOwner?.login))
  return {
    repo,
    measured_at: today,
    maintainers: mergers.length,
    doors: logins(outsiders.map((p) => p.mergedBy)).length,
    last_outsider_merge: last,
    open_pr_age_p50_days: age,
    cross_repo_activity: elsewhere(repo, mergers, read),
    open_loop: loop,
    pulse: cold(today, last, age, loop) ? 'cold' : 'warm',
    evidence: `https://github.com/${repo}/pulse`,
  }
}

function cold(today: string, last: string | null, age: number, loop: boolean): boolean {
  if (last === null || days(today, last) > COLD_DAYS) return true
  return age > COLD_DAYS && !loop
}

/** A maintainer is someone the repo let press merge; a door is one who has pressed it for an outsider. */
function logins(who: ({ login: string } | null)[]): string[] {
  return [...new Set(who.flatMap((w) => (w === null ? [] : [w.login])))]
}

/** What the people holding the merge button are doing elsewhere, which is where our pull request is waiting behind. */
function elsewhere(repo: string, mergers: string[], read: Read): number {
  const seen = mergers.slice(0, SEARCHES).flatMap((who) => Elsewhere
    .parse(read(['search', 'prs', '--author', who, '--merged', '--limit', String(SEARCHES), '--json', 'repository']))
    .map((r) => r.repository.nameWithOwner))
  return new Set(seen.filter((r) => r !== repo)).size
}

function days(today: string, at: string): number {
  return Math.max(0, Math.floor((Date.parse(today) - Date.parse(at)) / 86400000))
}

function p50(ages: number[]): number {
  const sorted = [...ages].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0
}
