import type { Drift } from '../store/drift.ts'

export function driftSection(rows: Drift[]): string {
  const body = rows.length === 0 ? '  none\n' : rows.map((d) => `  #${String(d.number)}\t${d.title}\t${d.days === null ? '-' : String(d.days)} d\n`).join('')
  return `drift (${String(rows.length)})\n${body}`
}
