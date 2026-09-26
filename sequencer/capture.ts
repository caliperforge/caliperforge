import { z } from 'zod'
import { pr as readPr, prNumber, rehearsal, WINDOW, type Pr, type Read } from '../cli/gh.ts'
import { add, LANE, LANES, laneOf, seen } from '../cli/plan.ts'
import type { Db } from '../store/index.ts'
import { originRef, PlanRow } from '../store/plans.ts'
import { record, type Signal, type SignalRow } from '../store/signals.ts'
import { partOf, recordListing } from '../store/tickets.ts'
import { attribute } from './escapes.ts'
import { rehearsalBranch } from './push.ts'
import { claimed, released } from './split.ts'
import { cloned, FORK, repoName, srcDir } from './workspace.ts'

const Listed = z.array(z.object({
  number: z.int(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  labels: z.array(z.object({ name: z.string() })),
}))

interface Pushed { plan: number; repo: string; evidence: string; rehearsal: boolean }

type Base = Pick<Signal, 'repo' | 'pr' | 'plan'>

export const BOT = /\[bot\]$|greptile/i

const SCORE = /(\d)\s*\/\s*5/

/** Greptile's summary names its score; any other `n/5` in the body is taken only where this is absent. */
const CONFIDENCE = /Confidence Score:\s*(\d)\s*\/\s*5/i

const REVIEWED = /Last reviewed commit: \[[^\]]*\]\(https:\/\/github\.com\/[^/)]+\/[^/)]+\/commit\/([0-9a-f]{40})\)/

/** Every open PR of ours, every tick. `gh` polling is the only reader; there is no webhook and no server. */
export function capture(db: Db, read: (repo: string, no: number) => Pr = readPr, root?: string, list?: Read): SignalRow[] {
  return pushed(db, root, list).flatMap((row) => reachable(db, row, read))
}

/** A pr `gh` cannot reach this tick is read again next tick; it does not stop the pipes behind it. */
function reachable(db: Db, row: Pushed, read: (repo: string, no: number) => Pr): SignalRow[] {
  try {
    return one(db, row, read)
  } catch {
    return []
  }
}

export function intake(db: Db, root: string, read: Read): void {
  const on = new Set((db.prepare('SELECT name FROM pipes WHERE enabled = 1').all() as { name: string }[]).map((p) => p.name))
  for (const repo of new Set(LANES.filter((l) => on.has(LANE[l].pipe)).map((l) => LANE[l].home))) {
    try {
      listed(db, root, repo, read)
    } catch {
      continue
    }
  }
}

/** A list exactly `WINDOW` long may be cut short, so what is missing from it is not taken as gone. */
function listed(db: Db, root: string, repo: string, read: Read): void {
  const found = Listed.parse(read(['issue', 'list', '--repo', repo, '--state', 'open', '--limit', String(WINDOW),
    '--json', 'number,title,body,url,labels']))
  const kept = found.filter((i) => laneOf(i.labels) !== null)
  recordListing(db, repo, found, found.length < WINDOW)
  if (found.length < WINDOW) {
    halt(db, repo, new Set(kept.map((i) => i.url)))
    released(db, root, repo, new Set(found.map((i) => i.number)))
  }
  const known = seen(db)
  const split = named(found.map((i) => i.title))
  for (const i of kept.filter((k) => !known.has(k.url) && !split.has(k.number) && !parent(repo, k.number, read))) {
    if (!claimed(db, root, i)) add(db, root, `${repo}#${String(i.number)}`, undefined, read)
  }
}

/** A part is titled `<parent><letter>: …` (\`85a: …\`); the numbers so named are parents, whoever split them. */
function named(titles: string[]): Set<number> {
  return new Set(titles.flatMap((t) => partOf(t) ?? []))
}

const Summary = z.object({ sub_issues_summary: z.object({ total: z.int() }).optional() })

/**
 * #260: an issue with sub-issues is a parent; its parts are the jobs, and building it repeats them (#139, #138
 * and #85 on 09-25). An answer that cannot be read counts as a parent this tick, and the next tick asks again.
 */
function parent(repo: string, no: number, read: Read): boolean {
  try {
    return (Summary.parse(read(['api', `repos/${repo}/issues/${String(no)}`])).sub_issues_summary?.total ?? 0) > 0
  } catch {
    return true
  }
}

