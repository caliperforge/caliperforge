import { put } from '../sequencer/workspace.ts'
import { live, type Score } from '../store/bench.ts'
import { eventsOf } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { spend } from '../store/runs.ts'
import { classOf, union, type Class, type Row } from './paired.ts'
import { counted } from './powered.ts'

export const KINDS = { map_miss: 'read.map_miss', slice_miss: 'read.slice_miss', map_unused: 'map.unused', reach: 'reach.boundary', checks: 'check.hit',
  reach_fixes: 'reach.fix', fix_turns: 'fix.turn', network: 'run.offline', cost: 'cost.phase', critic: 'critic' } as const

export interface Miss { file: string; line: number }

export interface Unused { row: string }

export interface Reach { met: boolean; reasons: string[] }

export interface Hit { check: string; state: 'found' | 'fixed' | 'left' }

export interface ReachFix { file: string; note: string }

export interface Turn { turn: number; tokens: number; usd: number }

export interface Phase { phase: string; tokens: number; usd: number }

const TITLES = { result: 'Result', probes: 'Probe readings', cost: 'Cost', map: 'Map health', reach: 'Reach', checks: 'Checks', counted: 'Counted' }

const SAID: Record<Class, string> = { catch: 'catch', false_positive: 'false alarm', broken: 'broken', silent: 'silent', not_run: 'not run' }

const TOP = 5

type Section = object | '-'

type Cells = Pick<Score, 'plan' | 'net_usd' | 'catches' | 'false_positives' | 'seconds'>

type Compare = Record<'fizz_lean' | 'fizz_lean_v5', Cells | '-'>

const HEADER = ['generator', 'plan', 'net_usd', 'catches', 'false_positives', 'wall_clock_s']

export function report(db: Db, root: string, plan: number, runs: Row[][], notPowered: Score['not_powered'], refuzz = false, probes: Record<string, string> = {}): void {
  const read = <T>(kind: keyof typeof KINDS): T[] => eventsOf(db, plan, KINDS[kind]).map((e) => JSON.parse(e.message) as T)
  const critic = eventsOf(db, plan, KINDS.critic).map((e) => e.outcome)
  const why = counted(notPowered, critic)
  const { gross, net, credited } = spend(db, plan)
  const sections: Record<keyof typeof TITLES, Section> = {
    result: result(runs, refuzz),
    probes: Object.keys(probes).length === 0 ? '-' : probes,
    cost: { gross_usd: gross, net_usd: net, credited: or(credited), phases: or(read<Phase>('cost')), fix_turns: or(read<Turn>('fix_turns')) },
    map: { ...missed('map_miss', read<Miss>('map_miss')), ...missed('slice_miss', read<Miss>('slice_miss')), unused: or(read<Unused>('map_unused').map((u) => u.row)) },
    reach: read<Reach>('reach').at(-1) ?? '-',
    checks: { hits: or(hits(read<Hit>('checks'))), reach_fixes: or(read<ReachFix>('reach_fixes')), network: or(eventsOf(db, plan, KINDS.network).map((e) => e.message)) },
    counted: { counted: why === null ? 'yes' : 'no', why: why ?? '-', critic: or(critic) },
  }
  const compare = compared(db, plan)
  put(root, plan, 'report.json', JSON.stringify(compare === null ? sections : { ...sections, compare }))
  const md = Object.entries(TITLES).map(([key, title]) => {
    const section = sections[key as keyof typeof TITLES]
    return `## ${title}\n\n${section === '-' ? '-' : Object.entries(section).map(([name, value]) => `- ${name}: ${flat(value)}`).join('\n')}\n`
  })
  if (compare !== null) md.push(table(compare))
  put(root, plan, 'report.md', md.join('\n'))
}

function compared(db: Db, plan: number): Compare | null {
  const rows = live(db)
  const own = rows.find((s) => s.plan === plan)
  if (own?.generator !== 'fizz_lean_v5') return null
  const v4 = rows.findLast((s) => s.target === own.target && s.generator === 'fizz_lean' && s.not_powered !== 'wall')
  return { fizz_lean: v4 === undefined ? '-' : cells(v4), fizz_lean_v5: cells(own) }
}

function cells({ plan, net_usd, catches, false_positives, seconds }: Score): Cells {
  return { plan, net_usd, catches, false_positives, seconds }
}

function table(compare: Compare): string {
  const line = (row: (string | number | null)[]): string => `| ${row.map((c) => String(c ?? '-')).join(' | ')} |`
  return [`## Lean v4 vs v5\n`, line(HEADER), line(HEADER.map(() => '---')),
    ...Object.entries(compare).map(([generator, c]) => line([generator, ...(c === '-' ? HEADER.slice(1).map(() => '-') : Object.values(c))]))].join('\n') + '\n'
}

function or<T>(list: T[]): T[] | '-' {
  return list.length === 0 ? '-' : list
}

function result(runs: Row[][], refuzz: boolean): Section {
  const said: Record<string, string[]> = {}
  runs.forEach((pairs, at) => {
    for (const r of pairs) (said[r.property ?? '-'] ??= runs.map(() => '-'))[at] = SAID[classOf(r)]
  })
  return runs.length === 0 ? '-' : { ...union(runs, refuzz), ...said }
}

function missed(name: string, misses: Miss[]): Record<string, unknown> {
  const top = new Map<string, Miss & { count: number }>()
  for (const { file, line } of misses) {
    const at = `${file}:${String(line)}`
    top.set(at, { file, line, count: (top.get(at)?.count ?? 0) + 1 })
  }
  return { [name]: misses.length === 0 ? '-' : misses.length, [`${name}_top`]: or([...top.values()].sort((a, b) => b.count - a.count).slice(0, TOP)) }
}

function hits(said: Hit[]): Record<'check' | Hit['state'], string | number>[] {
  const count = (check: string, state: Hit['state']): number => said.filter((h) => h.check === check && h.state === state).length
  return [...new Set(said.map((h) => h.check))].map((check) => ({ check, found: count(check, 'found'), fixed: count(check, 'fixed'), left: count(check, 'left') }))
}

function flat(value: unknown): string {
  if (Array.isArray(value)) return value.map(flat).join('; ')
  return typeof value === 'object' && value !== null ? Object.entries(value).map(([key, v]) => `${key} ${flat(v)}`).join(', ') : String(value)
}
