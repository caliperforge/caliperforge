import type { Dry, Quiet } from '../sequencer/index.ts'
import type { Fired } from '../sequencer/kind.ts'
import type { Db } from '../store/index.ts'
import { name, type LaneState, type WindowRow } from '../store/lanes.ts'
import { BUILT, type Wait } from '../store/plans.ts'

export interface PlanLine {
  id: number
  step: number
  state: string
  repo: string | null
  issue_no: number | null
}

export interface Day {
  runs: number
  tokens: number
  seconds: number
}

export interface Ticket {
  plan: number
  origin: string | null
  target: string | null
  runs: number
  build: number
  review: number
  minutes: number
  tokens: number
  outcome: string
  early: number
}

const LINES = `SELECT p.id, p.step, p.state, t.repo, t.issue_no
  FROM plans p LEFT JOIN targets t ON t.id = p.target_id`

export function open(db: Db): PlanLine[] {
  return db.prepare(`${LINES} WHERE p.state IN ('queued', 'running') AND p.step <> 7 ORDER BY p.queued_at, p.id`).all() as PlanLine[]
}

export function halted(db: Db): PlanLine[] {
  return db.prepare(`${LINES} WHERE p.state = 'halted' ORDER BY p.queued_at, p.id`).all() as PlanLine[]
}

export function awaiting(db: Db): PlanLine[] {
  return db.prepare(`${LINES} WHERE p.state = 'blocked_on_ceo' OR p.step = 7 ORDER BY p.queued_at, p.id`).all() as PlanLine[]
}

export function day(db: Db): Day {
  return db.prepare(`SELECT count(*) AS runs,
    coalesce(sum(input_tokens + cache_tokens + output_tokens), 0) AS tokens,
    coalesce(sum(seconds), 0) AS seconds
    FROM runs WHERE julianday(at) >= julianday('now', '-1 day')`).get() as Day
}

/** CEO 2026-09-19 12:15: per-ticket usage is read as two eras, split at this instant. */
const ERA = '2026-09-19 11:21'

const TICKETS = `SELECT p.id AS plan, p.origin, t.repo || '#' || t.issue_no AS target,
  count(*) AS runs,
  sum(r.step = 2 AND r.${BUILT}) AS build,
  sum(r.step IN (4, 5) AND r.${BUILT}) AS review,
  sum(r.seconds) / 60.0 AS minutes,
  sum(r.input_tokens + r.cache_tokens + r.output_tokens) AS tokens,
  CASE p.state WHEN 'done' THEN 'landed' WHEN 'refused' THEN 'wasted' WHEN 'halted' THEN 'wasted'
    ELSE 'open' END AS outcome,
  julianday(min(r.at)) < julianday(?) AS early
  FROM runs r JOIN plans p ON p.id = r.plan LEFT JOIN targets t ON t.id = p.target_id
  GROUP BY p.id ORDER BY max(r.at) DESC, p.id DESC`

export function tickets(db: Db): Ticket[] {
  return db.prepare(TICKETS).all(ERA) as Ticket[]
}

function ticketLine(t: Ticket): string {
  return `  ${ref(t)}\t${String(t.runs)} run(s)\t${String(t.build)} build\t${String(t.review)} review` +
    `\t${t.minutes.toFixed(1)} min\t${String(t.tokens)} tokens\t${t.outcome}`
}

export function ticketSection(rows: Ticket[]): string {
  const body = rows.length === 0 ? '  none\n' : `${rows.map(ticketLine).join('\n')}\n`
  return `cost per ticket (${String(rows.length)})\n${body}` +
    average('before', rows.filter((t) => t.early === 1)) + average('since', rows.filter((t) => t.early === 0))
}

function average(era: string, rows: Ticket[]): string {
  const minutes = rows.reduce((sum, t) => sum + t.minutes, 0)
  const mean = rows.length === 0 ? '-' : `${(minutes / rows.length).toFixed(1)} min`
  return `  ${era} ${ERA}\t${String(rows.length)} ticket(s)\t${mean} avg\n`
}

function ref(t: Ticket): string {
  if (t.origin !== null) return `#${t.origin.slice(t.origin.lastIndexOf('/') + 1)}`
  return t.target ?? `plan ${String(t.plan)}`
}

export function line(p: PlanLine): string {
  const target = p.repo === null ? '-' : `${p.repo}#${String(p.issue_no ?? 0)}`
  return `  plan ${String(p.id)}\tstep ${String(p.step)}\t${p.state}\t${target}`
}