function halt(db: Db, repo: string, open: Set<string>): void {
  const queued = db.prepare(`SELECT * FROM plans WHERE state = 'queued' AND origin IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM deliverables d WHERE d.plan_id = plans.id AND d.state = 'pushed')`).all().map((r) => PlanRow.parse(r))
  for (const plan of queued.filter((p) => originRef(p)?.repo === repo && !open.has(p.origin ?? ''))) {
    db.prepare("UPDATE plans SET state = 'halted' WHERE id = ?").run(plan.id)
  }
  landed(db, repo, open)
}

/**
 * #257: a plan whose work is on main and whose issue is closed is finished, whatever step it thinks it is on.
 * Plans 88 and 89 were landed by hand and kept going; each lap after that reviewed an empty diff.
 */
function landed(db: Db, repo: string, open: Set<string>): void {
  const live = db.prepare(`SELECT p.* FROM plans p WHERE p.state IN ('queued', 'running', 'blocked_on_ceo') AND p.origin IS NOT NULL
    AND EXISTS (SELECT 1 FROM deliverables d WHERE d.plan_id = p.id AND d.state = 'pushed')`).all().map((r) => PlanRow.parse(r))
  for (const plan of live.filter((p) => originRef(p)?.repo === repo && !open.has(p.origin ?? ''))) {
    db.prepare("UPDATE plans SET state = 'done', wait_reason = NULL WHERE id = ?").run(plan.id)
  }
}

function one(db: Db, row: Pushed, read: (repo: string, no: number) => Pr): SignalRow[] {
  const view = read(row.repo, prNumber(row.evidence))
  if (row.rehearsal) {
    for (const s of signals(view, row).filter((s) => s.kind === 'bot_review')) record(db, s)
    return []
  }
  const fresh = signals(view, row).map((s) => record(db, s)).filter((s) => s !== null)
  attribute(db, row.plan, row.repo, view)
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
  ].filter((s) => s.kind !== 'bot_review' || typeof s.head === 'string')
}

/** #103: a review bot's summary comment carries its score as its review would; only a person's comment asks something of us. */
function comment(base: Base, c: Pr['comments'][number]): Signal {
  const bot = BOT.test(c.author.login)
  return { ...base, kind: bot ? 'bot_review' : 'comment', author: c.author.login, at: c.createdAt, external_id: c.id,
    score: bot ? scored(c.body) : null, body: c.body, head: bot ? REVIEWED.exec(c.body)?.[1] ?? null : null }
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
    head: bot ? REVIEWED.exec(r.body)?.[1] ?? null : null,
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
function pushed(db: Db, root?: string, list?: Read): Pushed[] {
  const rows = (db.prepare(`SELECT d.plan_id AS plan, t.repo, d.evidence
    FROM deliverables d JOIN plans p ON p.id = d.plan_id JOIN targets t ON t.id = p.target_id
    WHERE d.state = 'pushed' AND d.evidence GLOB 'https://*/pull/*'
    UNION
    SELECT p.id AS plan, t.repo, t.evidence
    FROM plans p JOIN targets t ON t.id = p.target_id
    WHERE t.evidence GLOB 'https://*/pull/*'
    ORDER BY plan`).all() as Omit<Pushed, 'rehearsal'>[]).map((r) => ({ ...r, rehearsal: false }))
  return root === undefined || list === undefined ? rows : [...rows, ...rehearsals(db, root, list)]
}

/** `git rev-parse` in a `srcDir` with no `.git` climbs to the repository around `root` and reads its branch. */
function rehearsals(db: Db, root: string, list: Read): Pushed[] {
  const live = db.prepare(`SELECT p.id AS plan, t.repo FROM plans p JOIN targets t ON t.id = p.target_id
    WHERE p.origin IS NULL AND p.state IN ('running', 'blocked_on_ceo') ORDER BY p.id`).all() as { plan: number; repo: string }[]
  return live.filter((p) => cloned(srcDir(root, p.plan))).flatMap((p) => opened(root, p.plan, `${FORK}/${repoName(p.repo)}`, list))
}

function opened(root: string, plan: number, fork: string, list: Read): Pushed[] {
  try {
    const no = rehearsal(fork, rehearsalBranch(root, plan), list)
    return no === null ? [] : [{ plan, repo: fork, evidence: `https://github.com/${fork}/pull/${String(no)}`, rehearsal: true }]
  } catch {
    return []
  }
}
