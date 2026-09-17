import { execFileSync } from 'node:child_process'
import { z } from 'zod'

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

const Merged = z.array(z.object({ mergedBy: z.object({ login: z.string() }).nullable() }))

export const CLAIM = /i'?ll take (this|it)|i'?m working on|working on (this|it)|taking this|assign (this )?to me|\/claim|dibs/i

export type Issue = z.infer<typeof Issue>

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

export function implemented(repo: string, row: Issue): string | null {
  const linked = row.closedByPullRequestsReferences[0]?.number
  if (linked !== undefined) return `pull request #${String(linked)} implements it`
  const open = Prs.parse(gh(['pr', 'list', '--repo', repo, '--state', 'open', '--search', `#${String(row.number)}`, '--json', 'number']))
  return open[0] === undefined ? null : `open pull request #${String(open[0].number)} references it`
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
  comments: z.array(z.object({ id: z.string(), author: z.object({ login: z.string() }), body: z.string(), createdAt: z.string() })),
  reviews: z.array(z.object({ id: z.string(), author: z.object({ login: z.string() }), body: z.string(), submittedAt: z.string() })),
  statusCheckRollup: z.array(z.looseObject({ name: z.string().optional(), conclusion: z.string().nullish() })).nullable(),
})

export type Pr = z.infer<typeof Pr>

const PR_FIELDS = 'number,url,state,mergedAt,mergedBy,comments,reviews,statusCheckRollup'

export function pr(repo: string, no: number): Pr {
  return Pr.parse(gh(['pr', 'view', String(no), '--repo', repo, '--json', PR_FIELDS]))
}

export function prNumber(url: string): number {
  const hit = /\/pull\/(\d+)$/.exec(url)
  if (hit === null) throw new Error(`"${url}" is not a github pull request url`)
  return Number(hit[1])
}

/** Opened under the CEO's `gh` credential; the machine holds no account of its own. */
export function openPr(repo: string, head: string, title: string, bodyFile: string): string {
  return execFileSync('gh', ['pr', 'create', '--repo', repo, '--base', 'main', '--head', head,
    '--title', title, '--body-file', bodyFile], { encoding: 'utf8' }).trim()
}

export function searchIssue(repo: string, subject: string): number | null {
  const found = Prs.parse(gh(['issue', 'list', '--repo', repo, '--search', subject, '--state', 'all', '--json', 'number']))
  return found[0]?.number ?? null
}
