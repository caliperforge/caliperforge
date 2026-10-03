import { join } from 'node:path'
import { z } from 'zod'
import type { Dry, Quiet } from '../sequencer/index.ts'
import type { Fired } from '../sequencer/kind.ts'
import { CREDITS } from '../sequencer/ready.ts'
import { languageFor } from '../sequencer/route.ts'
import { FORK, maybe, planDir, ruled } from '../sequencer/workspace.ts'
import type { Db } from '../store/index.ts'
import { name, type LaneState, type WindowRow } from '../store/lanes.ts'
import { BUILT, planById, type Holder, type Overlap, type Wait } from '../store/plans.ts'
import { heads } from '../store/signals.ts'
import { gh, type Read, WINDOW } from './gh.ts'
import { LANE, LANES } from './plan.ts'

interface PlanLine {
  id: number
  step: number
  state: string
  repo: string | null
  issue_no: number | null
  held_why: string | null
}

interface Day {
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

const LINES = `SELECT p.id, p.step, p.state, t.repo, t.issue_no, p.held_why
  FROM plans p LEFT JOIN targets t ON t.id = p.target_id`

export function open(db: Db): PlanLine[] {
  return db.prepare(`${LINES} WHERE p.state IN ('queued', 'running') AND p.step <> 7 ORDER BY p.queued_at, p.id`).all() as PlanLine[]
}

export function halted(db: Db): PlanLine[] {
  return db.prepare(`${LINES} WHERE p.state = 'halted' ORDER BY p.queued_at, p.id`).all() as PlanLine[]
}

export function heldBy(db: Db, by: Holder): PlanLine[] {
  return db.prepare(`${LINES} WHERE p.held_by = ? AND p.waits_on IS NULL ORDER BY p.queued_at, p.id`).all(by) as PlanLine[]
}

export function day(db: Db): Day {
  return db.prepare(`SELECT count(*) AS runs,
    coalesce(sum(input_tokens + cache_read_tokens + output_tokens), 0) AS tokens,
    coalesce(sum(seconds), 0) AS seconds
    FROM runs WHERE julianday(at) >= julianday('now', '-1 day')`).get() as Day
}

const ACTORS = ['ceo', 'coo', 'coo_lite', 'orchestrator', 'fixer'] as const

type Actor = typeof ACTORS[number]

const SEATED: readonly Actor[] = ['coo_lite', 'orchestrator', 'fixer']

interface ActorRow {
  actor: Actor
  kinds: { kind: string; n: number }[]
  runs: { runs: number; cost: number } | null
  scored: { held: number; missed: number; open: number }
}

export function actors(db: Db, now: Date): ActorRow[] {
  const at = now.toISOString()
  const kinds = db.prepare(`SELECT actor, kind, count(*) AS n FROM events
    WHERE julianday(at) >= julianday(?, '-1 day') GROUP BY actor, kind ORDER BY kind`)
    .all(at) as { actor: string; kind: string; n: number }[]
  const runs = db.prepare(`SELECT seat, count(*) AS runs, coalesce(sum(cost_usd), 0) AS cost FROM runs
    WHERE NOT (${BUILT}) AND julianday(at) >= julianday(?, '-1 day') GROUP BY seat`)
    .all(at) as { seat: string; runs: number; cost: number }[]
  const scored = db.prepare(`SELECT actor, outcome, count(*) AS n FROM outcomes
    WHERE julianday(at) >= julianday(?, '-7 day') GROUP BY actor, outcome`)
    .all(at) as { actor: string; outcome: 'held' | 'missed' | 'open'; n: number }[]
  return ACTORS.map((actor) => ({
    actor,
    kinds: kinds.filter((k) => k.actor === actor).map(({ kind, n }) => ({ kind, n })),
    runs: SEATED.includes(actor) ? runs.find((r) => r.seat === actor) ?? { runs: 0, cost: 0 } : null,
    scored: scored.filter((s) => s.actor === actor).reduce((sum, s) => ({ ...sum, [s.outcome]: s.n }), { held: 0, missed: 0, open: 0 }),
  }))
}

const Merges = z.array(z.object({ headRefName: z.string(), mergedAt: z.string() }))

export function hands(now: Date, read: Read = gh): number {
  const from = now.getTime() - 86_400_000
  const since = new Date(from).toISOString().slice(0, 10)
  return [...new Set(LANES.map((l) => LANE[l].home))].reduce((n, repo) => {
    const got = Merges.parse(read(['pr', 'list', '--repo', repo, '--state', 'merged', '--search', `merged:>=${since}`,
      '--limit', String(WINDOW), '--json', 'headRefName,mergedAt']))
    if (got.length === WINDOW) throw new Error(`${repo} lists ${String(WINDOW)} merged PRs, the limit; the count may be cut short`)
    return n + got.filter((p) => p.headRefName.startsWith('hand-') &&
      Date.parse(p.mergedAt) >= from && Date.parse(p.mergedAt) <= now.getTime()).length
  }, 0)
}

function actorLine(r: ActorRow): string {
  const n = r.kinds.reduce((sum, k) => sum + k.n, 0)
  const kinds = r.kinds.length === 0 ? '-' : r.kinds.map((k) => `${k.kind} ${String(k.n)}`).join(', ')
  const runs = r.runs === null ? '' : `\t${String(r.runs.runs)} run(s)\t$${r.runs.cost.toFixed(2)}`
  const s = r.scored
  return `  ${r.actor}\t${String(n)} intervention(s)\t${kinds}${runs}` +
    `\theld ${String(s.held)} missed ${String(s.missed)} open ${String(s.open)}\n`
}

export function actorSection(rows: ActorRow[], hands: number): string {
  return `last 24 h by actor, held/missed/open over 7 d\n${rows.map(actorLine).join('')}  hand PRs merged\t${String(hands)}\n`
}

/** Per-ticket usage is read as two eras, split at this instant. */
const ERA = '2026-09-19 11:21'

const TICKETS = `SELECT p.id AS plan, p.origin, t.repo || '#' || t.issue_no AS target,
  count(*) AS runs,
  sum(r.step = 2 AND r.${BUILT}) AS build,
  sum(r.step IN (4, 5) AND r.${BUILT}) AS review,
  sum(r.seconds) / 60.0 AS minutes,
  sum(r.input_tokens + r.cache_read_tokens + r.output_tokens) AS tokens,
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
  return `  plan ${String(p.id)}\tstep ${String(p.step)}\t${p.state}\t${target}${p.held_why === null ? '' : `\t${p.held_why}`}`
}

export function section(title: string, rows: PlanLine[]): string {
  const body = rows.length === 0 ? '  none\n' : `${rows.map(line).join('\n')}\n`
  return `${title} (${String(rows.length)})\n${body}`
}

export function rulings(db: Db, root: string): string {
  const plans = db.prepare("SELECT id FROM plans WHERE state NOT IN ('done', 'refused') ORDER BY id").all() as { id: number }[]
  return plans.filter((p) => ruled(root, p.id) !== null)
    .map((p) => `ask\tplan ${String(p.id)}: ask.md differs from the ask its issue.md was briefed from\n`).join('')
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

export function fileWaits(rows: Overlap[]): string {
  const body = rows.length === 0 ? '  none\n' : rows.map((w) => `  plan ${String(w.plan)}\ton plan ${String(w.on)}\t${w.path ?? '-'}\n`).join('')
  return `waiting on files (${String(rows.length)})\n${body}`
}

export function driftSection(rows: { number: number; title: string; days: number | null }[]): string {
  const body = rows.length === 0 ? '  none\n' : rows.map((d) => `  #${String(d.number)}\t${d.title}\t${d.days === null ? '-' : String(d.days)} d\n`).join('')
  return `drift (${String(rows.length)})\n${body}`
}

