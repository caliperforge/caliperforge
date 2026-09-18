import { createHash } from 'node:crypto'
import type { Db } from './index.ts'

export type SubjectKind = 'target' | 'plan' | 'proposal' | 'deliverable' | 'override' | 'publish'

export function digestOf(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** `approvals.subject_digest` is 64 hex wide; a git object name is 40. */
export function headDigest(sha: string): string {
  return digestOf(sha.trim())
}

/** A second lap can land on the same bytes; signing them again re-dates the one row rather than colliding with it. */
export function decide(db: Db, kind: SubjectKind, id: number, digest: string, reason: string | null): number {
  const row = db.prepare(`INSERT INTO approvals
    (subject_kind, subject_id, subject_digest, who, decision, reason, approved_at)
    VALUES (?, ?, ?, 'ceo', ?, ?, ?)
    ON CONFLICT (subject_kind, subject_id, subject_digest, decision)
      DO UPDATE SET approved_at = excluded.approved_at
    RETURNING id`)
    .get(kind, id, digest, reason === null ? 'approved' : 'refused', reason, new Date().toISOString()) as { id: number }
  return row.id
}

/**
 * #20: an internal plan lands on the gates alone, so the row that settles its deliverable is signed
 * `gates`. The store takes that signature on a plan approval and nowhere else, and the step-7 trigger
 * reads it only when the plan names an origin — a stranger's repo still leaves ready on the CEO's row.
 */
export function gates(db: Db, plan: number, digest: string): number {
  const row = db.prepare(`INSERT INTO approvals
    (subject_kind, subject_id, subject_digest, who, decision, reason, approved_at)
    VALUES ('plan', ?, ?, 'gates', 'approved', NULL, ?)
    ON CONFLICT (subject_kind, subject_id, subject_digest, decision)
      DO UPDATE SET approved_at = excluded.approved_at
    RETURNING id`).get(plan, digest, new Date().toISOString()) as { id: number }
  return row.id
}

/**
 * The row step 8 sends on. Its clause is the step-7 trigger's and `hooks/pre-push`'s, word for
 * word: the CEO's signature, or the gates' on a plan that names an origin. All three fences read
 * the same sentence, so none of them can drift into taking a signature the others would refuse.
 */
export function signedHead(db: Db, plan: number, digest: string): number | null {
  const row = db.prepare(`SELECT a.id FROM approvals a JOIN plans p ON p.id = a.subject_id
    WHERE a.subject_kind = 'plan' AND a.subject_id = ? AND a.subject_digest = ? AND a.decision = 'approved'
      AND (a.who = 'ceo' OR (a.who = 'gates' AND p.origin IS NOT NULL))`)
    .get(plan, digest) as { id: number } | undefined
  return row?.id ?? null
}

/**
 * What `hooks/pre-push` asks: is this branch head one that was signed off? The clause is the
 * step-7 trigger's, word for word — the CEO's row, or the gates' row on a plan that names an
 * origin — so no external branch can leave on a signature the CEO did not write.
 */
export function headApproved(db: Db, sha: string): boolean {
  return db.prepare(`SELECT 1 FROM approvals a JOIN plans p ON p.id = a.subject_id
    WHERE a.subject_kind = 'plan' AND a.subject_digest = ? AND a.decision = 'approved'
      AND (a.who = 'ceo' OR (a.who = 'gates' AND p.origin IS NOT NULL))`)
    .get(headDigest(sha)) !== undefined
}
