import { notify, record as keep, type Event } from '../cli/inbox.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { needsCeo, PlanRow, rewind } from '../store/plans.ts'
import { clear } from '../store/refusals.ts'
import type { SignalRow } from '../store/signals.ts'
import { assembling } from './home.ts'
import { WIRE, type Wire } from './push.ts'
import { fixed } from './split.ts'
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
 * the refusal the builder reads, the refusal count starts over, and the inbox says who asked. A
 * changes-requested review on an assembled pull request is the exception: it becomes one fix part.
 */
export function started(db: Db, signal: SignalRow, root?: string, wire: Wire = WIRE): Started | null {
  if (signal.plan === null) return null
  if (signal.kind === 'merge') return comms(db, signal, signal.plan)
  if (older(db, signal, signal.plan)) return null
  if (signal.kind === 'bot_review' && (signal.score ?? 5) >= 5) return null
  if (signal.kind === 'comment' && signal.author === 'ci') return null
  if (signal.kind === 'review' && signal.state === 'CHANGES_REQUESTED' && root !== undefined) {
    const parent = PlanRow.parse(db.prepare('SELECT * FROM plans WHERE id = ?').get(signal.plan))
    if (assembling(db, parent) !== null) return fix(db, signal, parent, root, wire)
  }
  const step = signal.kind === 'bot_review' ? REVIEW_STEP : BUILD_STEP
  rewind(db, signal.plan, step)
  if (step === BUILD_STEP) asked(db, signal, signal.plan, root)
  return { signal: signal.id, template: 'pr_path', plan: signal.plan, step }
}

/** The fix part lands on `asm/<parent>`, the pull request's head; a part that cannot be filed leaves the words waiting on the parent for a person. */
function fix(db: Db, signal: SignalRow, parent: PlanRow, root: string, wire: Wire): Started {
  try {
    return { signal: signal.id, template: 'pr_path', plan: fixed(db, root, parent, signal, wire), step: 0 }
  } catch (error) {
    logged(db, { plan: parent.id, kind: 'unfiled', actor: 'review', outcome: 'refuse',
      message: `fix part: ${error instanceof Error ? error.message : String(error)}`, pointer: null, run: null })
    rewind(db, parent.id, BUILD_STEP)
    asked(db, signal, parent.id, root, false)
    return { signal: signal.id, template: 'pr_path', plan: parent.id, step: BUILD_STEP }
  }
}

function asked(db: Db, signal: SignalRow, plan: number, root: string | undefined,
  direct = signal.kind === 'ci_red' || signal.state === 'CHANGES_REQUESTED'): void {
  clear(db, plan)
  if (!direct) needsCeo(db, PlanRow.parse(db.prepare('SELECT * FROM plans WHERE id = ?').get(plan)))
  if (root === undefined) return
  put(root, plan, 'refusal.md', words(signal))
  const event: Event = { at: signal.at, plan, ticket: `${signal.repo}#${String(signal.pr)}`, kind: 'asked', step: BUILD_STEP,
    name: direct ? 'build' : 'waits for a person', note: `${signal.author}: ${(signal.body ?? '').replace(/\s+/g, ' ').slice(0, 140)}` }
  keep(root, [event])
  notify([event])
}

export function words(signal: SignalRow): string {
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
  const plan = Number(made.lastInsertRowid)
  logged(db, { plan, kind: 'filed', actor: 'merge signal', outcome: 'pass', message: `${signal.repo}#${String(signal.pr)}`,
    pointer: null, run: null })
  return { signal: signal.id, template: 'comms', plan, step: 0 }
}
