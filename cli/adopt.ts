import { z } from 'zod'
import { put } from '../sequencer/workspace.ts'
import type { Db } from '../store/index.ts'
import { templatePriority } from '../store/lanes.ts'
import { gh, type Read } from './gh.ts'
import { measure } from './measure.ts'
import { parse } from './plan.ts'

const View = z.object({
  number: z.int(),
  url: z.string(),
  state: z.string(),
  title: z.string(),
  body: z.string(),
  closingIssuesReferences: z.array(z.object({ number: z.int() })),
})

const Linked = z.object({ title: z.string(), body: z.string() })

const PR_FIELDS = 'number,url,state,title,body,closingIssuesReferences'

const Account = z.object({ id: z.int(), measured_at: z.string() })

/** The step `templates/pr-path.ts` names `push`. An adopted row stands there without v2 having run it. */
const PUSHED_STEP = 8

export interface Adopted {
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
  const account = accountOf(db, repo, today, read)
  const target = upsert(db, account, repo, row.number, row.url)
  const held = db.prepare('SELECT id FROM plans WHERE target_id = ? ORDER BY id LIMIT 1').get(target) as
    { id: number } | undefined
  const plan = held?.id ?? file(db, target)
  put(root, plan, 'issue.md', packet(repo, row, read))
  return { target, plan, repo, pr: row.number, url: row.url, fresh: held === undefined }
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
  const row = db.prepare('SELECT id, measured_at FROM accounts WHERE repo = ? ORDER BY measured_at DESC LIMIT 1').get(repo)
  return row === undefined ? null : Account.parse(row)
}

/** On github a pull request and an issue share one number space, so `targets.issue_no` holds the pull number. */
function upsert(db: Db, account: z.infer<typeof Account>, repo: string, no: number, url: string): number {
  db.prepare(`INSERT INTO targets (account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence, ineligible_ruling_id)
    VALUES (?, ?, ?, '', 'queued', ?, ?, NULL)
    ON CONFLICT (repo, issue_no, part) DO UPDATE SET account_id = excluded.account_id, state = 'queued',
      evidence_measured_at = excluded.evidence_measured_at, evidence = excluded.evidence,
      ineligible_ruling_id = NULL`)
    .run(account.id, repo, no, account.measured_at.slice(0, 10), url)
  const row = db.prepare("SELECT id FROM targets WHERE repo = ? AND issue_no = ? AND part = ''").get(repo, no) as { id: number }
  return row.id
}

function file(db: Db, target: number): number {
  const pipe = db.prepare("SELECT id FROM pipes WHERE name = 'pr-path'").get() as { id: number } | undefined
  if (pipe === undefined) throw new Error('no pipe "pr-path"; cf pipe on pr-path')
  const made = db.prepare(`INSERT INTO plans (pipe_id, target_id, template, state, queued_at, step, retries, priority)
    VALUES (?, ?, 'pr_path', 'done', ?, ?, 0, ?)`)
    .run(pipe.id, target, new Date().toISOString(), PUSHED_STEP, templatePriority(db, 'pr_path'))
  return Number(made.lastInsertRowid)
}

export function render(row: Adopted): string {
  return `target ${String(row.target)}\tplan ${String(row.plan)}\t${row.repo}#${String(row.pr)}\t${row.url}\t` +
    `${row.fresh ? 'adopted' : 'already watched'}\n`
}
