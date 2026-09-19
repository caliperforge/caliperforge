import type { Db } from '../store/index.ts'
import { rewind } from '../store/plans.ts'
import type { SignalRow } from '../store/signals.ts'

export interface Started {
  signal: number
  template: 'pr_path' | 'comms'
  plan: number
  step: number
}

/** The build map's signal table. `review` re-enters pr-path at step 4: review, propose, fix, test, re-gate, batch. */
const REVIEW_STEP = 4

export function started(db: Db, signal: SignalRow): Started | null {
  if (signal.plan === null) return null
  if (signal.kind === 'merge') return comms(db, signal, signal.plan)
  if (older(db, signal, signal.plan)) return null
  if (signal.kind === 'bot_review' && (signal.score ?? 5) >= 5) return null
  if (signal.kind === 'comment' && signal.author === 'ci') return null
  rewind(db, signal.plan, REVIEW_STEP)
  return { signal: signal.id, template: 'pr_path', plan: signal.plan, step: REVIEW_STEP }
}

/**
 * Ruling `signals.pre_adoption`: an adopted plan inherits the whole thread of a pull request v1
 * opened. What predates the row is history the plan already stands on — recorded, never replayed.
 */
function older(db: Db, signal: SignalRow, plan: number): boolean {
  const row = db.prepare('SELECT queued_at FROM plans WHERE id = ?').get(plan) as { queued_at: string }
  return Date.parse(signal.at) < Date.parse(row.queued_at)
}

/** The comms lane is on and holds no step map; the plan queued here waits there until P7 writes one. */
function comms(db: Db, signal: SignalRow, from: number): Started {
  db.prepare(`INSERT OR IGNORE INTO pipes (name, enabled, window_start, window_end, max_concurrent)
    VALUES ('comms', 1, '07:00', '22:00', 1)`).run()
  const pipe = db.prepare("SELECT id FROM pipes WHERE name = 'comms'").get() as { id: number }
  const target = db.prepare('SELECT target_id FROM plans WHERE id = ?').get(from) as { target_id: number | null }
  const made = db.prepare(`INSERT INTO plans (pipe_id, target_id, template, state, queued_at, step, retries)
    VALUES (?, ?, 'comms', 'queued', ?, 0, 0)`).run(pipe.id, target.target_id, new Date().toISOString())
  return { signal: signal.id, template: 'comms', plan: Number(made.lastInsertRowid), step: 0 }
}
