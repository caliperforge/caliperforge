import { z } from 'zod'
import type { Pr } from '../cli/gh.ts'
import { read } from '../reviews/verdict.ts'
import type { Db } from './index.ts'
import { since, type SignalRow } from './signals.ts'

export type Owner = 'step0' | 'step3' | 'review' | 'text_review' | 'text_rail' | 'ready'

const OWNERS: Record<string, Owner> = {
  premise: 'step0',
  secret: 'step3', authority: 'step3', tier: 'step3', claim: 'step3',
  'test.weakened': 'step3', 'test.untargeted': 'step3', 'identifier.unresolved': 'step3',
  correctness: 'review', scope: 'review', approach: 'review', minimal: 'review',
  register: 'text_review', 'claim.unverified': 'text_review',
  'upstream.number': 'text_rail', 'restated.rail': 'text_rail',
  'stale.verdict': 'ready', 'not.public': 'ready', 'ci.red': 'ready', 'no.anchor': 'ready',
}

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

export const Span = z.object({
  verdict_id: z.int().positive(),
  defect_class: z.string(),
  evidence: z.string(),
})

export type Span = z.infer<typeof Span>

export function owner(defectClass: string): Owner {
  if (/^tight\.[a-z]+$/.test(defectClass)) return 'step3'
  const found = OWNERS[defectClass]
  if (found === undefined) throw new Error(`defect class "${defectClass}" has no owning step in the build map`)
  return found
}

export function settle(db: Db, span: Span, before: string, after: string, regate: 'pass' | 'refuse' | 'needs_ceo'): number | null {
  if (regate !== 'pass') return null
  return put(db, span, before === after ? 'no_change_pass' : 'fixed', null, null)
}

export function escaped(db: Db, span: Span): number {
  return put(db, span, 'escaped', null, null)
}

export function overridden(db: Db, span: Span, approval: number, tag: 'false_positive' | 'accepted_risk'): number {
  return put(db, span, 'overridden', approval, tag)
}

export function dispositionsOf(db: Db): { kind: string; defect_class: string; owner: Owner; evidence: string }[] {
  return db.prepare('SELECT kind, defect_class, owner, evidence FROM dispositions ORDER BY id')
    .all() as { kind: string; defect_class: string; owner: Owner; evidence: string }[]
}

export function unsettled(db: Db, plan: number, step: number, before: number): { id: number; tree: string | null } | undefined {
  return db.prepare(`SELECT v.id, v.tree FROM verdicts v WHERE v.id = (SELECT max(id) FROM verdicts WHERE plan = ? AND step = ?
    AND kind = 'review' AND outcome = 'refuse' AND id < ?) AND NOT EXISTS (SELECT 1 FROM dispositions d WHERE d.verdict_id = v.id)`)
    .get(plan, step, before) as { id: number; tree: string | null } | undefined
}

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

/** `prior` was read from the newest refusal at the step; once that one is settled, an older one stays open. */
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

function put(db: Db, span: Span, kind: string, approval: number | null, tag: string | null): number {
  const row = Span.parse(span)
  const written = db.prepare(`INSERT INTO dispositions
    (verdict_id, kind, defect_class, owner, approval_id, override_tag, evidence)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(row.verdict_id, kind, row.defect_class, owner(row.defect_class), approval, tag, row.evidence)
  return Number(written.lastInsertRowid)
}
