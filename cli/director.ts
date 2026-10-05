import type { DirectorDay } from '../store/decisions.ts'
import type { HandUps } from '../store/events.ts'

export function handUpLine({ decided, up }: HandUps): string {
  const pct = decided + up === 0 ? 0 : Math.round(up * 100 / (decided + up))
  return `director: ${String(decided)} decided, ${String(up)} handed up (${String(pct)}%) over 7 d\n`
}

export function directorSection(rows: DirectorDay[], now: Date): string {
  return 'director by day, last 7 d\n' + [6, 5, 4, 3, 2, 1, 0].map((back) => {
    const day = new Date(now.getTime() - back * 86_400_000).toISOString().slice(0, 10)
    const r = rows.find((row) => row.day === day) ?? { seen: 0, decided: 0, fixer: 0, ceo: 0, held: 0, missed: 0 }
    return `  ${day}\t${String(r.seen)} seen\t${String(r.decided)} decided\t${String(r.fixer)} to fixer\t${String(r.ceo)} to ceo\t` +
      `held ${String(r.held)} missed ${String(r.missed)}\n`
  }).join('')
}
