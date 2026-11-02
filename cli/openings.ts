import type { Listed } from '../precedents/openings.ts'

export function openingLines(rows: Listed[], now: Date): string {
  const recent = rows.filter((r) => now.getTime() - Date.parse(r.first_seen) < 7 * 86_400_000)
  return [...new Set(recent.map((r) => r.repo))].sort().map((repo) => {
    const mine = recent.filter((r) => r.repo === repo)
    return `openings\t${repo}\t${String(mine.length)} new\t${mine.slice(0, 3).map((r) => r.source).join(' ')}\n`
  }).join('')
}
