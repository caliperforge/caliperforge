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
