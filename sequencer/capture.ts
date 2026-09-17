import { pr as readPr, prNumber, type Pr } from '../cli/gh.ts'
import type { Db } from '../store/index.ts'
import { record, type Signal, type SignalRow } from '../store/signals.ts'
import { attribute } from './escapes.ts'

interface Pushed { plan: number; repo: string; evidence: string }

type Base = Pick<Signal, 'repo' | 'pr' | 'plan'>

const BOT = /\[bot\]$|greptile/i

const SCORE = /(\d)\s*\/\s*5/

/** Every open PR of ours, every tick. `gh` polling is the only reader; there is no webhook and no server. */
export function capture(db: Db, read: (repo: string, no: number) => Pr = readPr): SignalRow[] {
  return pushed(db).flatMap((row) => reachable(db, row, read))
}

/** A pr `gh` cannot reach this tick is read again next tick; it does not stop the pipes behind it. */
function reachable(db: Db, row: Pushed, read: (repo: string, no: number) => Pr): SignalRow[] {
  try {
    return one(db, row, read)
  } catch {
    return []
  }
}

function one(db: Db, row: Pushed, read: (repo: string, no: number) => Pr): SignalRow[] {
  const view = read(row.repo, prNumber(row.evidence))
  const fresh = signals(view, row).map((s) => record(db, s)).filter((s) => s !== null)
  attribute(db, row.plan, view)
  return fresh
}

export function signals(view: Pr, row: Pushed): Signal[] {
  const base: Base = { repo: row.repo, pr: view.number, plan: row.plan }
  return [
    ...view.comments.map((c) => ({ ...base, kind: 'comment' as const, author: c.author.login,
      at: c.createdAt, external_id: c.id, score: null })),
    ...view.reviews.map((r) => review(base, r)),
    ...merged(base, view),
    ...red(base, view),
  ]
}

function review(base: Base, r: Pr['reviews'][number]): Signal {
  const bot = BOT.test(r.author.login)
  return {
    ...base,
    kind: bot ? 'bot_review' : 'review',
    author: r.author.login,
    at: r.submittedAt,
    external_id: r.id,
    score: bot ? scored(r.body) : null,
  }
}

/** A bot review with no `n/5` states no verdict; the CHECK on `signals` drops the row rather than let it rewind the plan. */
function scored(body: string): number | null {
  const hit = SCORE.exec(body)?.[1]
  return hit === undefined ? null : Number(hit)
}

function merged(base: Base, view: Pr): Signal[] {
  if (view.mergedAt === null) return []
  return [{ ...base, kind: 'merge', author: view.mergedBy?.login ?? 'unknown', at: view.mergedAt,
    external_id: `merge-${String(view.number)}`, score: null }]
}

function red(base: Base, view: Pr): Signal[] {
  return (view.statusCheckRollup ?? [])
    .filter((c) => c.conclusion === 'FAILURE')
    .map((c) => ({ ...base, kind: 'ci_red' as const, author: 'ci', at: new Date().toISOString(),
      external_id: `${String(view.number)}-${c.name ?? 'check'}`, score: null }))
}

function pushed(db: Db): Pushed[] {
  return db.prepare(`SELECT d.plan_id AS plan, t.repo, d.evidence
    FROM deliverables d JOIN plans p ON p.id = d.plan_id JOIN targets t ON t.id = p.target_id
    WHERE d.state = 'pushed' AND d.evidence GLOB 'https://*/pull/*' ORDER BY d.id`).all() as Pushed[]
}
