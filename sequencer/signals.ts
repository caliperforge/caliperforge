import type { Desk } from '../cli/gh.ts'
import { all, notify, record as keep, type Event } from '../cli/inbox.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { hhmm, zone } from '../store/lanes.ts'
import { internal, needsCeo, planById, type PlanRow, rewind } from '../store/plans.ts'
import { clear } from '../store/refusals.ts'
import type { SignalRow } from '../store/signals.ts'
import { assembling } from './home.ts'
import { WIRE, type Wire } from './push.ts'
import { fixed } from './split.ts'
import { shift } from './weekly.ts'
import { maybe, put } from './workspace.ts'

interface Started {
  signal: number
  template: 'pr_path' | 'comms'
  plan: number
  step: number
}

/** A bot's finding re-enters at the first review; the reviewers weigh it. */
const REVIEW_STEP = 4

/** A person's words re-enter at the brief: they grow the ask the brief is written from. */
const BRIEF_STEP = 1

/** Their red CI re-enters at the build: that is who can change the code. */
const BUILD_STEP = 2

/**
 * A person's review or comment goes back to the brief writer with the words added to the ask; a question
 * among them comes back from its `unclear` fence, which holds the plan for a person. A red check on the
 * pull request goes straight to the builder with the words in the refusal it reads. Either way the refusal
 * count starts over, and the inbox says who asked. A changes-requested review on an assembled pull
 * request is the exception: it becomes one fix part.
 */
