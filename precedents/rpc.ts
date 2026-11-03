export type Reply = { result: unknown } | { error: { code: number; message: string; data?: unknown } }

export type Compared = { verdict: 'same' } | { verdict: 'mainnet-disabled' }
  | { verdict: 'differs'; on: 'code' | 'message' | 'shape'; mainnet: string; surfpool: string }

type Shape = string | Shape[] | { [key: string]: Shape }

export const masked = (message: string): string =>
  message.replace(/([1-9A-HJ-NP-Za-km-z]{32,88})|\d+/g, (...run: (string | undefined)[]) => run[1] === undefined ? '<n>' : '<b58>')

export function compared(mainnet: Reply, surfpool: Reply): Compared {
  if ('error' in mainnet && /disabled/i.test(mainnet.error.message)) return { verdict: 'mainnet-disabled' }
  const [m, s] = [code(mainnet), code(surfpool)]
  if (m !== s) return differs('code', m, s)
  if ('error' in mainnet && 'error' in surfpool) return differs('message', masked(mainnet.error.message), masked(surfpool.error.message))
  const a = shape((mainnet as { result: unknown }).result)
  const b = shape((surfpool as { result: unknown }).result)
  return differs('shape', JSON.stringify(a), JSON.stringify(b), alike(a, b))
}

const code = (reply: Reply): string => 'error' in reply ? String(reply.error.code) : 'result'

function differs(on: 'code' | 'message' | 'shape', mainnet: string, surfpool: string, same = mainnet === surfpool): Compared {
  return same ? { verdict: 'same' } : { verdict: 'differs', on, mainnet, surfpool }
}

function shape(value: unknown): Shape {
  if (value === null) return 'null'
  if (Array.isArray(value)) return [...new Set(value.map((v) => JSON.stringify(shape(v))))].sort().map((s) => JSON.parse(s) as Shape)
  if (typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shape((value as Record<string, unknown>)[k])]))
  return typeof value
}

function alike(a: Shape | undefined, b: Shape | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === 0 || b.length === 0 || JSON.stringify(a) === JSON.stringify(b)
  if (typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return a === b
  const keys = Object.keys(a)
  return JSON.stringify(keys) === JSON.stringify(Object.keys(b)) && keys.every((k) => alike(a[k], b[k]))
}
