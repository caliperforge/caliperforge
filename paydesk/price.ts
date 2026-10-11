export interface Pricing { dimensions?: { scale?: number; tiers?: { price_usd: number }[] }[] }

type Fields = Record<string, unknown>

const KEYS = ['price', 'fixedPrice', 'amount', 'price_usd', 'priceUsd']

const fields = (v: unknown): Fields => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Fields) : {})
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

function usd(v: unknown): number | null {
  const s = typeof v === 'string' ? v.replaceAll('$', '').trim() : ''
  const n = typeof v === 'number' ? v : s === '' ? NaN : Number(s)
  return Number.isFinite(n) ? n : null
}

function micro(v: unknown): number | null {
  const n = usd(v)
  return n === null ? null : n / 1e6
}

function keyed(info: Fields, key: string): number | null {
  const n = usd(info[key])
  return key === 'amount' && n !== null && n > 1000 ? n / 1e6 : n
}

/** The USD price an OpenAPI operation, or failing that its listing's pricing, declares; null when neither does. */
export function declaredUsd(op: Fields, pricing?: Pricing): number | null {
  const info = fields(op['x-payment-info'])
  const offer = list(info.offers).map(fields).find((o) => o.amount !== undefined && o.amount !== '')
  const solana = list(info.accepts).map(fields).find((a) => typeof a.network === 'string' && a.network.startsWith('solana'))
  const dimension = pricing?.dimensions?.[0]
  const top = dimension?.tiers?.at(-1)
  return [
    micro(offer?.amount),
    ...KEYS.map((key) => keyed(info, key)),
    micro(solana?.amount),
    usd(op['x-price-usd']),
    usd(op['x-price']),
    top === undefined ? null : usd(top.price_usd / (dimension?.scale ?? 1)),
  ].find((n) => n !== null) ?? null
}

export function pathMatches(template: string, path: string): boolean {
  const parts = (s: string): string[] => s.replace(/^\//, '').split('/')
  const want = parts(template)
  const got = parts(path.replace(/\?.*$/, ''))
  return want.length === got.length && want.every((w, i) => (/^\{[^}]+\}$/.test(w) ? got[i] !== '' : w === got[i]))
}
