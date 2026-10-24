import type { Tally } from '../store/record.ts'

export function outsideSection(t: Tally, now: Date): string {
  if (t.open === 0) return 'outside PRs open (0)\n  none\n'
  const days = t.oldest === null ? '-' : String(Math.floor((now.getTime() - Date.parse(t.oldest)) / 86_400_000))
  return `outside PRs open (${String(t.open)})\n  ball us ${String(t.us)}\toldest ${days} d since a human word\n`
}
