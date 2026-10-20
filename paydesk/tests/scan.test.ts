import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import type { ListingScan } from '../card.ts'
import { scan, type Scanned } from '../scan.ts'

let payTo = 'SysvarRent111111111111111111111111111111111'
const x402 = () => ({ accepts: [{ scheme: 'exact', network: 'solana', amount: '10000', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', payTo }] })
const RPC = 'https://api.mainnet-beta.solana.com'
const calls: { url: string; init: RequestInit }[] = []
let held: unknown[] | null = [{ pubkey: 'ata', account: {} }]
const chain = (body: string): Response => {
  if (held === null) return new Response('slow down', { status: 429 })
  const value = body.includes('getAccountInfo') ? { owner: '11111111111111111111111111111111' } : held
  return Response.json({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value } })
}
const fake = (url: string, init: RequestInit): Promise<Response> => {
  calls.push({ url, init })
  if (url === RPC) return Promise.resolve(chain(init.body as string))
  return Promise.resolve(init.body === '{"symbol":"SOL"}'
    ? new Response('bad', { status: 400 })
    : new Response(JSON.stringify(x402()), { status: 402, headers: { 'content-type': 'application/json' } }))
}
const tmp = mkdtempSync(join(tmpdir(), 'paydesk-'))
let results: Scanned[] = []
let listing: ListingScan
const net = { fetch: fake as typeof fetch, resolve: () => Promise.resolve() }
const rescan = async (): Promise<ListingScan> => (await scan([join(import.meta.dirname, 'fixtures', 'listing')], undefined, undefined, net))[0] as ListingScan

beforeAll(async () => {
  mkdirSync(join(tmp, 'org', 'broken'), { recursive: true })
  writeFileSync(join(tmp, 'org', 'broken', 'PAY.md'), '---\ntitle: Broken\nservice_url: https://b.example.com\nopenapi:\n  path: missing.json\n---\n')
  mkdirSync(join(tmp, 'org', 'shaped'), { recursive: true })
  writeFileSync(join(tmp, 'org', 'shaped', 'PAY.md'), '---\ntitle: Shaped\nservice_url: https://s.example.com\nopenapi: x.json\n---\n')
  mkdirSync(join(tmp, 'org', 'garbled'), { recursive: true })
  writeFileSync(join(tmp, 'org', 'garbled', 'PAY.md'), '---\ntitle: Garbled\nservice_url: https://g.example.com\nopenapi:\n  path: openapi.json\n---\n')
  writeFileSync(join(tmp, 'org', 'garbled', 'openapi.json'), '{"a":1} x')
  const dirs = [join(tmp, 'org', 'broken'), join(import.meta.dirname, 'fixtures', 'listing'), join(tmp, 'org', 'shaped'), join(tmp, 'org', 'garbled')]
  results = await scan(dirs, join(tmp, 'out.json'), join(tmp, 'cards'), net)
  listing = results[1] as ListingScan
})

test('D1 the GET goes bare and its 402 reaches assess', () => {
  const [get] = calls
  expect(get?.url).toBe('https://api.example.com/paid')
  expect(get?.init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { 'user-agent': 'pay-catalog-scanner/0.1 (+caliperforge)' } })
  expect(get?.init.body).toBeUndefined()
  for (const { init } of calls) expect(Object.keys(init.headers ?? {})).toEqual(expect.not.arrayContaining(['x-payment', 'payment-signature', 'authorization']))
  expect(listing.endpoints[0]).toMatchObject({ method: 'GET', path: '/paid', verdict: 'ok', quotedUsd: 0.01, declaredUsd: 0.01 })
})

test('D2 a POST is recorded from the 402 after a 400', () => {
  const quote = calls.filter((c) => c.url.endsWith('/quote'))
  expect(quote.map((c) => c.init.body)).toEqual(['{"symbol":"SOL"}', '{}'])
  expect(quote[0]?.init.headers).toMatchObject({ 'content-type': 'application/json' })
  expect(listing.endpoints[1]).toMatchObject({ method: 'POST', path: '/quote', verdict: 'ok', quotedUsd: 0.01 })
})

test('D3 an SMS send is counted but never requested', () => {
  expect(calls.map((c) => c.url)).not.toContain('https://api.example.com/sms/send')
  expect(listing.endpoints.map((e) => e.path)).toEqual(['/paid', '/quote'])
  expect(listing).toMatchObject({ nOps: 3, nScanned: 2, dns: true })
})

test('D4 a missing spec is an invalid listing, not a crash', () => {
  expect(results[0]).toEqual({ fqn: 'org/broken', pr: 0, field: 'openapi.path', invalid_listing: expect.stringContaining('missing.json') as unknown })
  expect(listing.fqn).toBe('fixtures/listing')
})

test('D1 D2 a bad front or spec names its field, unfetched', () => {
  expect(results.slice(2)).toEqual([
    { fqn: 'org/shaped', pr: 0, field: 'openapi', invalid_listing: expect.any(String) as unknown },
    { fqn: 'org/garbled', pr: 0, field: 'openapi.path', invalid_listing: expect.stringContaining('JSON') as unknown },
  ])
  expect(calls.filter((c) => /[sg]\.example\.com/.test(c.url))).toEqual([])
})

test('D5 out holds the array and cards one card per listing', () => {
  expect(JSON.parse(readFileSync(join(tmp, 'out.json'), 'utf8'))).toEqual(results)
  expect(listing).toMatchObject({ fqn: 'fixtures/listing', pr: 7 })
  expect(readdirSync(join(tmp, 'cards'))).toEqual(['fixtures__listing.md'])
  expect(readFileSync(join(tmp, 'cards', 'fixtures__listing.md'), 'utf8').split('\n')[0]).toBe('## fixtures/listing: Example API (#7)')
})

test('D4 both endpoints share one getAccountInfo call', () => {
  expect(calls.filter((c) => c.url === RPC && (c.init.body as string).includes('getAccountInfo'))).toHaveLength(1)
})

test('D2 no token account for the mint warns on both endpoints', async () => {
  held = []
  for (const endpoint of (await rescan()).endpoints) {
    expect(endpoint).toMatchObject({ verdict: 'warn', issues: expect.arrayContaining(['recipient has no USDC token account']) as unknown })
  }
})

test('D5 an RPC 429 leaves both endpoints unchecked', async () => {
  held = null
  const { endpoints } = await rescan()
  expect(endpoints).toEqual(listing.endpoints.map((e) => ({ ...e, verdict: 'unchecked', issues: [...e.issues, 'recipient unchecked: HTTP 429'] })))
})

test('D6 an EVM payTo fails with no RPC call', async () => {
  payTo = `0x${'ab'.repeat(20)}`
  const before = calls.length
  for (const endpoint of (await rescan()).endpoints) {
    expect(endpoint).toMatchObject({ verdict: 'fail', issues: expect.arrayContaining(['payTo is not a Solana address']) as unknown })
  }
  expect(calls.slice(before).filter((c) => c.url === RPC)).toEqual([])
})
