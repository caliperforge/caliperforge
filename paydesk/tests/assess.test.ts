import { expect, test } from 'vitest'
import { assess } from '../assess.ts'
import type { Offer, Offers } from '../offers.ts'

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const HOST = 'api.example.com'

const offer: Offer = { proto: 'x402', scheme: 'exact', network: SOLANA, coin: 'USDC', usd: 0.01, payTo: 'Pay1' }
const clean: Offers = { offers: [offer], x402Source: 'body', x402Version: 2, resourceUrl: 'https://api.example.com/paid' }

const probe = (more: Partial<Offers> = {}, bodyIsJson = true) =>
  ({ status: 402, offers: { ...clean, ...more }, bodyIsJson })
const issues = (more: Partial<Offers>, declared: number | null = 0.01) => assess(probe(more), declared, HOST).issues
const warned = (more: Partial<Offers>, declared: number | null = 0.01) => assess(probe(more), declared, HOST).verdict

test('D1 an error probe is unreachable', () => {
  expect(assess({ error: 'ECONNREFUSED' }, 0.01, HOST)).toEqual({
    verdict: 'unreachable', issues: ['ECONNREFUSED'], protocols: [], quotedUsd: null, declaredUsd: 0.01, coins: [],
  })
})

test('D1 a 200 is no_402', () => {
  expect(assess({ ...probe(), status: 200 }, null, HOST)).toEqual({
    verdict: 'no_402', issues: ['HTTP 200'], protocols: [], quotedUsd: null, declaredUsd: null, coins: [],
  })
})

test('D2 devnet offers alone fail as devnet only', () => {
  const v = assess(probe({ offers: [{ ...offer, network: DEVNET }, { ...offer, network: 'eip155:8453' }] }), 0.01, HOST)
  expect(v).toEqual({ verdict: 'fail', issues: ['devnet only'], protocols: [], quotedUsd: null, declaredUsd: 0.01, coins: [] })
})

test('D2 base alone fails with no Solana mainnet offer', () => {
  expect(assess(probe({ offers: [{ ...offer, network: 'eip155:8453' }] }), 0.01, HOST)).toMatchObject({
    verdict: 'fail', issues: ['no Solana mainnet offer (eip155:8453)'],
  })
})

test('D2 a 402 with no offers fails as unreadable', () => {
  expect(assess(probe({ offers: [] }), 0.01, HOST)).toMatchObject({ verdict: 'fail', issues: ['402 without a readable offer'] })
})

test('D3 a devnet offer beside mainnet warns', () => {
  const more = { offers: [offer, { ...offer, network: 'solana:devnet' }] }
  expect(issues(more)).toEqual(['also advertises devnet'])
  expect(warned(more)).toBe('warn')
})

test('D3 mpp on Tempo with no Solana mpp warns', () => {
  const more = { offers: [offer, { ...offer, proto: 'mpp' as const, scheme: 'charge', network: 'mpp:tempo', coin: '0x20c00000' }] }
  expect(issues(more)).toEqual(['MPP offered on Tempo, not Solana'])
  expect(warned(more)).toBe('warn')
})

test('D3 header-only x402 with a JSON body is noted but ok', () => {
  const v = assess(probe({ x402Source: 'header' }), 0.01, HOST)
  expect(v.issues).toEqual(["x402 offer only in header with JSON body (pay's indexer misses it)"])
  expect(v.verdict).toBe('ok')
  expect(assess(probe({ x402Source: 'header' }, false), 0.01, HOST).issues).toEqual([])
})

test('D3 usable offers at different prices warn', () => {
  const more = { offers: [offer, { ...offer, scheme: 'charge', usd: 0.02 }, { ...offer, scheme: 'upto', usd: 5 }] }
  expect(issues(more)).toEqual(['inconsistent prices across offers [0.01, 0.02]'])
  expect(warned(more)).toBe('warn')
})

test('D3 a usable offer asking $0 warns', () => {
  const more = { offers: [{ ...offer, usd: 0 }] }
  expect(issues(more, null)).toEqual(['asks for $0', 'no declared price'])
  expect(warned(more, null)).toBe('warn')
})

test('D3 more than one recipient warns', () => {
  const more = { offers: [offer, { ...offer, coin: 'USDT', payTo: 'Pay2' }, { ...offer, payTo: null }] }
  expect(issues(more)).toEqual(['2 different recipients'])
  expect(warned(more)).toBe('warn')
})

test('D4 a resource on another host warns', () => {
  const more = { resourceUrl: 'https://other.dev/paid' }
  expect(issues(more)).toEqual(['payment resource points at other.dev'])
  expect(warned(more)).toBe('warn')
})

test('D4 a resource under the service domain is not flagged', () => {
  expect(issues({ resourceUrl: 'https://pay.example.com/paid' })).toEqual([])
  expect(issues({ resourceUrl: 'https://example.com/paid' })).toEqual([])
  expect(issues({ resourceUrl: null })).toEqual([])
})

test('D5 a listed price off the asked price warns', () => {
  const more = { offers: [{ ...offer, usd: 1.02 }] }
  expect(issues(more, 1)).toEqual(['price listed $1 vs asked $1.02'])
  expect(warned(more, 1)).toBe('warn')
})

test('D5 prices within tolerance are not flagged', () => {
  expect(issues({ offers: [{ ...offer, usd: 0.00105 }] }, 0.001)).toEqual([])
  expect(issues({ offers: [{ ...offer, usd: 1.01 }] }, 1)).toEqual([])
})

test('D6 a clean single offer is ok', () => {
  expect(assess(probe(), 0.01, HOST)).toEqual({
    verdict: 'ok', issues: [], protocols: ['x402'], quotedUsd: 0.01, declaredUsd: 0.01, coins: ['USDC'],
  })
})

test('D6 no declared price and the header note stay ok', () => {
  const v = assess(probe({ x402Source: 'header' }), null, HOST)
  expect(v.issues).toEqual(["x402 offer only in header with JSON body (pay's indexer misses it)", 'no declared price'])
  expect(v.verdict).toBe('ok')
})
