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

export function rehearsal(fork: string, branch: string, read: Read = gh): number | null {
  const open = z.array(z.object({ number: z.int() })).parse(read(['pr', 'list', '--repo', fork, '--head', branch,
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

/** #72: a part of a split ticket, filed on our repo under the CEO's credential; the url is the part's name from here on. */
export function fileIssue(repo: string, title: string, body: string, labels: string[]): string {
  return execFileSync('gh', ['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-',
    ...labels.flatMap((l) => ['--label', l])], { encoding: 'utf8', input: body }).trim()
}

export function commentIssue(repo: string, no: number, body: string): void {
  execFileSync('gh', ['issue', 'comment', String(no), '--repo', repo, '--body-file', '-'], { encoding: 'utf8', input: body })
}

export function searchIssue(repo: string, subject: string): number | null {
  const found = Prs.parse(gh(['issue', 'list', '--repo', repo, '--search', subject, '--state', 'all', '--json', 'number']))
  return found[0]?.number ?? null
}

/** The CEO's three answers to a sign-off card, as labels on our own repo. */
export type Answer = 'go' | 'no' | 'talk'

export const ANSWERS: readonly Answer[] = ['go', 'no', 'talk']

const LOOKS: Record<Answer, { color: string; says: string }> = {
  go: { color: '2da44e', says: 'Sign-off: send it' },
  no: { color: 'cf222e', says: 'Sign-off: refuse it; a comment goes to the builder' },
  talk: { color: 'bf8700', says: 'Sign-off: hand it to the COO' },
}

/** What a card says back: the answer the owner's label gives, the owner's comments, and whether it is still open. */
export interface Seen { answer: Answer | null; words: string | null; open: boolean }

/** The tracker the sign-off cards live on, a seam so a test answers a card without the network. */
export interface Desk {
  open: (title: string, body: string) => { no: number; url: string }
  seen: (no: number) => Seen
  unlabel: (no: number, label: Answer) => void
  close: (no: number, comment: string) => void
}

export type Run = (args: string[], input?: string) => string

const Card = z.object({
  state: z.string(),
  labels: z.array(z.object({ name: z.string() })),
  comments: z.array(z.object({ author: z.object({ login: z.string() }), body: z.string() })),
})

const Events = z.array(z.looseObject({
  event: z.string(),
  actor: z.object({ login: z.string() }).nullable(),
  label: z.object({ name: z.string() }).optional(),
}))

function run(args: string[], input?: string): string {
  return execFileSync('gh', args, { encoding: 'utf8', ...(input === undefined ? {} : { input }) })
}

/**
 * Only the label the owner of this host's `gh` credential set is an answer: the machine holds no account of
 * its own, and a collaborator's label is not the CEO's word, on the private card repo (#102) as anywhere.
 */
export function desk(repo: string, read: Read = gh, exec: Run = run): Desk {
  let owner: string | null = null
  const me = (): string => (owner ??= exec(['api', 'user', '--jq', '.login']).trim())
  return {
    open: (title, body) => {
      for (const name of ANSWERS) {
        exec(['label', 'create', name, '--repo', repo, '--color', LOOKS[name].color, '--description', LOOKS[name].says, '--force'])
      }
      const url = exec(['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-'], body).trim()
      return { no: issueNo(url), url }
    },
    seen: (no) => {
      const card = Card.parse(read(['issue', 'view', String(no), '--repo', repo, '--json', 'state,labels,comments']))
      const on = new Set(card.labels.map((l) => l.name))
      const ours = Events.parse(read(['api', `repos/${repo}/issues/${String(no)}/events?per_page=100`]))
        .filter((e) => e.event === 'labeled' && e.actor?.login === me())
        .map((e) => e.label?.name)
        .filter((n): n is Answer => n !== undefined && on.has(n) && (ANSWERS as readonly string[]).includes(n))
      const said = card.comments.filter((c) => c.author.login === me()).map((c) => c.body.trim()).filter((b) => b !== '')
      return { answer: ours.at(-1) ?? null, words: said.length === 0 ? null : said.join('\n\n'), open: card.state === 'OPEN' }
    },
    unlabel: (no, label) => void exec(['issue', 'edit', String(no), '--repo', repo, '--remove-label', label]),
    close: (no, comment) => void exec(['issue', 'close', String(no), '--repo', repo, '--comment', comment]),
  }
}

function issueNo(url: string): number {
  const hit = /\/issues\/(\d+)$/.exec(url)
  if (hit === null) throw new Error(`"${url}" is not a github issue url`)
  return Number(hit[1])
}
