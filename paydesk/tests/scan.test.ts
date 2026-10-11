import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import type { ListingScan } from '../card.ts'
import { scan, type Scanned } from '../scan.ts'

const X402 = { accepts: [{ scheme: 'exact', network: 'solana', amount: '10000', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', payTo: 'payee' }] }
const calls: { url: string; init: RequestInit }[] = []
const fake = (url: string, init: RequestInit): Promise<Response> => {
  calls.push({ url, init })
  return Promise.resolve(init.body === '{"symbol":"SOL"}'
    ? new Response('bad', { status: 400 })
    : new Response(JSON.stringify(X402), { status: 402, headers: { 'content-type': 'application/json' } }))
}
const tmp = mkdtempSync(join(tmpdir(), 'paydesk-'))
let results: Scanned[] = []
let listing: ListingScan

beforeAll(async () => {
  mkdirSync(join(tmp, 'org', 'broken'), { recursive: true })
  writeFileSync(join(tmp, 'org', 'broken', 'PAY.md'), '---\ntitle: Broken\nservice_url: https://b.example.com\nopenapi:\n  path: missing.json\n---\n')
  const dirs = [join(tmp, 'org', 'broken'), join(import.meta.dirname, 'fixtures', 'listing')]
  results = await scan(dirs, join(tmp, 'out.json'), join(tmp, 'cards'), { fetch: fake as typeof fetch, resolve: () => Promise.resolve() })
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

test('D4 a missing spec crashes one listing, not the scan', () => {
  expect(results[0]).toMatchObject({ fqn: 'org/broken', crash: expect.stringContaining('missing.json') as unknown })
  expect(listing.fqn).toBe('fixtures/listing')
})

test('D5 out holds the array and cards one card per listing', () => {
  expect(JSON.parse(readFileSync(join(tmp, 'out.json'), 'utf8'))).toEqual(results)
  expect(listing).toMatchObject({ fqn: 'fixtures/listing', pr: 7 })
  expect(readdirSync(join(tmp, 'cards'))).toEqual(['fixtures__listing.md'])
  expect(readFileSync(join(tmp, 'cards', 'fixtures__listing.md'), 'utf8').split('\n')[0]).toBe('## fixtures/listing: Example API (#7)')
})