export function greptileLine(n: number): string {
  return `greptile ${String(n)}/${String(CREDITS)} this month\n`
}

interface Miss { language: string; passed: number; down: number; findings: number }

export function misses(db: Db, root: string, now: Date): Miss[] {
  const by = new Map<string, Miss>()
  for (const h of heads(db, `${FORK}/*`, now)) {
    const language = languageFor(db, planById(db, h.plan), join(planDir(root, h.plan), 'src')) ?? '-'
    const row = by.get(language) ?? { language, passed: 0, down: 0, findings: 0 }
    by.set(language, row)
    row.passed++
    if ((h.score ?? 0) >= 5) continue
    row.down++
    row.findings += (maybe(root, h.plan, `findings-${h.head}.md`) ?? '').split('\n').filter((l) => l.startsWith('- G')).length
  }
  return [...by.values()].sort((a, b) => a.language.localeCompare(b.language))
}

export function missSection(rows: Miss[]): string {
  const lines = rows.map((m) => `  ${m.language} ${String(m.passed)} passed, ${String(m.down)} marked down` +
    `${m.down > 0 ? `, ${String(m.findings)} findings` : ''}\n`)
  return `greptile after both reviewers passed, last 30 d\n${rows.length === 0 ? '  none\n' : lines.join('')}`
}

