import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { filled, type Refused } from './handoff.ts'
import { laid, RANGE } from './map.ts'
import type { Reach } from './report.ts'
import { callee, NONE, type Row, rows } from './slices.ts'

export interface ProbeReadings { limits: Record<string, { max: bigint }>; conversions: Record<string, { min: bigint; max: bigint; saw1Wei: boolean }> }

export interface Item { key: string; met: boolean; cells: string[]; note: string; reverts: string[]; located: boolean; misread: boolean }

type Judged = Pick<Item, 'met' | 'cells' | 'note' | 'misread'>

interface Metrics { totalCalls: number; totalReverts: number; revertReasonMetrics: Record<string, { count: number }> }

export interface Revert { contractRevertMetrics: Partial<Record<string, { functionRevertMetrics: Record<string, Metrics> }>> }

interface Read { root: string; rows: Map<string, Row[]>; hits: (file: string) => Map<number, number>; metrics: (name: string) => Metrics; all: Metrics; probes: ProbeReadings }

const DA = /^DA:(\d+),(\d+)/
const INTEGER = /\b(\d[\d_]*)(?:e(\d+)|\*\*(\d+))?\b/
const LITERAL = /"([^"]*)"/
const ERROR = /\b(?:revert\s+|,\s*)(?:\w+\.)*([A-Z]\w*)\s*\(/
const TYPES: [string, RegExp][] = [['allowance/balance', /allowance|balance/i], ['cap/limit', /cap|limit|max|exceed/i],
  ['access', /owner|role|auth|access|only/i], ['paused', /paus/i]]
const FLOORS = { lines: 50, success: 10 }
const WIDE = 10n ** 24n
const UNLOCATED: Judged = { met: false, cells: ['at: none'], note: 'no at: <file> L<start>-L<end> in map.md', misread: false }

const yes = (b: boolean): string => b ? 'yes' : 'no'

const pct = (part: number, whole: number): number => whole === 0 ? 0 : Math.round(part * 100 / whole)

const floored = (key: keyof typeof FLOORS, n: number): string => `${key}: ${String(n)}%${n < FLOORS[key] ? ` (below ${String(FLOORS[key])})` : ''}`

function span(row: Row | undefined): [string, number, number] | undefined {
  const [, file, start, end] = RANGE.exec(row?.cells.get('at') ?? '') ?? []
  return file === undefined ? undefined : [file, Number(start), Number(end)]
}

export const covered = (lcov: string) => (file: string): Map<number, number> => {
  const hits = new Map<number, number>()
  for (const lines of lcov.split('end_of_record').map((r) => r.split('\n').map((l) => l.trim()))) {
    if (!lines.some((l) => l.startsWith('SF:') && l.endsWith(`/${file}`))) continue
    for (const [, line = '', n = ''] of lines.map((l) => DA.exec(l)).filter((m) => m !== null)) hits.set(Number(line), (hits.get(Number(line)) ?? 0) + Number(n))
  }
  return hits
}

const functions = (report: Revert): [string, Metrics][] => Object.values(report.contractRevertMetrics).flatMap((c) => Object.entries(c?.functionRevertMetrics ?? {}))

function summed(read: Metrics[]): Metrics {
  const reasons: Metrics['revertReasonMetrics'] = {}
  for (const [reason, { count }] of read.flatMap((m) => Object.entries(m.revertReasonMetrics))) reasons[reason] = { count: (reasons[reason]?.count ?? 0) + count }
  return { totalCalls: read.reduce((n, m) => n + m.totalCalls, 0), totalReverts: read.reduce((n, m) => n + m.totalReverts, 0), revertReasonMetrics: reasons }
}

export const handled = (report: Revert, handlers: Row[]) => (name: string): Metrics => {
  const fns = functions(report)
  return summed(handlers.filter((h) => h.cells.get('target') === callee(name)).map((h) => h.name.split('.').at(-1) ?? '')
    .flatMap((fn) => fns.find(([k]) => k === fn || k.startsWith(`${fn}(`))?.[1] ?? []))
}

const reverts = (m: Metrics): string[] => Object.entries(m.revertReasonMetrics).sort(([, a], [, b]) => b.count - a.count)
  .map(([reason, { count }]) => `${reason} [${TYPES.find(([, re]) => re.test(reason))?.[0] ?? 'other'}] ${String(count)}`)

function integer(text: string): bigint | undefined {
  const [, base, e, power] = INTEGER.exec(text) ?? []
  if (base === undefined) return undefined
  const b = BigInt(base.replaceAll('_', ''))
  return e !== undefined ? b * 10n ** BigInt(e) : power !== undefined ? b ** BigInt(power) : b
}

function entry({ rows: map, hits, metrics }: Read, { name }: Row): Judged {
  const m = metrics(name)
  const successes = m.totalCalls - m.totalReverts
  const at = span(map.get('Signatures')?.find((s) => s.name.startsWith(`${name.split('(')[0] ?? ''}(`)))
  if (at === undefined) return UNLOCATED
  const [file, start, end] = at
  const lines = [...hits(file)].filter(([l]) => l >= start && l <= end)
  const targeted = (map.get('Handlers') ?? []).some((h) => h.cells.get('target') === callee(name))
  return { met: successes > 0, note: m.totalCalls === 0 ? 'never called' : 'no successful call',
    misread: targeted && m.totalCalls === 0 && lines.some(([, n]) => n > 0),
    cells: [`calls: ${String(m.totalCalls)}`, `successes: ${String(successes)}`, floored('success', pct(successes, m.totalCalls)),
      floored('lines', pct(lines.filter(([, n]) => n > 0).length, lines.length)), `reverts: ${reverts(m).join(', ') || 'none'}`] }
}

const named = (re: RegExp, source: string): string[] => [...source.matchAll(new RegExp(re, 'g'))].map((m) => m[1] ?? '')

function guard({ root, rows: map, metrics, all }: Read, row: Row): Judged {
  const at = span(row)
  if (at === undefined) return UNLOCATED
  const [file, start, end] = at
  const source = readFileSync(join(root, file), 'utf8').split('\n').slice(start - 1, end).join('\n')
  const targeted = (map.get('Handlers') ?? []).some((h) => h.cells.get('target') === callee(row.name))
  const [m, literals, errors] = [targeted ? metrics(row.name) : all, named(LITERAL, source), named(ERROR, source)]
  const seen = (match: (reason: string) => boolean): boolean => Object.entries(m.revertReasonMetrics).some(([r, { count }]) => match(r) && count > 0)
  const passing = m.totalCalls - m.totalReverts > 0
  const reverting = literals.length + errors.length === 0 ? m.totalReverts > 0
    : seen((r) => literals.includes(r) || errors.some((e) => new RegExp(`(?<!\\w)${e}(?!\\w)`).test(r)))
  return { met: passing && reverting, cells: [`passing: ${yes(passing)}`, `reverting: ${yes(reverting)}`], misread: false,
    note: [...(passing ? [] : ['passing never seen']), ...(reverting ? [] : ['reverting never seen'])].join(', ') }
}

function limit({ probes }: Read, { name, cells }: Row): Judged {
  const [probe, bound] = [probes.limits[name], integer(cells.get('bound') ?? '')]
  if (probe === undefined || bound === undefined) return { met: false, cells: [], note: probe === undefined ? 'no probe reading' : 'bound has no integer literal', misread: false }
  const met = (probe.max > bound ? probe.max - bound : bound - probe.max) * 100n <= bound
  return { met, cells: [`bound: ${String(bound)}`, `max: ${String(probe.max)}`], note: `max ${String(probe.max)} is not within 1% of ${String(bound)}`, misread: false }
}

function conversion({ probes }: Read, { name }: Row): Judged {
  const probe = probes.conversions[name]
  if (probe === undefined) return { met: false, cells: [], note: 'no probe reading', misread: false }
  const notes = [...(probe.saw1Wei ? [] : ['no 1-wei case']), ...(probe.max >= WIDE ? [] : ['max below 1e24'])]
  return { met: notes.length === 0, cells: [`min: ${String(probe.min)}`, `max: ${String(probe.max)}`, `1 wei: ${yes(probe.saw1Wei)}`], note: notes.join(', '), misread: false }
}

const JUDGES: Record<string, (read: Read, row: Row) => Judged> = { 'Selected entry points': entry, Guards: guard, Limits: limit, 'Conversion points': conversion }

export function reach(root: string, map: string, lcov: string, report: string, probes: ProbeReadings): Item[] {
  const [mapped, revert] = [rows(map), JSON.parse(readFileSync(report, 'utf8')) as Revert]
  const read: Read = { root, rows: mapped, hits: covered(readFileSync(lcov, 'utf8')), metrics: handled(revert, mapped.get('Handlers') ?? []),
    all: summed(functions(revert).map(([, m]) => m)), probes }
  return Object.entries(JUDGES).flatMap(([section, judge]) => (read.rows.get(section) ?? []).filter((row) => row.name !== NONE).map((row) => {
    const [key, judged] = [`${section} ${row.name}`, judge(read, row)]
    return { ...judged, key, note: judged.met ? '' : `${key}: ${judged.note}`, reverts: reverts(read.metrics(row.name)), located: judged !== UNLOCATED }
  }))
}

export function unlocated(items: Item[]): Refused[] {
  const keys = items.filter((i) => !i.located).map((i) => i.key)
  return keys.length === 0 ? [] : [{ rule: 'reach.unlocated', note: `${String(keys.length)} row(s) have no at: <file> L<start>-L<end> in map.md: ${keys.join(', ')}` }]
}

export function misread(items: Item[]): Refused[] {
  const keys = items.filter((i) => i.misread).map((i) => i.key)
  return keys.length === 0 ? [] : [{ rule: 'reach.misread', note: `${String(keys.length)} entry point(s) read 0 calls through ## Handlers on lines lcov.info hit: ${keys.join(', ')}` }]
}

export function written(map: string, items: Item[]): string {
  return laid(map, 'Reach', items.map((i) => [i.key, `met: ${yes(i.met)}`, ...i.cells].join(' | ')))
}

export function unmet(map: string, items: Item[]): Item[] {
  const reasoned = (rows(map).get('Unreachable') ?? []).filter(({ cells }) => filled(cells.get('reason'))).map((r) => r.name)
  return items.filter((i) => i.located && !i.met && !reasoned.includes(i.key))
}

export function met(map: string, items: Item[]): Reach {
  const left = unmet(map, items)
  return { met: left.length === 0, reasons: left.map((i) => i.note) }
}
