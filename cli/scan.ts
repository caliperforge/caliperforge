import { z } from 'zod'
import type { Db } from '../store/index.ts'
import { gh, lastMerger, mentions, ours, WINDOW, type Read } from './gh.ts'
import { measure } from './measure.ts'
import { account } from './queue.ts'
import { still } from './record.ts'

const Issues = z.array(z.object({
  number: z.int(),
  body: z.string(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
}))

const Prs = z.array(z.object({
  number: z.int(),
  title: z.string(),
  body: z.string(),
  isDraft: z.boolean(),
  headRepositoryOwner: z.object({ login: z.string() }).nullable(),
}))

export interface Scanned { targets: number[]; why: string | null }

interface Target {
  repo: string
  issue_no: number
  named_merger: string
  issue_opened_at: string
  issue_active_at: string
  open_pr: number | null
  open_pr_draft: number | null
  size_lines: number
  evidence: string
}

const UPSERT = `INSERT INTO targets (account_id, repo, issue_no, part, named_merger, state, evidence_measured_at, evidence,
  issue_opened_at, issue_active_at, open_pr, open_pr_draft, size_lines) VALUES (?, ?, ?, '', ?, 'ready', ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (repo, issue_no, part) DO UPDATE SET account_id = excluded.account_id, named_merger = excluded.named_merger,
    evidence_measured_at = excluded.evidence_measured_at, evidence = excluded.evidence,
    issue_opened_at = excluded.issue_opened_at, issue_active_at = excluded.issue_active_at, open_pr = excluded.open_pr,
    open_pr_draft = excluded.open_pr_draft, size_lines = excluded.size_lines
  WHERE targets.state = 'ready'
  RETURNING id`

export function scan(db: Db, repo: string, today: string, read: Read = gh): Scanned {
  const open = still(db, repo)
  if (open >= 2) return { targets: [], why: `${repo} has ${String(open)} pull requests of ours open and unmerged` }
  const merger = lastMerger(repo, read)
  if (merger === null) return { targets: [], why: `${repo} has no named merger` }
  measure(db, repo, today, read)
  const pulse = account(db, repo, today)
  const issues = Issues.parse(read(['issue', 'list', '--repo', repo, '--state', 'open', '--limit', String(WINDOW),
    '--json', 'number,body,url,createdAt,updatedAt']))
  const prs = Prs.parse(read(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(WINDOW),
    '--json', 'number,title,body,isDraft,headRepositoryOwner']))
    .filter((p) => !ours(p.headRepositoryOwner?.login))
    .sort((a, b) => a.number - b.number)
  const put = db.prepare(UPSERT)
  const targets = issues.flatMap((i) => {
    const pr = prs.find((p) => mentions(`${p.title}\n${p.body}`, i.number))
    const row = put.get(pulse.id, repo, i.number, merger, pulse.measured_at.slice(0, 10), i.url, i.createdAt.slice(0, 10),
      i.updatedAt.slice(0, 10), pr?.number ?? null, pr === undefined ? null : Number(pr.isDraft),
      i.body.split('\n').filter((l) => l.trim() !== '').length) as { id: number } | undefined
    return row === undefined ? [] : [row.id]
  })
  return { targets, why: null }
}

export function render(db: Db, id: number): string {
  const t = db.prepare(`SELECT repo, issue_no, named_merger, issue_opened_at, issue_active_at, open_pr, open_pr_draft,
    size_lines, evidence FROM targets WHERE id = ?`).get(id) as Target
  const pr = t.open_pr === null ? 'no open pr' : `pr #${String(t.open_pr)}${t.open_pr_draft === 1 ? ' draft' : ''}`
  return [`${t.repo}#${String(t.issue_no)}`, `merger ${t.named_merger}`, `opened ${t.issue_opened_at}`,
    `active ${t.issue_active_at}`, pr, `${String(t.size_lines)} lines`, t.evidence].join('\t').concat('\n')
}
