import type { Db } from '../store/index.ts'
import { briefRefusals } from '../store/refusals.ts'

interface RefusalDay { day: string; total: number; reasons: [string, number][] }

export function refusalDays(db: Db, now: Date): RefusalDay[] {
  const rows = briefRefusals(db, now)
  return [6, 5, 4, 3, 2, 1, 0].map((back) => {
    const day = new Date(now.getTime() - back * 86_400_000).toISOString().slice(0, 10)
    const counts = new Map<string, number>()
    for (const why of rows.filter((r) => r.day === day).map(reason)) counts.set(why, (counts.get(why) ?? 0) + 1)
    const reasons = [...counts].sort(([a, m], [b, n]) => n - m || a.localeCompare(b))
    return { day, total: reasons.reduce((sum, [, n]) => sum + n, 0), reasons }
  })
}

function reason(r: { span: string | null; note: string | null }): string {
  if (r.note === null) return 'unrecorded'
  const said = r.note.replace(/^[\w-]+: /, '')
  return (r.span === null || r.span === '' ? said : said.replaceAll(r.span, '<span>')).replace(/\d+/g, 'n')
}

export function refusalSection(days: RefusalDay[]): string {
  return 'brief writer refusals last 7 d\n' + days.map((d) => `  ${d.day}\t${String(d.total)}\t` +
    `${d.reasons.length === 0 ? 'none' : d.reasons.map(([why, n]) => `${why} ${String(n)}`).join('\t')}\n`).join('')
}
