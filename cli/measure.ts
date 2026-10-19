import { z } from 'zod'
import type { Db } from '../store/index.ts'
import { loopOpen, putPulse, type Pulse } from '../store/targets.ts'
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

/** `gh search` is rate-limited at 30 a minute, so that is the window `elsewhere()` reads and the number of reads it makes. */
const SEARCHES = 30

export type { Read }

export function measure(db: Db, repo: string, today: string, read: Read = gh): Pulse {
  const row = pulseOf(repo, today, read, loopOpen(db, repo))
  putPulse(db, row)
  return row
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
export function logins(who: ({ login: string } | null)[]): string[] {
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

export function p50(ages: number[]): number {
  const sorted = [...ages].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0
}
