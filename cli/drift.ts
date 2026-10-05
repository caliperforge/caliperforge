import type { Finding } from '../store/drift.ts'
import { line } from './brief.ts'

const OUTCOMES = ['fixed', 'covered', 'retire', 'defect'] as const

export function driftSection(rows: Finding[]): string {
  const counts = OUTCOMES.map((o) => `${String(rows.filter((f) => f.outcome === o).length)} ${o}`)
  return `drift last 7 d\t${String(rows.length)} found → ${counts.join('\t')}\n`
}

export function decisionSection(plans: Parameters<typeof line>[0][], open: Finding[], now: Date): string {
  const hours = (f: Finding): number => Math.floor((now.getTime() - Date.parse(f.found_at)) / 3_600_000)
  const rows = [...plans.map(line), ...open.map((f) => `  finding ${String(f.id)}\t${f.name}\t${f.state}\t${String(hours(f))} h\t${f.detail}`)]
  return `needs a decision (${String(rows.length)})\n${rows.length === 0 ? '  none\n' : `${rows.join('\n')}\n`}`
}
