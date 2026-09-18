import type { Dry } from '../sequencer/index.ts'
import type { Fired } from '../sequencer/kind.ts'
import type { Db } from '../store/index.ts'
import { name, type LaneState, type WindowRow } from '../store/lanes.ts'

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
  const quiet = d.quiet.map((q) => `  ${q.pipe}\t${q.live === 0 ? 'on, nothing queued' : held(q.live)}\n`)
  return [head, ...would, ...quiet].join('')
}

/** The receipt line a tick leaves in `ticks.note`, which is the only log launchd keeps. */
export function tickNote(fired: Fired[]): string {
  if (fired.length === 0) return 'nothing to fire'
  return fired.map((f) => `${f.pipe} plan ${String(f.plan)} step ${String(f.step)} ${f.name} ${f.outcome}`).join('; ')
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
