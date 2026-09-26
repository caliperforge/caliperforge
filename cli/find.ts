import { z } from 'zod'
import { TEST } from '../sequencer/brief.ts'
import { claimed, implemented, WINDOW, type Read } from './gh.ts'
import { logins, p50 } from './measure.ts'

const Login = z.object({ login: z.string() })

const Issue = z.object({
  number: z.int(),
  title: z.string(),
  body: z.string(),
  state: z.string(),
  url: z.string(),
  author: Login,
  assignees: z.array(Login),
  comments: z.array(z.object({ author: Login, body: z.string(), url: z.string() })),
  closedByPullRequestsReferences: z.array(z.object({ number: z.int() })),
  projectItems: z.array(z.object({ title: z.string() })),
})

const Merged = z.array(z.object({
  url: z.string(),
  author: Login.nullable(),
  mergedBy: Login.nullable(),
  body: z.string(),
  additions: z.int(),
  deletions: z.int(),
  files: z.array(z.object({ path: z.string() })),
}))

const Siblings = z.array(z.object({ url: z.string(), repository: z.object({ nameWithOwner: z.string() }) }))

export const CHECK = '## Target check'

interface Answer { yes: boolean; says: string }

export interface Checked { section: string; park: string | null }

export function find(repo: string, no: number, carded: boolean, read: Read): Checked {
  const row = Issue.parse(read(['issue', 'view', String(no), '--repo', repo, '--json',
    'number,title,body,state,url,author,assignees,comments,closedByPullRequestsReferences,projectItems']))
  const merged = Merged.parse(read(['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', String(WINDOW),
    '--json', 'url,author,mergedBy,body,additions,deletions,files']))
  const mergers = logins(merged.map((p) => p.mergedBy))
  const answers = Object.entries({
    wanted: wanted(row, mergers),
    unclaimed: unclaimed(repo, row, carded, read),
    shape: shape(merged, mergers),
  })
  const lines = answers.map(([q, a]) => `- ${q}: ${a.yes ? 'yes' : 'no'} — ${a.says}`)
  const refused = answers.find(([, a]) => !a.yes)
  return { section: `${CHECK}\n\n${lines.join('\n')}\n`, park: refused === undefined ? null : `${refused[0]}: ${refused[1].says}` }
}

function wanted(row: z.infer<typeof Issue>, mergers: string[]): Answer {
  if (mergers.includes(row.author.login)) return { yes: true, says: `a maintainer opened it ${row.url}` }
  const said = row.comments.find((c) => mergers.includes(c.author.login))
  if (said !== undefined) return { yes: true, says: `a maintainer commented ${said.url}` }
  const board = row.projectItems[0]
  if (board !== undefined) return { yes: true, says: `on the board "${board.title}" ${row.url}` }
  return { yes: false, says: `no maintainer opened or commented on it, and it is on no board ${row.url}` }
}

function unclaimed(repo: string, row: z.infer<typeof Issue>, carded: boolean, read: Read): Answer {
  const claim = claimed(row)
  if (claim !== null) return { yes: false, says: `${claim} ${row.url}` }
  const shipped = carded ? null : implemented(repo, row, read)
  if (shipped !== null) return { yes: false, says: `${shipped} ${shipped.replace(/^\D*#(\d+)\D*$/, `https://github.com/${repo}/pull/$1`)}` }
  const sibling = Siblings.parse(read(['search', 'prs', `${repo}#${String(row.number)}`, '--owner', repo.slice(0, repo.indexOf('/')),
    '--state', 'open', '--json', 'url,repository'])).find((p) => p.repository.nameWithOwner !== repo)
  if (sibling !== undefined) return { yes: false, says: `an open pull request in ${sibling.repository.nameWithOwner} names it ${sibling.url}` }
  return { yes: true, says: `no assignee, claim, closer or sibling pull request ${row.url}` }
}

function shape(merged: z.infer<typeof Merged>, mergers: string[]): Answer {
  const outsiders = merged.filter((p) => p.author !== null && !mergers.includes(p.author.login))
  if (outsiders.length === 0) return { yes: false, says: `no merged outsider PR in the last ${String(WINDOW)} merges` }
  const mid = (of: (p: (typeof outsiders)[number]) => number): string => String(p50(outsiders.map(of)))
  return { yes: true, says: `match p50 ${mid((p) => p.files.length)} files, ${mid((p) => p.additions + p.deletions)} lines, `
    + `${mid((p) => p.files.filter((f) => TEST.test(f.path)).length)} test files, ${mid((p) => p.body.split('\n').length)} body lines: `
    + outsiders.map((p) => p.url).join(' ') }
}
