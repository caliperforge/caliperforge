import { z } from 'zod'
import type { Db } from './index.ts'

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

function put(db: Db, span: Span, kind: string, approval: number | null, tag: string | null): number {
  const row = Span.parse(span)
  const written = db.prepare(`INSERT INTO dispositions
    (verdict_id, kind, defect_class, owner, approval_id, override_tag, evidence)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(row.verdict_id, kind, row.defect_class, owner(row.defect_class), approval, tag, row.evidence)
  return Number(written.lastInsertRowid)
}
