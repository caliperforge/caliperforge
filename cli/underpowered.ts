import type { Score } from '../store/bench.ts'

export const FLOOR = 250_000

function calls(n: number | null): string {
  return n === null ? '-' : String(n)
}

export function benchSection(rows: Score[]): string {
  const lines = rows.map((s) =>
    `  plan ${String(s.plan)}\t${s.target}\t${s.generator}\t${String(s.not_powered)}\tpre_fix ${calls(s.pre_fix_calls)}\tfix ${calls(s.fix_calls)}\n`)
  return `bench not_powered (${String(rows.length)})\n${rows.length === 0 ? '  none\n' : lines.join('')}`
}
