import { execFileSync } from 'node:child_process'
import { z } from 'zod'
import { FORK } from '../sequencer/workspace.ts'

const Issue = z.object({
  number: z.int(),
  title: z.string(),
  body: z.string(),
  state: z.string(),
  assignees: z.array(z.object({ login: z.string() })),
  comments: z.array(z.object({ body: z.string() })),
  closedByPullRequestsReferences: z.array(z.object({ number: z.int() })),
})

const Prs = z.array(z.object({ number: z.int() }))

const Refs = z.array(z.object({
  number: z.int(),
  title: z.string(),
  body: z.string(),
  headRepositoryOwner: z.object({ login: z.string() }).nullable(),
}))

const Head = z.object({ headRepositoryOwner: z.object({ login: z.string() }).nullable() })

const Merged = z.array(z.object({ mergedBy: z.object({ login: z.string() }).nullable() }))

export const CLAIM = /i'?ll take (this|it)|i'?m working on|working on (this|it)|taking this|assign (this )?to me|\/claim|dibs/i

/** One page. Left off, `gh pr list` stops at 30 rows and anything past the cap is never read. */
export const WINDOW = 100

export type Issue = z.infer<typeof Issue>

export type Read = (args: string[]) => unknown

export function gh(args: string[]): unknown {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8' })) as unknown
}

export function issue(repo: string, no: number): Issue {
  return Issue.parse(gh(['issue', 'view', String(no), '--repo', repo, '--json',
    'number,title,body,state,assignees,comments,closedByPullRequestsReferences']))
}

export function claimed(row: Issue): string | null {
  const who = row.assignees[0]?.login
  if (who !== undefined) return `assigned to ${who}`
  return row.comments.some((c) => CLAIM.test(c.body)) ? 'a comment claims the issue' : null
}

export function ours(login: string | null | undefined): boolean {
  return login === FORK
}

/** Every open pull request the issue's number turns up in, minus the ones pushed from our own fork. */
export function foreign(repo: string, no: number, read: Read = gh): z.infer<typeof Refs> {
  return Refs.parse(read(['pr', 'list', '--repo', repo, '--state', 'open', '--search', `#${String(no)}`,
    '--limit', String(WINDOW), '--json', 'number,title,body,headRepositoryOwner']))
    .filter((p) => !ours(p.headRepositoryOwner?.login))
}

export function implemented(repo: string, row: Issue, read: Read = gh): string | null {
  const linked = row.closedByPullRequestsReferences
    .find((p) => !ours(headOwner(repo, p.number, read)))?.number
  if (linked !== undefined) return `pull request #${String(linked)} implements it`
  const open = foreign(repo, row.number, read).find((p) => mentions(`${p.title}\n${p.body}`, row.number))
  return open === undefined ? null : `open pull request #${String(open.number)} references it`
}

/**
 * The search is full text over the whole thread, so a bystander's pull request surfaces on a comment
 * of ours that cites the issue. Only the pull request's own text is somebody else's claim on it.
 */
function mentions(text: string, no: number): boolean {
  return new RegExp(`#${String(no)}(?!\\d)`).test(text)
}

/** The linked-closer list carries the base repository, not the head, so the head is read per pull request. */
function headOwner(repo: string, no: number, read: Read): string | null {
  return Head.parse(read(['pr', 'view', String(no), '--repo', repo, '--json', 'headRepositoryOwner']))
    .headRepositoryOwner?.login ?? null
}

export function lastMerger(repo: string): string | null {
  const merged = Merged.parse(gh(['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '1', '--json', 'mergedBy']))
  return merged[0]?.mergedBy?.login ?? null
}

const Pr = z.object({
  number: z.int(),
  url: z.string(),
  state: z.string(),
  mergedAt: z.string().nullable(),
  mergedBy: z.object({ login: z.string() }).nullable(),
  reviewDecision: z.string().nullable(),
  comments: z.array(z.object({ id: z.string(), author: z.object({ login: z.string() }), body: z.string(), createdAt: z.string() })),
  reviews: z.array(z.object({ id: z.string(), author: z.object({ login: z.string() }), body: z.string(), submittedAt: z.string(),
    state: z.string().optional() })),
  author: z.object({ login: z.string() }).optional(),
  statusCheckRollup: z.array(z.looseObject({ name: z.string().optional(), conclusion: z.string().nullish() })).nullable(),
})

export type Pr = z.infer<typeof Pr>

const PR_FIELDS = 'number,url,state,mergedAt,mergedBy,reviewDecision,comments,reviews,statusCheckRollup,author'

export function pr(repo: string, no: number): Pr {
  return Pr.parse(gh(['pr', 'view', String(no), '--repo', repo, '--json', PR_FIELDS]))
}

export function prNumber(url: string): number {
  const hit = /\/pull\/(\d+)$/.exec(url)
  if (hit === null) throw new Error(`"${url}" is not a github pull request url`)
  return Number(hit[1])
}

/**
 * Their CI runs on pull requests, not on a pushed branch, so a pull request on our own fork is what
 * starts it. Its title and body name nothing upstream: a number there would put a permanent
 * "mentioned" line on the maintainer's thread.
 */
export function rehearse(fork: string, branch: string): void {
  if (rehearsal(fork, branch) !== null) return
  try {
    execFileSync('gh', ['repo', 'sync', fork, '--branch', 'main'], { encoding: 'utf8', stdio: 'pipe' })
  } catch {
    // a fork main that cannot fast-forward still carries the branch's own CI
  }
  execFileSync('gh', ['pr', 'create', '--repo', fork, '--base', 'main', '--head', branch,
    '--title', 'CI rehearsal only (do not merge)', '--body', 'Fork CI only. Do not merge.'], { encoding: 'utf8' })
}

/** Closed with no comment and the branch kept: the branch is the head the real pull request opens from. */
export function unrehearse(fork: string, branch: string): void {
  const no = rehearsal(fork, branch)
  if (no !== null) execFileSync('gh', ['pr', 'close', String(no), '--repo', fork], { encoding: 'utf8' })
}

function rehearsal(fork: string, branch: string): number | null {
  const open = z.array(z.object({ number: z.int() })).parse(gh(['pr', 'list', '--repo', fork, '--head', branch,
    '--state', 'open', '--json', 'number']))
  return open[0]?.number ?? null
}

/** Opened under the CEO's `gh` credential; the machine holds no account of its own. */
export function openPr(repo: string, head: string, title: string, bodyFile: string): string {
  return execFileSync('gh', ['pr', 'create', '--repo', repo, '--base', 'main', '--head', head,
    '--title', title, '--body-file', bodyFile], { encoding: 'utf8' }).trim()
}

/** #35 rule 1: an internal plan is closed by the commit that landed it on `main`, not by a pull request. */
export function closeIssue(repo: string, no: number, sha: string): void {
  execFileSync('gh', ['issue', 'close', String(no), '--repo', repo, '--comment', `landed on main as ${sha}`],
    { encoding: 'utf8' })
}

export function searchIssue(repo: string, subject: string): number | null {
  const found = Prs.parse(gh(['issue', 'list', '--repo', repo, '--search', subject, '--state', 'all', '--json', 'number']))
  return found[0]?.number ?? null
}
