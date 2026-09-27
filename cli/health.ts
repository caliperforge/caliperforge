import { counts, METRICS } from '../checks/ratchet.ts'
import { counted, raises, record, warnings } from '../store/health.ts'
import type { Db } from '../store/index.ts'

const WEEK = 7 * 86400000

export function health(db: Db, root: string, today: string): string {
  const tallies = Object.values(counts(root))
  const now = METRICS.map((metric) => ({ metric, count: tallies.reduce((sum, t) => sum + (t[metric] ?? 0), 0) }))
  record(db, today, now)
  const since = new Date(Date.parse(today) - WEEK).toISOString().slice(0, 10)
  const then = counted(db, since)
  return [
    ...now.map((n) => `${n.metric}\t${String(n.count)}\t${delta(n.count, then.get(n.metric))}`),
    ...warnings(db, since).map((w) => `warn\tplan ${String(w.plan)}\t${w.at}\t${w.message}`),
    ...raises(db).map((r) => `raise\t${r.key}\t${r.value}\t${r.origin_kind}:${r.origin_ref}\t${r.set_at}`),
  ].map((line) => `${line}\n`).join('')
}

function delta(count: number, was: number | undefined): string {
  if (was === undefined) return '-'
  return count > was ? `+${String(count - was)}` : String(count - was)
}
