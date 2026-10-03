import type { Switch } from '../store/switches.ts'

function switchLine(s: Switch, now: Date): string {
  const days = Math.floor((now.getTime() - Date.parse(s.since)) / 86_400_000)
  const stale = days > 3 ? `\tstill in shadow since ${s.since.slice(0, 10)}: go live or remove` : ''
  return `  ${s.key}\t${s.value ?? 'no row'}\t${String(days)} d${stale}\n`
}

export function switchSection(rows: Switch[], now: Date): string {
  const body = rows.length === 0 ? '  none\n' : rows.map((s) => switchLine(s, now)).join('')
  return `switches (${String(rows.length)})\n${body}`
}
