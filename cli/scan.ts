import { z } from 'zod'
import type { Db } from '../store/index.ts'
import { cardOf, putReady } from '../store/targets.ts'
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
  const targets = issues.flatMap((i) => {
    const pr = prs.find((p) => mentions(`${p.title}\n${p.body}`, i.number))
    const id = putReady(db, { account_id: pulse.id, repo, issue_no: i.number, named_merger: merger,
      evidence_measured_at: pulse.measured_at.slice(0, 10), evidence: i.url, issue_opened_at: i.createdAt.slice(0, 10),
      issue_active_at: i.updatedAt.slice(0, 10), open_pr: pr?.number ?? null,
      open_pr_draft: pr === undefined ? null : Number(pr.isDraft),
      size_lines: i.body.split('\n').filter((l) => l.trim() !== '').length })
    return id === undefined ? [] : [id]
  })
  return { targets, why: null }
}

export function render(db: Db, id: number): string {
  const t = cardOf(db, id)
  const pr = t.open_pr === null ? 'no open pr' : `pr #${String(t.open_pr)}${t.open_pr_draft === 1 ? ' draft' : ''}`
  return [`${t.repo}#${String(t.issue_no)}`, `merger ${t.named_merger}`, `opened ${t.issue_opened_at}`,
    `active ${t.issue_active_at}`, pr, `${String(t.size_lines)} lines`, t.evidence].join('\t').concat('\n')
}
