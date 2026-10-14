import type { Offer, Offers } from './offers.ts'

export type Probe = { error: string } | { status: number; offers: Offers; bodyIsJson: boolean }
type Answered = Exclude<Probe, { error: string }>

export interface EndpointVerdict { verdict: 'unreachable' | 'no_402' | 'fail' | 'warn' | 'ok'; issues: string[]; protocols: string[]; quotedUsd: number | null; declaredUsd: number | null; coins: string[] }

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const STABLES = ['USDC', 'USDT', 'PYUSD', 'USDG', 'CASH']
const HEADER_ONLY = "x402 offer only in header with JSON body (pay's indexer misses it)"
const UNDECLARED = 'no declared price'

const devnet = (o: Offer): boolean => o.network === DEVNET || o.network.includes('devnet')
const distinct = <T>(xs: T[]): T[] => [...new Set(xs)]
const priced = (offers: Offer[]): number[] => offers.flatMap((o) => (o.usd === null ? [] : [o.usd]))

export function assess(probe: Probe, declaredUsd: number | null, serviceHost: string): EndpointVerdict {
  const none = { protocols: [], quotedUsd: null, declaredUsd, coins: [] }
  if ('error' in probe) return { verdict: 'unreachable', issues: [probe.error], ...none }
  if (probe.status !== 402) return { verdict: 'no_402', issues: [`HTTP ${String(probe.status)}`], ...none }
  const { offers } = probe.offers
  const paid = usable(offers)
  if (paid.length === 0) return { verdict: 'fail', issues: [unusable(offers)], ...none }
  const prices = priced(paid)
  const quotedUsd = prices.length === 0 ? null : Math.min(...prices)
  const issues = issuesOf(probe, paid, declaredUsd, quotedUsd, serviceHost)
  return {
    verdict: issues.every((i) => i === UNDECLARED || i === HEADER_ONLY) ? 'ok' : 'warn',
    issues,
    protocols: distinct(paid.map((o) => o.proto)),
    quotedUsd,
    declaredUsd,
    coins: distinct(paid.map((o) => o.coin)),
  }
}

export function usable(offers: Offer[]): Offer[] {
  return offers.filter((o) => o.network === SOLANA && STABLES.includes(o.coin))
}

function unusable(offers: Offer[]): string {
  if (offers.some(devnet)) return 'devnet only'
  if (offers.length > 0) return `no Solana mainnet offer (${distinct(offers.map((o) => o.network)).join(', ')})`
  return '402 without a readable offer'
}

function issuesOf(probe: Answered, usable: Offer[], declared: number | null, quoted: number | null, host: string): string[] {
  const { offers, x402Source, resourceUrl } = probe.offers
  const prices = distinct(priced(usable.filter((o) => o.scheme === 'exact' || o.scheme === 'charge'))).sort((a, b) => a - b)
  const recipients = distinct(usable.flatMap((o) => (o.payTo === null ? [] : [o.payTo])))
  const tempo = offers.some((o) => o.proto === 'mpp' && o.network === 'mpp:tempo') && !usable.some((o) => o.proto === 'mpp')
  const resource = elsewhere(resourceUrl, host)
  return [
    offers.some(devnet) && 'also advertises devnet',
    tempo && 'MPP offered on Tempo, not Solana',
    x402Source === 'header' && probe.bodyIsJson && HEADER_ONLY,
    prices.length > 1 && `inconsistent prices across offers [${prices.join(', ')}]`,
    usable.some((o) => o.usd === 0) && 'asks for $0',
    recipients.length > 1 && `${String(recipients.length)} different recipients`,
    resource !== undefined && `payment resource points at ${resource}`,
    declared !== null && quoted !== null && apart(declared, quoted) && `price listed $${String(declared)} vs asked $${String(quoted)}`,
    declared === null && UNDECLARED,
  ].filter((i) => typeof i === 'string')
}

function elsewhere(resourceUrl: string | null, host: string): string | undefined {
  const at = URL.parse(resourceUrl ?? '')?.hostname
  const base = host.split('.').slice(-2).join('.')
  return at === undefined || at === host || at === base || at.endsWith(`.${base}`) ? undefined : at
}

function apart(a: number, b: number): boolean {
  return Math.abs(a - b) > Math.max(0.0001, 0.01 * Math.max(a, b))
}