export function started(db: Db, signal: SignalRow, root?: string, wire: Wire = WIRE): Started | null {
  if (signal.plan === null) return null
  if (signal.kind === 'merge') return comms(db, signal, signal.plan)
  if (older(db, signal, signal.plan)) return null
  if (signal.kind === 'bot_review' && (signal.score ?? 5) >= 5) return null
  if (signal.kind === 'comment' && signal.author === 'ci') return null
  if (signal.kind === 'review' && signal.state === 'CHANGES_REQUESTED' && root !== undefined) {
    const parent = planById(db, signal.plan)
    if (assembling(db, parent) !== null) return fix(db, signal, parent, root, wire)
  }
  const step = signal.kind === 'bot_review' ? REVIEW_STEP : signal.kind === 'ci_red' ? BUILD_STEP : BRIEF_STEP
  rewind(db, signal.plan, step)
  if (step === BUILD_STEP) asked(db, signal, signal.plan, root)
  if (step === BRIEF_STEP) reasked(db, signal, signal.plan, root)
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

function asked(db: Db, signal: SignalRow, plan: number, root: string | undefined, direct = true): void {
  clear(db, plan)
  if (!direct) needsCeo(db, planById(db, plan))
  if (root === undefined) return
  put(root, plan, 'refusal.md', words(signal))
  inbox(root, signal, plan, BUILD_STEP, direct ? 'build' : 'waits for a person')
}

/** An adopted plan holds only `issue.md`, so its ask starts from that. */
function reasked(db: Db, signal: SignalRow, plan: number, root: string | undefined): void {
  clear(db, plan)
  if (root === undefined) return
  const ask = maybe(root, plan, 'ask.md') ?? maybe(root, plan, 'issue.md') ?? ''
  put(root, plan, 'ask.md', `${ask.trimEnd()}\n\n${words(signal)}`)
  inbox(root, signal, plan, BRIEF_STEP, 'brief')
}

function inbox(root: string, signal: SignalRow, plan: number, step: number, name: string): void {
  const event: Event = { at: signal.at, plan, ticket: `${signal.repo}#${String(signal.pr)}`, kind: 'asked', step,
    name, note: `${signal.author}: ${(signal.body ?? '').replace(/\s+/g, ' ').slice(0, 140)}` }
  keep(root, [event])
  notify([event])
}

export function words(signal: SignalRow): string {
  const said = signal.body ?? '(no words)'
  return `${signal.author} on ${signal.repo}#${String(signal.pr)} (${signal.kind}${signal.state === null ? '' : `, ${signal.state}`}, ${signal.at}):\n\n${said}\n\nspans:\n  - pr:${String(signal.pr)}\n`
}

/** A signal older than the plan is recorded, never replayed (ruling `signals.pre_adoption`). */
function older(db: Db, signal: SignalRow, plan: number): boolean {
  const row = db.prepare('SELECT queued_at FROM plans WHERE id = ?').get(plan) as { queued_at: string }
  return Date.parse(signal.at) < Date.parse(row.queued_at)
}

/** A merged outside pull request files one comms plan to post it, on a comms lane made on if missing. */
function comms(db: Db, signal: SignalRow, from: number): Started | null {
  const merged = planById(db, from)
  if (internal(merged)) return null
  db.prepare(`INSERT OR IGNORE INTO pipes (name, enabled, window_start, window_end, max_concurrent)
    VALUES ('comms', 1, '07:00', '22:00', 1)`).run()
  const ticket = `${signal.repo}#${String(signal.pr)}`
  const plan = file(db, `ship post ${ticket}`, merged.target_id, new Date(), 'merge signal', ticket)
  return plan === null ? null : { signal: signal.id, template: 'comms', plan, step: 0 }
}

/** The day's comms plan, filed once from 20:30 local on a comms lane someone left on. */
export function daily(db: Db, now: Date): void {
  if (hhmm(db, now) < '20:30') return
  if (!commsOn(db)) return
  const day = new Date(now.getTime() + zone(db) * 60000).toISOString().slice(0, 10)
  file(db, `daily ${day}`, null, now, 'daily clock', day)
}

const WEEKLY: Record<number, string | undefined> = { 1: 'scorecard', 4: 'growth' }

/** The week's scorecard and growth comms plans, filed once on local Monday and Thursday, and the weekly post plan from Thursday 07:00, on a comms lane someone left on. */
export function weekly(db: Db, now: Date): void {
  const local = new Date(now.getTime() + zone(db) * 60000)
  const dow = local.getUTCDay()
  const kind = WEEKLY[dow]
  if (kind === undefined || !commsOn(db)) return
  const day = local.toISOString().slice(0, 10)
  file(db, `${kind} ${day}`, null, now, 'weekly clock', day)
  if (dow === 4 && hhmm(db, now) >= '07:00') file(db, `weekly ${shift(day, -3)}`, null, now, 'weekly clock', shift(day, -3))
}

/** From Friday 18:00 local, a Monday-to-Sunday week with no weekly post on the desk raises one card and one inbox event. */
export function late(db: Db, root: string, board: Desk, now: Date): void {
  const local = new Date(now.getTime() + zone(db) * 60000)
  const dow = local.getUTCDay()
  if (!(dow === 6 || dow === 0 || (dow === 5 && hhmm(db, now) >= '18:00'))) return
  const since = (dow + 6) % 7
  const day = (offset: number): string => new Date(local.getTime() + offset * 86400000).toISOString().slice(0, 10)
  const monday = day(-since)
  const posted = db.prepare("SELECT 1 FROM desk_posts WHERE kind = 'weekly' AND work_date BETWEEN ? AND ?")
    .get(monday, day(6 - since))
  const ticket = `week ${monday}`
  if (posted !== undefined || all(root).some((e) => e.kind === 'late' && e.ticket === ticket)) return
  const { url } = board.open('Weekly post not on the desk', `No weekly post is on the desk for the week of ${monday}.`)
  const event: Event = { at: now.toISOString(), plan: 0, ticket, kind: 'late', step: 0, name: 'weekly',
    note: `no weekly post on the desk: ${url}` }
  keep(root, [event])
  notify([event])
}

function commsOn(db: Db): boolean {
  return db.prepare("SELECT 1 FROM pipes WHERE name = 'comms' AND enabled = 1").get() !== undefined
}

/** `plans_one_comms` holds a comms title to one plan, so a title already filed files nothing. */
function file(db: Db, title: string, target: number | null, at: Date, actor: string, message: string): number | null {
  const pipe = db.prepare("SELECT id FROM pipes WHERE name = 'comms'").get() as { id: number }
  const made = db.prepare(`INSERT OR IGNORE INTO plans (pipe_id, target_id, template, state, queued_at, step, retries, title)
    VALUES (?, ?, 'comms', 'queued', ?, 0, 0, ?)`).run(pipe.id, target, at.toISOString(), title)
  if (made.changes !== 1) return null
  const plan = Number(made.lastInsertRowid)
  logged(db, { plan, kind: 'filed', actor, outcome: 'pass', message, pointer: null, run: null })
  return plan
}
