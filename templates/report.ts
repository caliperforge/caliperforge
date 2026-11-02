import { put } from '../sequencer/workspace.ts'
import type { Score } from '../store/bench.ts'
import { eventsOf } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import type { Row } from './paired.ts'
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

const TITLES = { result: 'Result', cost: 'Cost', map: 'Map health', reach: 'Reach', checks: 'Checks', counted: 'Counted' }

const SAID: Record<string, string> = { catch: 'catch', fp_candidate: 'false alarm', silent: 'silent' }

const TOP = 5

type Section = object | '-'

export function report(db: Db, root: string, plan: number, runs: Row[][], notPowered: Score['not_powered']): void {
  const read = <T>(kind: keyof typeof KINDS): T[] => eventsOf(db, plan, KINDS[kind]).map((e) => JSON.parse(e.message) as T)
  const critic = eventsOf(db, plan, KINDS.critic).map((e) => e.outcome)
  const why = counted(notPowered, critic)
  const sections: Record<keyof typeof TITLES, Section> = {
    result: result(runs),
    cost: { phases: or(read<Phase>('cost')), fix_turns: or(read<Turn>('fix_turns')) },
    map: { ...missed('map_miss', read<Miss>('map_miss')), ...missed('slice_miss', read<Miss>('slice_miss')), unused: or(read<Unused>('map_unused').map((u) => u.row)) },
    reach: read<Reach>('reach').at(-1) ?? '-',
    checks: { hits: or(hits(read<Hit>('checks'))), reach_fixes: or(read<ReachFix>('reach_fixes')), network: or(eventsOf(db, plan, KINDS.network).map((e) => e.message)) },
    counted: { counted: why === null ? 'yes' : 'no', why: why ?? '-', critic: or(critic) },
  }
  put(root, plan, 'report.json', JSON.stringify(sections))
  put(root, plan, 'report.md', Object.entries(TITLES).map(([key, title]) => {
    const section = sections[key as keyof typeof TITLES]
    return `## ${title}\n\n${section === '-' ? '-' : Object.entries(section).map(([name, value]) => `- ${name}: ${flat(value)}`).join('\n')}\n`
  }).join('\n'))
}

function or<T>(list: T[]): T[] | '-' {
  return list.length === 0 ? '-' : list
}

function result(runs: Row[][]): Section {
  const said: Record<string, string[]> = {}
  runs.forEach((pairs, at) => {
    for (const r of pairs) (said[r.property ?? '-'] ??= runs.map(() => '-'))[at] = SAID[r.verdict ?? ''] ?? r.verdict ?? '-'
  })
  return runs.length === 0 ? '-' : said
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
