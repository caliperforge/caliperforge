import { expect, test } from 'vitest'
import { card, listingFlags, type ListingScan } from '../card.ts'

const ok = { method: 'GET', path: '/paid', verdict: 'ok' as const, issues: [], protocols: ['x402', 'mpp'], quotedUsd: 0.01, declaredUsd: null, coins: ['USDC'] }
const scan: ListingScan = {
  pr: 7, fqn: 'acme/api', title: 'Acme API', serviceUrl: 'https://api.example.com', host: 'api.example.com',
  dns: true, freehost: null, flagwords: [], nOps: 1, nScanned: 1, endpoints: [ok],
}
const overall = (more: Partial<ListingScan>) => card({ ...scan, ...more }).split('\n')[2]
const unreadable = { ...ok, verdict: 'fail' as const, issues: ['402 without a readable offer'], protocols: [], quotedUsd: null }

test('D1 every endpoint ok renders a pass card', () => {
  expect(card({ ...scan, freehost: 'vercel.app' })).toBe([
    '## acme/api: Acme API (#7)',
    '',
    '**pass**',
    '- free hosting: vercel.app',
    '',
    '| method | path | verdict | protocols | asked | listed | issues |',
    '|---|---|---|---|---|---|---|',
    '| GET | /paid | ok | x402, mpp | $0.01 | - |  |',
  ].join('\n'))
})

test('D2 DNS failing rejects even with every endpoint ok', () => {
  const text = card({ ...scan, dns: false })
  expect(text.split('\n')[2]).toBe('**reject**')
  expect(text).toContain('- DNS does not resolve: api.example.com')
})

test('D2 no readable endpoint rejects', () => {
  const endpoints = [{ ...ok, verdict: 'unreachable' as const }, { ...ok, verdict: 'no_402' as const }, unreadable]
  expect(overall({ endpoints })).toBe('**reject**')
  expect(overall({ endpoints: [] })).toBe('**reject**')
})

test('D3 a readable endpoint not ok needs a fix', () => {
  const devnet = { ...unreadable, issues: ['devnet only'] }
  expect(overall({ endpoints: [devnet, unreadable] })).toBe('**fix needed**')
  const warn = { ...ok, verdict: 'warn' as const, issues: ['asks for $0', 'no declared price'] }
  const text = card({ ...scan, endpoints: [ok, warn], flagwords: ['rug', 'ape'] })
  expect(text.split('\n')[2]).toBe('**fix needed**')
  expect(text).toContain('- flag words: rug, ape')
  expect(text).toContain('| GET | /paid | warn | x402, mpp | $0.01 | - | asks for $0; no declared price |')
})

test('an endpoint left unchecked needs a fix, not a reject', () => {
  expect(overall({ endpoints: [{ ...ok, verdict: 'unchecked' as const, issues: ['recipient unchecked: HTTP 429'] }] })).toBe('**fix needed**')
})

test('D4 free hosts match by suffix, ngrok anywhere', () => {
  expect(listingFlags('x.up.railway.app', '').freehost).toBe('railway.app')
  expect(listingFlags('abc.ngrok-free.app', '').freehost).toBe('ngrok')
  expect(listingFlags('api.example.com', '').freehost).toBeNull()
  expect(listingFlags('notrailway.app', '').freehost).toBeNull()
})

test('D5 flag words match whole words in list order', () => {
  expect(listingFlags('h', 'Pump.fun SNIPER for KOL').flagwords).toEqual(['pump.fun', 'sniper', 'KOL'])
  expect(listingFlags('h', 'grape drug apex').flagwords).toEqual([])
})

test('D6 a long path is cut at 80', () => {
  const long = 'a'.repeat(100)
  const exact = 'b'.repeat(80)
  const text = card({ ...scan, endpoints: [{ ...ok, path: long }, { ...ok, path: exact }] })
  expect(text).toContain(`| ${'a'.repeat(80)}… |`)
  expect(text).toContain(`| ${exact} |`)
})
