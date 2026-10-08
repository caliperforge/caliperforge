import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { BUILD, fingerprint, refusalRows, WHY, type Why } from '../store/refusals.ts'
import type { Step } from '../templates/pr-path.ts'
import type { Outcome } from './kind.ts'
import { maybe, put } from './workspace.ts'

/** Builds a plan runs, since a ceo or coo last returned or retried it, before the next waits for the director, whatever `clear()` and `retry()` reset. */
export const BUILDS = 5

/** Refusals in a row from one rail or reviewer past the build before the plan waits for the director. */
export const STREAK = 3

/** The rail or reviewer that refused: `tight: …`, then `greptile:3/5` or `checks:test`, then `code_quality refuse`. */
function sourceOf(step: number, span: string | null, note: string | null): string {
  return /^([a-z_-]+): /.exec(note ?? '')?.[1] ?? /^([a-z_-]+):/.exec(span?.split(', ')[0] ?? '')?.[1]
    ?? /^([a-z_-]+)\b/.exec(note ?? '')?.[1] ?? `step ${String(step)}`
}

/** The source of the plan's newest refusal past the build, and how many in a row it refused, cleared or not. */
export function streak(db: Db, plan: number): { source: string; n: number } | null {
  const past = refusalRows(db, plan).filter((r) => r.step > BUILD).map((r) => sourceOf(r.step, r.span, r.note))
  const n = past.findIndex((s) => s !== past[0])
  return past[0] === undefined ? null : { source: past[0], n: n === -1 ? past.length : n }
}

/** Every refusal the plan had, cleared or not, grouped by source and then by span, most first. */
export function reasons(db: Db, plan: number): { source: string; n: number; spans: { span: string; n: number }[] }[] {
  const groups = new Map<string, Map<string, number>>()
  for (const r of refusalRows(db, plan)) {
    const source = sourceOf(r.step, r.span, r.note)
    const spans = groups.get(source) ?? new Map<string, number>()
    const span = r.span === null || r.span === '' ? '(none named)' : r.span
    groups.set(source, spans.set(span, (spans.get(span) ?? 0) + 1))
  }
  const most = <T extends { n: number }>(rows: T[]): T[] => rows.sort((a, b) => b.n - a.n)
  return most([...groups].map(([source, spans]) => ({ source, n: [...spans.values()].reduce((a, b) => a + b, 0),
    spans: most([...spans].map(([span, n]) => ({ span, n }))) })))
}

/** Writes director.md with every reason the plan was refused, logs the stop, and returns `why` as its note. */
export function capped(db: Db, root: string, plan: number, why: string): string {
  const groups = reasons(db, plan).map((g) => `## ${g.source}: ${String(g.n)}\n\n${g.spans.map((s) => `- ${s.span} (${String(s.n)})`).join('\n')}\n`)
  put(root, plan, 'director.md', ['# Build cap', '', why, '', ...groups].join('\n'))
  logged(db, { plan, kind: 'build_cap', actor: 'settle', outcome: 'needs_ceo', message: why, pointer: 'director.md', run: null })
  return why
}

/**
 * A failed check or CI run is known by what failed, not by the one span every such failure shares. So is a
 * `text:N` span, a line of this job's own brief or handback: two jobs refused at the same `text:N` for different
 * names are two faults, not one on main.
 */
export function fingerprintOf(step: Step, outcome: Outcome): string {
  const checked = outcome.spans.some((s) => s.startsWith('checks:') || s.startsWith('ci.red'))
  const own = outcome.spans.some((s) => s.startsWith('text:'))
  return fingerprint(step.step, own ? [...outcome.spans, outcome.note] : outcome.spans, checked ? (outcome.message ?? '') : '')
}

export function stopped(root: string, plan: number, why: Exclude<Why, 'again'>): void {
  put(root, plan, 'refusal.md', `${maybe(root, plan, 'refusal.md') ?? ''}
# Stopped

${WHY[why]}.
`)
}

export function refusalText(step: Step, outcome: Outcome): string {
  const spans = outcome.spans.length === 0 ? '  (none named)' : outcome.spans.map((s) => `  - ${s}`).join('\n')
  const words = outcome.message === undefined ? '' : `\n${outcome.message}\n`
  return `step ${String(step.step)} ${step.name} refused by ${step.runs}\n\n${outcome.note}\n\nspans:\n${spans}\n${words}`
}
