import { join } from 'node:path'
import { z } from 'zod'
import type { Dry, Quiet } from '../sequencer/index.ts'
import type { Fired } from '../sequencer/kind.ts'
import { CREDITS } from '../sequencer/ready.ts'
import { languageFor } from '../sequencer/route.ts'
import { FORK, maybe, planDir, ruled } from '../sequencer/workspace.ts'
import { ERA, openIds, type ActorRow, type ByType, type Cost, type Model, type PlanLine, type Ticket } from '../store/brief.ts'
import type { Db } from '../store/index.ts'
import { name, type LaneState, type WindowRow } from '../store/lanes.ts'
import { planById, type Overlap, type Wait } from '../store/plans.ts'
import { heads } from '../store/signals.ts'
import { gh, type Read, WINDOW } from './gh.ts'
import { LANE, LANES } from './plan.ts'

export { actors, costs, day, halted, heldBy, open, runsOf, tickets, unpriced, verdictsOf, waits, type ByType, type Ticket } from '../store/brief.ts'

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
  return openIds(db).filter((id) => ruled(root, id) !== null)
    .map((id) => `ask\tplan ${String(id)}: ask.md differs from the ask its issue.md was briefed from\n`).join('')
}

export function laneLine(l: LaneState): string {
  return `lanes ${String(l.live)}/${String(l.open)} live/open\tcap ${name(l.cap)}\tdial ${String(l.dial)}` +
    `\tband ${name(l.band)}\tceiling ${String(l.ceiling)}\n`
}

export function waitLine(rows: { reason: Wait; plans: number }[]): string {
  const pairs = rows.length === 0 ? ['none'] : rows.map((w) => `${w.reason} ${String(w.plans)}`)
  return `waits\t${pairs.join('\t')}\n`
}

export function fileWaits(rows: Overlap[]): string {
  const body = rows.length === 0 ? '  none\n' : rows.map((w) => `  plan ${String(w.plan)}\ton plan ${String(w.on)}\t${w.path ?? '-'}\n`).join('')
  return `waiting on files (${String(rows.length)})\n${body}`
}

export function greptileLine(n: number): string {
  return `greptile ${String(n)}/${String(CREDITS)} this month\n`
}

interface Miss { language: string; passed: number; down: number; findings: number }

export function misses(db: Db, root: string, now: Date): Miss[] {
  const by = new Map<string, Miss>()
  const seen = new Set<string>()
  for (const h of heads(db, `${FORK}/*`, now)) {
    const language = languageFor(db, planById(db, h.plan), join(planDir(root, h.plan), 'src')) ?? '-'
    const row = by.get(language) ?? { language, passed: 0, down: 0, findings: 0 }
    by.set(language, row)
    row.passed++
    if ((h.score ?? 0) >= 5) continue
    row.down++
    for (const id of (maybe(root, h.plan, `findings-${h.head}.md`) ?? '').match(/^- G\d+/gm) ?? []) seen.add(`${language}\t${id}`)
    row.findings = [...seen].filter((k) => k.startsWith(`${language}\t`)).length
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

export function byType(t: ByType): string {
  return `${String(t.uncached_tokens)} uncached\t${String(t.cache_write_tokens)} cache write` +
    `\t${String(t.cache_read_tokens)} cache read\t${String(t.output_tokens)} output`
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
