import { z } from 'zod'
import type { Db } from './index.ts'

export const CLASSES = ['ruling', 'work', 'ordering', 'world_fact', 'measurement'] as const

export const ProposalRow = z.object({
  id: z.int(),
  class: z.enum(CLASSES),
  subject: z.string(),
  value: z.string(),
  state: z.enum(['open', 'approved']),
  match_ruling_id: z.int().nullable(),
  match_issue_no: z.int().nullable(),
  evidence: z.string(),
})

export type ProposalRow = z.infer<typeof ProposalRow>

export interface Item {
  class: (typeof CLASSES)[number]
  subject: string
  value: string
  match_ruling_id: number | null
  match_issue_no: number | null
  evidence: string
}

/** The bytes the CEO signs off on a proposal card. */
export function bytes(p: Pick<ProposalRow, 'class' | 'subject' | 'value'>): string {
  return `${p.class} ${p.subject} = ${p.value}`
}

export function propose(db: Db, item: Item): number {
  const row = db.prepare(`INSERT INTO proposals
    (class, subject, value, state, match_ruling_id, match_issue_no, evidence)
    VALUES (?, ?, ?, 'open', ?, ?, ?)
    ON CONFLICT (class, subject, value) DO UPDATE SET evidence = excluded.evidence`)
    .run(item.class, item.subject, item.value, item.match_ruling_id, item.match_issue_no, item.evidence)
  return row.changes === 0 ? id(db, item) : Number(row.lastInsertRowid)
}

export function open(db: Db): ProposalRow[] {
  return db.prepare("SELECT * FROM proposals WHERE state = 'open' ORDER BY id").all().map((r) => ProposalRow.parse(r))
}

export function byId(db: Db, proposal: number): ProposalRow | null {
  const row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposal)
  return row === undefined ? null : ProposalRow.parse(row)
}

export function stamp(db: Db, proposal: number): void {
  db.prepare("UPDATE proposals SET state = 'approved' WHERE id = ?").run(proposal)
}

/** A struck proposal leaves no row; the `approvals` refusal is the whole record of it. */
export function strike(db: Db, proposal: number): void {
  db.prepare('DELETE FROM proposals WHERE id = ?').run(proposal)
}

function id(db: Db, item: Item): number {
  const row = db.prepare('SELECT id FROM proposals WHERE class = ? AND subject = ? AND value = ?')
    .get(item.class, item.subject, item.value) as { id: number }
  return row.id
}
