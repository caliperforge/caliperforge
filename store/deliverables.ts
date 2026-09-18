import type { Db } from './index.ts'

/** The five proofs the ready gate reads. A row may only call itself ready with all five. */
export interface Proven {
  tests_pass: boolean
  byte_identical_elsewhere: boolean
  fork_ci_green: boolean
  bot_clean: boolean
  target_warm: boolean
}

export interface Made {
  plan: number
  step: number
  seat: string
  diff_digest: string
  evidence: string
}

const INSERT = `INSERT INTO deliverables (plan_id, step, seat, diff_digest, state, tests_pass,
  byte_identical_elsewhere, fork_ci_green, bot_clean, target_warm, evidence)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const NOTHING: Proven = {
  tests_pass: false, byte_identical_elsewhere: false, fork_ci_green: false, bot_clean: false, target_warm: false,
}

/** The builder's handback proves bytes exist and nothing else, so every proof on the row is still open. */
export function built(db: Db, made: Made): void {
  write(db, made, 'built', NOTHING)
}

/** The rails and the two reviews have run; what they left in `verdicts` and `signals` is what the row carries. */
export function gated(db: Db, made: Made, proof: Proven): void {
  write(db, made, 'gated', proof)
}

/** A `CHECK` on the table refuses a ready row missing any of the five, so the store is what says no. */
export function ready(db: Db, plan: number): void {
  db.prepare("UPDATE deliverables SET state = 'ready' WHERE id = ?").run(latest(db, plan))
}

/** The card the CEO signed and the row it settles are the same row, and the push stamps it again. */
export function approved(db: Db, plan: number, approval: number): void {
  db.prepare("UPDATE deliverables SET state = 'approved', approval_id = ? WHERE id = ?").run(approval, latest(db, plan))
}

function latest(db: Db, plan: number): number {
  const row = db.prepare('SELECT id FROM deliverables WHERE plan_id = ? ORDER BY id DESC LIMIT 1').get(plan) as
    { id: number } | undefined
  if (row === undefined) throw new Error(`plan ${String(plan)} has no deliverable row`)
  return row.id
}

function write(db: Db, made: Made, state: string, proof: Proven): void {
  db.prepare(INSERT).run(made.plan, made.step, made.seat, made.diff_digest, state,
    Number(proof.tests_pass), Number(proof.byte_identical_elsewhere), Number(proof.fork_ci_green),
    Number(proof.bot_clean), Number(proof.target_warm), made.evidence)
}
