import { notify, record as keep, type Event } from '../cli/inbox.ts'
import type { Db } from '../store/index.ts'
import { needsCeo, PlanRow, rewind } from '../store/plans.ts'
import { clear } from '../store/refusals.ts'
import type { SignalRow } from '../store/signals.ts'
import { put } from './workspace.ts'

export interface Started {
  signal: number
  template: 'pr_path' | 'comms'
  plan: number
  step: number
}

/** A bot's finding re-enters at the first review; the reviewers weigh it. */
const REVIEW_STEP = 4

/** A person's words, or their red CI, re-enter at the build: that is who can change the code. */
const BUILD_STEP = 2

/**
 * A changes-requested review and a red check on the pull request go straight to the builder with the
 * words. A plain comment or review goes to the builder too, but waits there for a person: it may be a
 * question, and the CEO answers those himself (`cf retry` sends it on). Either way the words land in
 * the refusal the builder reads, the refusal count starts over, and the inbox says who asked.
 */
export function started(db: Db, signal: SignalRow, root?: string): Started | null {
  if (signal.plan === null) return null
  if (signal.kind === 'merge') return comms(db, signal, signal.plan)
  if (older(db, signal, signal.plan)) return null
  if (signal.kind === 'bot_review' && (signal.score ?? 5) >= 5) return null
  if (signal.kind === 'comment' && signal.author === 'ci') return null
  const step = signal.kind === 'bot_review' ? REVIEW_STEP : BUILD_STEP
  rewind(db, signal.plan, step)
  if (step === BUILD_STEP) asked(db, signal, signal.plan, root)
  return { signal: signal.id, template: 'pr_path', plan: signal.plan, step }
}

function asked(db: Db, signal: SignalRow, plan: number, root: string | undefined): void {
  clear(db, plan)
  const direct = signal.kind === 'ci_red' || signal.state === 'CHANGES_REQUESTED'
  if (!direct) needsCeo(db, PlanRow.parse(db.prepare('SELECT * FROM plans WHERE id = ?').get(plan)))
  if (root === undefined) return
  put(root, plan, 'refusal.md', words(signal))
  const event: Event = { at: signal.at, plan, ticket: `${signal.repo}#${String(signal.pr)}`, kind: 'asked', step: BUILD_STEP,
    name: direct ? 'build' : 'waits for a person', note: `${signal.author}: ${(signal.body ?? '').replace(/\s+/g, ' ').slice(0, 140)}` }
  keep(root, [event])
  notify([event])
}

function words(signal: SignalRow): string {
  const said = signal.body ?? '(no words)'
  return `${signal.author} on ${signal.repo}#${String(signal.pr)} (${signal.kind}${signal.state === null ? '' : `, ${signal.state}`}, ${signal.at}):\n\n${said}\n\nspans:\n  - pr:${String(signal.pr)}\n`
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
