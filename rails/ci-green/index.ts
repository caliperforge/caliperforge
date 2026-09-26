import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Verdict } from '../record.ts'

const Run = z.object({
  headSha: z.string(),
  status: z.string(),
  conclusion: z.string(),
  url: z.string(),
  workflowName: z.string(),
})

const Runs = z.array(Run)

type Run = z.infer<typeof Run>

const QUALIFIED = /\b([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#\d+\b/g
const URL = /https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(?:issues|pull)\/\d+/g
const BARE = /(?:^|[^A-Za-z0-9._/-])#\d+\b/

/** A push starts every workflow at once, so one page holds every run the head has. */
const WINDOW = 100

/** The span a run that has not finished carries; its caller waits on that rather than refusing. */
export const PENDING = 'ci.pending'

/** The span a head with no run at all carries. A push's runs appear after it returns, so a caller waits on this too. */
export const MISSING = 'ci.missing'

export interface Head {
  fork: string
  branch: string
  sha: string
}

export interface Text {
  body: string
  commits: string[]
}

export type Gh = (args: string[]) => string

/** One run at the head as the sign-off card shows it; `gates` is whether the verdict counts it; `base`, the `<job>: <step>` red at the last green head too. */
export interface Board { workflow: string; status: string; conclusion: string; gates: boolean; base?: string[] }

export function ciGreen(head: Head, text: Text, touched: string[], gh: Gh = shell): Verdict {
  return judge(head, text, touched, gh).verdict
}

/**
 * The verdict and every run at the head, off one listing: the ready gate waits on the whole board, and
 * the card shows it, while only the runs `mine()` keeps can refuse the branch.
 */
export function judge(head: Head, text: Text, touched: string[], gh: Gh = shell): { verdict: Verdict; board: Board[] } {
  const listed = list(head, gh)
  const at = listed?.filter((r) => r.headSha === head.sha) ?? []
  const judged = new Set(mine(at, touched))
  const board = at.map((r) => ({ workflow: r.workflowName, status: r.status, conclusion: r.conclusion, gates: judged.has(r) }))
  return { verdict: verdictOf(head, text, listed === null ? null : [...judged]), board }
}

function verdictOf(head: Head, text: Text, judged: Run[] | null): Verdict {
  const ours = head.fork.split('/')[0] ?? head.fork
  const spans = [...runs(head, judged), ...upstream(text, ours)]
  const subject_digest = createHash('sha256').update(`${head.fork}\n${head.branch}\n${head.sha}`).digest('hex')
  if (spans.length === 0) return { outcome: 'pass', defect_class: null, origin_kind: null, origin_ref: null, subject_digest, spans, message: `${head.fork}@${head.sha} is green and names no upstream number` }
  return {
    outcome: 'refuse', defect_class: null,
    origin_kind: 'rail',
    origin_ref: 'ci-green',
    subject_digest,
    spans,
    message: `${String(spans.length)} span(s): fork CI not green for the branch head, or an upstream number named`,
  }
}

export function list(head: Head, gh: Gh): Run[] | null {
  const listed = Runs.safeParse(JSON.parse(gh([
    'run', 'list', '--repo', head.fork, '--branch', head.branch,
    '--limit', String(WINDOW), '--json', 'headSha,status,conclusion,url,workflowName',
  ])))
  return listed.success ? listed.data : null
}

function runs(head: Head, judged: Run[] | null): string[] {
  if (judged === null) return [`${head.fork}:${head.branch} ci.unreadable`]
  if (judged.length === 0) return [`${head.fork}:${head.sha} ${MISSING}`]
  return judged.flatMap(read)
}

/**
 * A repository with a workflow per language starts them all on every push, and one the diff never
 * touched going red judges no branch of ours. The diff's top path segments are the languages it
 * names; where none of them names a workflow, every run at the head is the branch's own.
 */
function mine(at: Run[], touched: string[]): Run[] {
  const languages = new Set(touched.map((path) => path.split('/')[0]?.toLowerCase()))
  const named = at.filter((r) => languages.has(r.workflowName.toLowerCase()))
  return named.length === 0 ? at : named
}

function read(run: Run): string[] {
  if (run.status !== 'completed') return [`${run.url} ${PENDING}`]
  return run.conclusion === 'success' ? [] : [`${run.url} ci.red`]
}

function upstream(text: Text, ours: string): string[] {
  return [
    ...lines(text.body).filter((l) => foreign(l.text, ours)).map((l) => `body:${String(l.at)} upstream.number`),
    ...text.commits.map((text, index) => ({ text, at: index + 1 })).filter((c) => foreign(c.text, ours)).map((c) => `commit:${String(c.at)} upstream.number`),
  ]
}

function lines(text: string): { text: string; at: number }[] {
  return text.split('\n').map((line, index) => ({ text: line, at: index + 1 }))
}

function foreign(text: string, ours: string): boolean {
  const qualified = [...text.matchAll(QUALIFIED), ...text.matchAll(URL)]
  return qualified.some((m) => m[1] !== ours) || BARE.test(text)
}

export function shell(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' })
}
