import { pr as readPr, prNumber, type Pr } from '../cli/gh.ts'
import type { Db } from '../store/index.ts'
import { record, type Signal, type SignalRow } from '../store/signals.ts'
import { attribute } from './escapes.ts'

interface Pushed { plan: number; repo: string; evidence: string }

type Base = Pick<Signal, 'repo' | 'pr' | 'plan'>

const BOT = /\[bot\]$|greptile/i

const SCORE = /(\d)\s*\/\s*5/

/** Greptile's summary names its score; any other `n/5` in the body is taken only where this is absent. */
const CONFIDENCE = /Confidence Score:\s*(\d)\s*\/\s*5/i

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
  return acted(db, view, fresh)
}

/**
 * The ruling `signals.left_alone` names the review decision that is as good as merged: what lands
 * on such a pull request is recorded and starts nothing, and the merge is the one signal left.
 */
function acted(db: Db, view: Pr, fresh: SignalRow[]): SignalRow[] {
  const ruled = db.prepare("SELECT value FROM rulings WHERE subject = 'signals.left_alone' ORDER BY id DESC LIMIT 1")
    .get() as { value: string }
  return view.reviewDecision?.toLowerCase() === ruled.value ? fresh.filter((s) => s.kind === 'merge') : fresh
}

/** Everything on our open pull request but what we said ourselves: our own comment asks nothing of us. */
export function signals(view: Pr, row: Pushed): Signal[] {
  const base: Base = { repo: row.repo, pr: view.number, plan: row.plan }
  const theirs = (login: string): boolean => login !== view.author?.login
  return [
    ...view.comments.filter((c) => theirs(c.author.login)).map((c) => comment(base, c)),
    ...view.reviews.filter((r) => theirs(r.author.login)).map((r) => review(base, r)),
    ...merged(base, view),
    ...red(base, view),
  ]
}

/** #103: a review bot's summary comment carries its score as its review would; only a person's comment asks something of us. */
function comment(base: Base, c: Pr['comments'][number]): Signal {
  const bot = BOT.test(c.author.login)
  return { ...base, kind: bot ? 'bot_review' : 'comment', author: c.author.login, at: c.createdAt, external_id: c.id,
    score: bot ? scored(c.body) : null, body: c.body }
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
    body: r.body,
    state: r.state ?? null,
  }
}

/** A bot review with no `n/5` states no verdict; the CHECK on `signals` drops the row rather than let it rewind the plan. */
function scored(body: string): number | null {
  const hit = (CONFIDENCE.exec(body) ?? SCORE.exec(body))?.[1]
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
      external_id: `${String(view.number)}-${c.name ?? 'check'}`, score: null,
      body: `their CI check ${c.name ?? 'check'} is red on the pull request` }))
}

/**
 * The two ways a pull request of ours becomes one the tick watches: v2 pushed it and stamped the
 * deliverable, or `cf adopt` named a v1 one and its `targets` row carries the pull url. Either
 * marker outlives a rewind, so a plan back on the review step is still read every tick.
 */
function pushed(db: Db): Pushed[] {
  return db.prepare(`SELECT d.plan_id AS plan, t.repo, d.evidence
    FROM deliverables d JOIN plans p ON p.id = d.plan_id JOIN targets t ON t.id = p.target_id
    WHERE d.state = 'pushed' AND d.evidence GLOB 'https://*/pull/*'
    UNION
    SELECT p.id AS plan, t.repo, t.evidence
    FROM plans p JOIN targets t ON t.id = p.target_id
    WHERE t.evidence GLOB 'https://*/pull/*'
    ORDER BY plan`).all() as Pushed[]
}
