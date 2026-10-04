import type { HandUps } from '../store/events.ts'

export function handUpLine({ decided, up }: HandUps): string {
  const pct = decided + up === 0 ? 0 : Math.round(up * 100 / (decided + up))
  return `director: ${String(decided)} decided, ${String(up)} handed up (${String(pct)}%) over 7 d\n`
}
