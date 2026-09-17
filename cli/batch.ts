import { headOf, prBody } from '../sequencer/push.ts'
import { cloned, diffOf, srcDir } from '../sequencer/workspace.ts'
import { decide, digestOf, headDigest } from '../store/approvals.ts'
import type { Db } from '../store/index.ts'
import { bytes, byId, open as openProposals, stamp, strike, type ProposalRow } from '../store/proposals.ts'

export interface Mark { name: string; ok: boolean }

export interface Card {
  kind: 'plan' | 'proposal'
  id: number
  title: string
  digest: string
  change: string
  text: string
  marks: Mark[]
}

const GATES = ['pre_review', 'review', 'senior_review', 'ready'] as const

export function batch(db: Db, root: string): Card[] {
  return [...planCards(db, root), ...proposalCards(db)]
}

/** The approval row and the row it settles land together or not at all; a half-signed card cannot be re-signed. */
export function approve(db: Db, root: string, kind: 'plan' | 'proposal', id: number): string {
  const card = cardOf(db, root, kind, id)
  db.transaction(() => {
    decide(db, kind, id, card.digest, null)
    if (kind === 'proposal') settle(db, id)
  })()
  return card.digest
}

/** Approved becomes a row. For a ruling that row is `rulings`; the issue is the step, the row is the record. */
function settle(db: Db, id: number): void {
  const p = byId(db, id)
  if (p === null) throw new Error(`no proposal ${String(id)}`)
  if (p.class === 'ruling') ruling(db, p)
  stamp(db, id)
}

function ruling(db: Db, p: ProposalRow): void {
  if (p.match_issue_no === null) throw new Error(`proposal ${String(p.id)} names no issue; file it before approving`)
  db.prepare(`INSERT INTO rulings (subject, value, origin_kind, origin_ref, who, date, issue_no, supersedes)
    VALUES (?, ?, 'ruling', ?, 'ceo', ?, ?, ?)`)
    .run(p.subject, p.value, p.evidence, new Date().toISOString().slice(0, 10), p.match_issue_no, p.match_ruling_id)
}

export function refuse(db: Db, root: string, kind: 'plan' | 'proposal', id: number, reason: string): string {
  const card = cardOf(db, root, kind, id)
  db.transaction(() => {
    decide(db, kind, id, card.digest, reason)
    if (kind === 'proposal') strike(db, id)
  })()
  return card.digest
}

export function render(card: Card): string {
  const marks = card.marks.map((m) => `  ${m.ok ? 'green' : 'red'}\t${m.name}`).join('\n')
  return `${card.kind} ${String(card.id)}\t${card.title}\t${card.digest.slice(0, 12)}\n${card.change}\n${card.text}\n${marks}\n`
}

function cardOf(db: Db, root: string, kind: 'plan' | 'proposal', id: number): Card {
  const found = batch(db, root).find((c) => c.kind === kind && c.id === id)
  if (found === undefined) throw new Error(`no ${kind} ${String(id)} in the batch`)
  if (found.digest === '') throw new Error(`${kind} ${String(id)} has no bytes on its branch`)
  return found
}

function planCards(db: Db, root: string): Card[] {
  return readyPlans(db).map((p) => (cloned(srcDir(root, p.id)) ? card(db, root, p) : blind(p)))
}

/** A plan with no checkout has no bytes to sign; it stays on the list so the batch says so out loud. */
function blind(p: Ready): Card {
  return {
    kind: 'plan', id: p.id, title: `${p.repo}#${String(p.issue_no)}`, digest: '',
    change: '  no checkout', text: '', marks: [{ name: 'bytes on the branch', ok: false }],
  }
}

function card(db: Db, root: string, p: Ready): Card {
  const head = headOf(root, p.id)
  return {
    kind: 'plan',
    id: p.id,
    title: `${p.repo}#${String(p.issue_no)} ${head.branch}`,
    digest: headDigest(head.sha),
    change: stat(diffOf(root, p.id)),
    text: prBody(p.issue_no, root, p.id).trimEnd(),
    marks: marks(db, p.id),
  }
}

interface Ready { id: number; repo: string; issue_no: number }

function readyPlans(db: Db): Ready[] {
  return db.prepare(`SELECT p.id, t.repo, t.issue_no FROM plans p JOIN targets t ON t.id = p.target_id
    WHERE p.step = 7 AND p.state IN ('queued', 'running', 'blocked_on_ceo') ORDER BY p.queued_at, p.id`)
    .all() as Ready[]
}

function marks(db: Db, plan: number): Mark[] {
  return GATES.map((gate) => ({ name: gate, ok: passed(db, plan, gate) }))
}

function passed(db: Db, plan: number, gate: string): boolean {
  const row = db.prepare('SELECT outcome FROM verdicts WHERE plan = ? AND gate = ? ORDER BY id DESC LIMIT 1')
    .get(plan, gate) as { outcome: string } | undefined
  return row?.outcome === 'pass'
}

function stat(diff: string): string {
  const files = new Set([...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => String(m[1])))
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
  const removed = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length
  return `  ${String(files.size)} file(s)\t+${String(added)}\t-${String(removed)}`
}

function proposalCards(db: Db): Card[] {
  return openProposals(db).map((p) => ({
    kind: 'proposal' as const,
    id: p.id,
    title: `${p.class} ${p.subject}`,
    digest: digestOf(bytes(p)),
    change: `  ${p.subject} = ${p.value}`,
    text: `  evidence ${p.evidence}`,
    marks: [
      { name: 'no ruling it contradicts', ok: p.match_ruling_id === null },
      { name: 'issue on file', ok: p.match_issue_no !== null },
    ],
  }))
}
