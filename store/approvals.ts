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

export function approvalOf(db: Db, kind: SubjectKind, id: number, digest: string): number | null {
  const row = db.prepare(`SELECT id FROM approvals WHERE subject_kind = ? AND subject_id = ?
    AND subject_digest = ? AND decision = 'approved'`).get(kind, id, digest) as { id: number } | undefined
  return row?.id ?? null
}

/** What `hooks/pre-push` asks: is this branch head the one the CEO signed off? */
export function headApproved(db: Db, sha: string): boolean {
  return db.prepare(`SELECT 1 FROM approvals WHERE subject_kind = 'plan'
    AND subject_digest = ? AND decision = 'approved'`).get(headDigest(sha)) !== undefined
}
