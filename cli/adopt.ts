import { z } from 'zod'
import { PR_BRANCH, put } from '../sequencer/workspace.ts'
import { adoptedPlan, adoptTarget, heldPlan } from '../store/adopted.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { templatePriority } from '../store/lanes.ts'
import { pipeNamed } from '../store/plans.ts'
import { newestAccount } from '../store/targets.ts'
import { gh, ours, type Read } from './gh.ts'
import { measure } from './measure.ts'
import { parse } from './plan.ts'

const View = z.object({
  number: z.int(),
  url: z.string(),
  state: z.string(),
  title: z.string(),
  body: z.string(),
  closingIssuesReferences: z.array(z.object({ number: z.int() })),
  headRefName: z.string(),
  headRepositoryOwner: z.object({ login: z.string() }).nullable(),
})

const Linked = z.object({ title: z.string(), body: z.string() })

const PR_FIELDS = 'number,url,state,title,body,closingIssuesReferences,headRefName,headRepositoryOwner'

const Account = z.object({ id: z.int(), measured_at: z.string() })

/** The step `templates/pr-path.ts` names `push`. An adopted row stands there without v2 having run it. */
const PUSHED_STEP = 8

interface Adopted {
  target: number
  plan: number
  repo: string
  pr: number
  url: string
  fresh: boolean
}

export function view(repo: string, no: number, read: Read = gh): z.infer<typeof View> {
  return View.parse(read(['pr', 'view', String(no), '--repo', repo, '--json', PR_FIELDS]))
}

/**
 * A pull request v1 opened, taken onto the v2 board so `sequencer/capture.ts` polls it. The row
 * is the watch and nothing more: no deliverable, no proof and no approval, so the batch card still
 * gates anything v2 would push onto the branch afterwards.
 */
export function adopt(db: Db, root: string, ref: string, today: string, read: Read = gh): Adopted {
  const { repo, no } = parse(ref)
  const row = view(repo, no, read)
  const owner = row.headRepositoryOwner?.login
  if (!ours(owner)) throw new Error(`${ref} is pushed from ${owner ?? 'a deleted fork'}, not our fork`)
  const account = accountOf(db, repo, today, read)
  const target = adoptTarget(db, account, repo, row.number, row.url)
  const held = heldPlan(db, target)
  const plan = held ?? file(db, target, row.url)
  put(root, plan, 'issue.md', packet(repo, row, read))
  put(root, plan, PR_BRANCH, `${row.headRefName}\n`)
  return { target, plan, repo, pr: row.number, url: row.url, fresh: held === null }
}

/** Ruling `adopt.issue_packet`: the ask a review rewound onto this plan reads it against. */
function packet(repo: string, row: z.infer<typeof View>, read: Read): string {
  const head = `# ${row.title}\n\n${row.body}\n`
  const no = row.closingIssuesReferences[0]?.number
  if (no === undefined) return head
  const linked = Linked.parse(read(['issue', 'view', String(no), '--repo', repo, '--json', 'title,body']))
  return `${head}\n# ${repo}#${String(no)} ${linked.title}\n\n${linked.body}\n`
}

/** An account nobody has measured is measured now; an old reading is left alone, since the pull request is already open. */
function accountOf(db: Db, repo: string, today: string, read: Read): z.infer<typeof Account> {
  const found = latest(db, repo)
  if (found !== null) return found
  measure(db, repo, today, read)
  const made = latest(db, repo)
  if (made === null) throw new Error(`no accounts row for ${repo} after measuring it`)
  return made
}

function latest(db: Db, repo: string): z.infer<typeof Account> | null {
  const row = newestAccount(db, repo)
  return row === undefined ? null : Account.parse(row)
}

function file(db: Db, target: number, url: string): number {
  const pipe = pipeNamed(db, 'pr-path')
  if (pipe === null) throw new Error('no pipe "pr-path"; cf pipe on pr-path')
  const id = adoptedPlan(db, pipe.id, target, PUSHED_STEP, templatePriority(db, 'pr_path'))
  logged(db, { plan: id, kind: 'filed', actor: 'cf adopt', outcome: 'pass', message: url, pointer: null, run: null })
  return id
}

export function render(row: Adopted): string {
  return `target ${String(row.target)}\tplan ${String(row.plan)}\t${row.repo}#${String(row.pr)}\t${row.url}\t` +
    `${row.fresh ? 'adopted' : 'already watched'}\n`
}