export function section(title: string, rows: PlanLine[]): string {
  const body = rows.length === 0 ? '  none\n' : `${rows.map(line).join('\n')}\n`
  return `${title} (${String(rows.length)})\n${body}`
}

export function runsOf(db: Db, plan: number): Record<string, string | number>[] {
  return db.prepare('SELECT id, step, seat, exit FROM runs WHERE plan = ? ORDER BY id').all(plan) as Record<string, string | number>[]
}

export function verdictsOf(db: Db, plan: number): Record<string, string | number | null>[] {
  return db.prepare('SELECT id, gate, step, outcome, origin_ref FROM verdicts WHERE plan = ? ORDER BY id')
    .all(plan) as Record<string, string | number | null>[]
}

export function laneLine(l: LaneState): string {
  return `lanes ${String(l.live)}/${String(l.open)} live/open\tcap ${name(l.cap)}\tdial ${String(l.dial)}` +
    `\tband ${name(l.band)}\tceiling ${String(l.ceiling)}\n`
}

export function waits(db: Db): { reason: Wait; plans: number }[] {
  return db.prepare(`SELECT wait_reason AS reason, count(*) AS plans FROM plans
    WHERE state IN ('queued', 'running') AND wait_reason IS NOT NULL
    GROUP BY wait_reason ORDER BY wait_reason`).all() as { reason: Wait; plans: number }[]
}

export function waitLine(rows: { reason: Wait; plans: number }[]): string {
  const pairs = rows.length === 0 ? ['none'] : rows.map((w) => `${w.reason} ${String(w.plans)}`)
  return `waits\t${pairs.join('\t')}\n`
}

/** One row per rate-limit window: our tokens inside it, the provider's utilisation of it, the cap. */
export function windowLine(w: WindowRow): string {
  const used = w.utilisation === null ? 'no fresh reading' : `${(w.utilisation * 100).toFixed(1)}% ${w.status ?? ''}`.trim()
  return `  ${w.kind}\t${String(w.runs)} run(s)\t${String(w.tokens)} tokens\t${used}` +
    `\tobserved ${w.observed_at ?? '-'}\tresets ${w.resets_at ?? '-'}\n`
}

/** `cf tick --dry`: the clock the windows are read against, the lanes open, and what each holds. */
export function dryLines(d: Dry): string {
  const head = `tick --dry\t${d.hhmm} ${offset(d.zone)}\tcap ${name(d.cap)}\t${String(d.pipes)} pipe(s) open\n`
  const would = d.would.map((w) =>
    `  ${w.pipe}\tplan ${String(w.plan)}\tstep ${String(w.step)}\t${w.template}\twould fire\n`)
  const quiet = d.quiet.map((q) => `  ${q.pipe}\t${skipped(q)}\n`)
  const leases = d.held.map((l) => `  plan ${String(l.plan)}\tleased by pid ${String(l.pid)}\tsince ${l.taken_at}\n`)
  return [head, ...would, ...leases, ...quiet].join('')
}

/** The receipt line a tick leaves in `ticks.note`, which is the only log launchd keeps. */
/** `waits` are the plans held on another job's files (#88), so a wait reads as a wait and not an idle lane. */
export function tickNote(fired: Fired[], waits: { plan: number; on: number }[] = []): string {
  const held = waits.map((w) => `plan ${String(w.plan)} waits on plan ${String(w.on)}`)
  const steps = fired.map((f) => `${f.pipe} plan ${String(f.plan)} step ${String(f.step)} ${f.name} ${f.outcome}`
    + (f.stole === null ? '' : ` took over pid ${String(f.stole)}`))
  const all = [...steps, ...held]
  return all.length === 0 ? 'nothing to fire' : all.join('; ')
}

/** Why the tick passed this lane over: it had nothing to step, or the cap ran out before it (#125). */
function skipped(q: Quiet): string {
  if (q.ready > 0) return `on, ${String(q.ready)} ready, cap spent on a lower lane`
  return q.live === 0 ? 'on, nothing queued' : held(q.live)
}

/** A lane with live plans and none it may step is not an empty lane; the count says which it is. */
function held(live: number): string {
  return `on, ${String(live)} queued and blocked`
}

function offset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const held = Math.abs(minutes)
  return `utc${sign}${String(Math.floor(held / 60)).padStart(2, '0')}:${String(held % 60).padStart(2, '0')}`
}
