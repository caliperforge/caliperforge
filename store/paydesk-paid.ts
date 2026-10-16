import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import type { ListingScan } from '../paydesk/card.ts'
import type { Row } from '../paydesk/prs.ts'

export interface Spend { at: string; fqn: string; endpoint: string; usdc: number; tx: string | null; status: number | null; data: boolean }
interface Parsed { status: number | null; usdc: number | null; tx: string | null; data: boolean }
interface Options { cap: number; ledger: string; account: string | undefined; bin: string; now: Date }
type Endpoint = ListingScan['endpoints'][number]

const WEEK = 7 * 24 * 60 * 60 * 1000
const micro = (usd: number): number => Math.round(usd * 1e6)
const priceOf = (e: Endpoint): number => e.quotedUsd ?? e.declaredUsd ?? 0

export function parsed(stdout: string, stderr: string, code: number | null): Parsed {
  const hit = (re: RegExp): string | null => re.exec(stderr)?.[1] ?? null
  const status = hit(/\bstatus[=:]\s*(\d{3})\b/i)
  const usdc = hit(/(\d+(?:\.\d+)?)\s*USDC\b/i)
  return {
    status: status === null ? null : Number(status),
    usdc: usdc === null ? null : Number(usdc),
    tx: hit(/\b(?:tx|signature)[=:]\s*"?([1-9A-HJ-NP-Za-km-z]{32,88})/i),
    data: code === 0 && stdout.trim() !== '',
  }
}

export function recent(ledger: string, now: Date): Set<string> {
  if (!existsSync(ledger)) return new Set()
  return new Set(readFileSync(ledger, 'utf8').split('\n').flatMap((line) => {
    const row = json(line)
    const at = typeof row?.at === 'string' ? Date.parse(row.at) : NaN
    return typeof row?.fqn === 'string' && now.getTime() - at < WEEK ? [row.fqn] : []
  }))
}

function json(line: string): Partial<Record<keyof Spend, unknown>> | null {
  try {
    return JSON.parse(line) as Partial<Record<keyof Spend, unknown>> | null
  } catch {
    return null
  }
}

export function paid(scanned: Row[], options: Options): { rows: ListingScan[]; spent: number; skipped: number; capped: boolean } {
  const seen = recent(options.ledger, options.now)
  const listings = scanned.filter((r): r is ListingScan => 'endpoints' in r)
  const rows: ListingScan[] = []
  let spent = 0
  let skipped = scanned.length - listings.length
  for (const row of listings) {
    const endpoint = row.dns && !seen.has(row.fqn) ? cheapest(row) : undefined
    if (endpoint === undefined) {
      skipped++
      continue
    }
    if (spent + micro(priceOf(endpoint)) > micro(options.cap)) return { rows, spent: spent / 1e6, skipped, capped: true }
    const { spend, scan } = call(row, endpoint, options)
    appendFileSync(options.ledger, `${JSON.stringify(spend)}\n`)
    spent += micro(spend.usdc)
    rows.push(scan)
  }
  return { rows, spent: spent / 1e6, skipped, capped: false }
}

function cheapest({ endpoints }: ListingScan): Endpoint | undefined {
  return endpoints.filter((e) => (e.verdict === 'ok' || e.verdict === 'warn') && priceOf(e) > 0)
    .sort((a, b) => priceOf(a) - priceOf(b))[0]
}

function call(listing: ListingScan, endpoint: Endpoint, { account, bin, now }: Options): { spend: Spend; scan: ListingScan } {
  const price = priceOf(endpoint)
  const url = listing.serviceUrl.replace(/\/+$/, '') + endpoint.path.replace(/\{[^}]+\}/g, 'test')
  const args = ['--no-dna', '--mainnet', '--yolo-upto', price.toFixed(6), '--verbose', ...(account === undefined ? [] : ['--account', account]),
    'fetch', '-X', endpoint.method, url]
  const ran = spawnSync(bin, args, { encoding: 'utf8' })
  const got = parsed(ran.stdout, ran.stderr, ran.status)
  const spend = { at: now.toISOString(), fqn: listing.fqn, endpoint: `${endpoint.method} ${url}`,
    usdc: got.usdc ?? (ran.status === 0 ? price : 0), tx: got.tx, status: got.status, data: got.data }
  const status = got.status === null ? 'no HTTP status' : `HTTP ${String(got.status)}`
  const verdict = got.data ? { verdict: 'ok' as const, issues: [] } : { verdict: 'fail' as const, issues: [`paid call got no data (${status})`] }
  return { spend, scan: { ...listing, endpoints: [{ ...endpoint, ...verdict }] } }
}
