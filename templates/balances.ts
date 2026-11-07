const BALANCE = 10n ** 24n

const INTEGER = /^(?:0x[0-9a-f]+|\d+)$/i

function oversized(entry: unknown): boolean {
  if (typeof entry === 'string') return INTEGER.test(entry) && BigInt(entry) > BALANCE
  return typeof entry === 'number' && Number.isInteger(entry) && BigInt(entry) > BALANCE
}

export function clamp(balances: unknown[]): { entries: unknown[]; clamped: string[] } {
  return { entries: balances.map((entry) => oversized(entry) ? `0x${BALANCE.toString(16)}` : entry), clamped: balances.filter(oversized).map(String) }
}

export function funded<T extends { fuzzing?: object }>(config: T): { config: T; clamped: string[] } {
  const balances = (config.fuzzing as { targetContractsBalances?: unknown } | undefined)?.targetContractsBalances
  if (!Array.isArray(balances)) return { config, clamped: [] }
  const { entries, clamped } = clamp(balances)
  return { config: { ...config, fuzzing: { ...config.fuzzing, targetContractsBalances: entries } }, clamped }
}

const SHRINK = 500

/** Medusa fills a key the file leaves out from its defaults, which run Slither and shrink 5000 times. */
export function quieted(config: unknown): unknown {
  if (typeof config !== 'object' || config === null) return config
  const { fuzzing, slither } = config as Record<string, unknown>
  if (typeof fuzzing === 'object' && fuzzing !== null) {
    Object.assign(fuzzing, { shrinkLimit: SHRINK })
  }
  return Object.assign(config, { slither: { ...(slither as object | undefined), useSlither: false } })
}
