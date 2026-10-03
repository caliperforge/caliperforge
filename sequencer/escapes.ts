import type { Pr } from '../cli/gh.ts'
import { read } from '../reviews/verdict.ts'
import { escaped, owner, settle, unsettled, type Owner } from '../store/dispositions.ts'
import type { Db } from '../store/index.ts'
import { since, type SignalRow } from '../store/signals.ts'

const GATE: Record<Owner, string> = {
  step0: 'target',
  step3: 'pre_review',
  review: 'review',
  text_review: 'review',
  text_rail: 'pre_review',
  ready: 'ready',
}

const KNOWN = [
  'premise', 'secret', 'authority', 'tier', 'claim', 'test.weakened', 'test.untargeted',
  'identifier.unresolved', 'correctness', 'scope', 'approach', 'minimal', 'register',
  'claim.unverified', 'upstream.number', 'restated.rail', 'stale.verdict', 'not.public',
  'ci.red', 'no.anchor',
]

/** A finding names its class or it is a correctness finding; the owning step is the map's, not the finder's. */
const FALLBACK = 'correctness'

export function classOf(body: string): string {
  const tight = /\btight\.[a-z]+\b/.exec(body)?.[0]
  return tight ?? KNOWN.find((c) => body.includes(c)) ?? FALLBACK
}

/** Review and merge rarely land on one tick, so the escape is read against every signal the pull request ever carried. */
export function attribute(db: Db, plan: number, repo: string, view: Pr): number[] {
  if (view.mergedAt === null) return []
  return findings(view, since(db, plan).filter((s) => s.repo === repo && s.pr === view.number)).flatMap((f) => {
    const verdict = verdictAt(db, plan, GATE[owner(f)])
    return verdict === null ? [] : [escaped(db, { verdict_id: verdict, defect_class: f, evidence: view.url })]
  })
}

/** One disposition per verdict is a unique index, so a finding that named its class outranks the fallback. */
function findings(view: Pr, seen: SignalRow[]): string[] {
  const bodies = new Map(view.reviews.map((r) => [r.id, r.body]))
  const found = seen
    .filter((s) => s.kind === 'review' || (s.kind === 'bot_review' && (s.score ?? 5) < 5))
    .map((s) => classOf(bodies.get(s.external_id) ?? ''))
  return [...found.filter((c) => c !== FALLBACK), ...found.filter((c) => c === FALLBACK)]
}

/** A review that passes on a re-gate settles the newest refusal at its step that nothing has settled yet. */
export function regated(db: Db, plan: number, step: number, pass: number, prior: string | undefined, tree: string | undefined | null): number | null {
  const last = read(prior ?? '', '')
  if (last?.outcome !== 'refuse' || tree === undefined || tree === null) return null
  const row = unsettled(db, plan, step, pass)
  if (typeof row?.tree !== 'string') return null
  const named = last.defect_class ?? ''
  const defect_class = /^tight\.[a-z]+$/.test(named) || KNOWN.includes(named) ? named : FALLBACK
  return settle(db, { verdict_id: row.id, defect_class, evidence: `verdicts:${String(pass)}` }, row.tree, tree, 'pass')
}

function verdictAt(db: Db, plan: number, gate: string): number | null {
  const row = db.prepare(`SELECT v.id FROM verdicts v WHERE v.plan = ? AND v.gate = ?
    AND NOT EXISTS (SELECT 1 FROM dispositions d WHERE d.verdict_id = v.id)
    ORDER BY v.id DESC LIMIT 1`).get(plan, gate) as { id: number } | undefined
  return row?.id ?? null
}
