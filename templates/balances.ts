const BALANCE = 10n ** 24n

const INTEGER = /^(?:0x[0-9a-f]+|\d+)$/i

function oversized(entry: unknown): boolean {
  if (typeof entry === 'string') return INTEGER.test(entry) && BigInt(entry) > BALANCE
  return typeof entry === 'number' && Number.isInteger(entry) && BigInt(entry) > BALANCE
}

export function clamp(balances: unknown[]): { entries: unknown[]; clamped: string[] } {
  return { entries: balances.map((entry) => oversized(entry) ? `0x${BALANCE.toString(16)}` : entry), clamped: balances.filter(oversized).map(String) }
}
