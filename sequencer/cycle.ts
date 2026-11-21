/** Greptile's billing cycle resets on this day at 00:00 UTC: app.greptile.com/settings/billing. */
export const RESET_DAY = 21

export function cycle(now: Date): { start: Date; reset: Date } {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() - (now.getUTCDate() < RESET_DAY ? 1 : 0)
  return { start: new Date(Date.UTC(y, m, RESET_DAY)), reset: new Date(Date.UTC(y, m + 1, RESET_DAY)) }
}