/** One row per rate-limit window: our tokens inside it, the provider's utilisation of it, the cap. */
export function windowLine(w: WindowRow): string {
  const used = w.utilisation === null ? 'no fresh reading' : `${(w.utilisation * 100).toFixed(1)}% ${w.status ?? ''}`.trim()
  return `  ${w.kind}\t${String(w.runs)} run(s)\t${String(w.tokens)} tokens\t${byType(w)}\t${used}` +
    `\tobserved ${w.observed_at ?? '-'}\tresets ${w.resets_at ?? '-'}\n`
}

export type ByType = Pick<WindowRow, 'uncached_tokens' | 'cache_write_tokens' | 'cache_read_tokens' | 'output_tokens'>

export function byType(t: ByType): string {
  return `${String(t.uncached_tokens)} uncached\t${String(t.cache_write_tokens)} cache write` +
    `\t${String(t.cache_read_tokens)} cache read\t${String(t.output_tokens)} output`
}

interface Cost extends ByType {
  provider: string
  model: string
  runs: number
  computed: number | null
  reported: number | null
}

interface Model { provider: string; model: string }

const LAST_DAY = "julianday(at) >= julianday('now', '-1 day')"

export function costs(db: Db): Cost[] {
  return db.prepare(`SELECT provider, model, count(*) AS runs,
    sum(input_tokens - coalesce(cache_write_tokens, 0)) AS uncached_tokens, sum(coalesce(cache_write_tokens, 0)) AS cache_write_tokens,
    sum(cache_read_tokens) AS cache_read_tokens, sum(output_tokens) AS output_tokens,
    sum(cost_computed_usd) AS computed, sum(cost_usd) AS reported
    FROM runs WHERE ${LAST_DAY} GROUP BY provider, model ORDER BY provider, model`).all() as Cost[]
}

export function unpriced(db: Db): Model[] {
  return db.prepare(`SELECT DISTINCT provider, model FROM runs r WHERE ${LAST_DAY}
    AND NOT EXISTS (SELECT 1 FROM prices p WHERE p.provider = r.provider AND p.model = r.model
      AND julianday(p.effective_from) <= julianday(r.at))
    ORDER BY provider, model`).all() as Model[]
}

function usd(n: number | null): string {
  return n === null ? '-' : `$${n.toFixed(4)}`
}

export function costSection(rows: Cost[], missing: Model[]): string {
  const lines = rows.map((c) => `  ${c.provider}/${c.model}\t${String(c.runs)} run(s)\t${byType(c)}` +
    `\tcomputed ${usd(c.computed)}\treported ${usd(c.reported)}\n`)
  const body = rows.length === 0 ? '  none\n' : lines.join('')
  return `cost last 24 h by model (${String(rows.length)})\n${body}` +
    missing.map((m) => `  no price row\t${m.provider}/${m.model}\n`).join('')
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

/** The receipt line a tick leaves in `ticks.note`, the only log launchd keeps; a plan held on another job's files reads as a wait, not an idle lane. */
export function tickNote(fired: Fired[], waits: Overlap[] = [], lines: string[] = []): string {
  const held = waits.map((w) => `plan ${String(w.plan)} waits on plan ${String(w.on)}${w.path === null ? '' : ` for ${w.path}`}`)
  const steps = fired.map((f) => `${f.pipe} plan ${String(f.plan)} step ${String(f.step)} ${f.name} ${f.outcome}`
    + (f.stole === null ? '' : ` took over pid ${String(f.stole)}`))
  const all = [...steps, ...held, ...lines]
  return all.length === 0 ? 'nothing to fire' : all.join('; ')
}

/** Why the tick passed this lane over: it had nothing to step, or the cap ran out before it. */
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
