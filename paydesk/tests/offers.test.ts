import { expect, test } from 'vitest'
import { offersOf } from '../offers.ts'

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bda02913'
const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

const encode = (x: unknown, encoding: 'base64' | 'base64url' = 'base64'): string =>
  Buffer.from(JSON.stringify(x)).toString(encoding)

const x402 = {
  x402Version: 2,
  resource: { url: 'https://api.example.com/paid?' },
  accepts: [{ scheme: 'exact', network: 'base', amount: '10000', asset: USDC_BASE, payTo: '0xpay' }],
}

const baseOffer = { proto: 'x402', scheme: 'exact', network: 'eip155:8453', coin: 'USDC', asset: USDC_BASE, usd: 0.01, payTo: '0xpay' }

const solanaCharge = `Payment id="a1", realm="api", method="solana", intent="charge", request="${encode({
  amount: '2500000000',
  currency: USDC_SOLANA,
  recipient: 'Recipient1',
  methodDetails: { network: 'mainnet-beta', decimals: 9 },
}, 'base64url')}"`

test('D1 reads the x402 offer from the header alone', () => {
  expect(offersOf({ status: 402, headers: { 'Payment-Required': encode(x402) }, body: '{}' })).toEqual({
    offers: [baseOffer],
    x402Source: 'header',
    x402Version: 2,
    resourceUrl: 'https://api.example.com/paid?',
  })
})

test('D2 reads the x402 offer from the body without a header', () => {
  const v1 = { x402Version: 1, accepts: [{ ...x402.accepts[0], amount: undefined, maxAmountRequired: '10000' }] }
  expect(offersOf({ status: 402, headers: {}, body: JSON.stringify(v1) })).toEqual({
    offers: [baseOffer],
    x402Source: 'body',
    x402Version: 1,
    resourceUrl: null,
  })
})

test('D3 url-safe unpadded header matches its standard form', () => {
  const standard = encode(x402)
  const urlSafe = encode(x402, 'base64url').replace(/=+$/, '')
  expect(standard).toMatch(/[+/=]/)
  const expected = offersOf({ status: 402, headers: { 'payment-required': standard }, body: '' })
  expect(expected.offers).toEqual([baseOffer])
  expect(offersOf({ status: 402, headers: { 'payment-required': urlSafe }, body: '' })).toEqual(expected)
})

test('D4 solana charge prices at its own decimals on mainnet', () => {
  expect(offersOf({ status: 402, headers: { 'www-authenticate': solanaCharge }, body: '' }).offers).toEqual([{
    proto: 'mpp',
    scheme: 'charge',
    network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    coin: 'USDC',
    asset: USDC_SOLANA,
    usd: 2.5,
    payTo: 'Recipient1',
  }])
})

test('D5 a tempo challenge maps to mpp:tempo', () => {
  const request = encode({ amount: '1000000', currency: '0x20c0000000000000000000000000000000000000', recipient: '0xr' })
  const header = `Payment method="tempo", intent="charge", request="${request}"`
  expect(offersOf({ status: 402, headers: { 'WWW-Authenticate': header }, body: '' }).offers).toEqual([{
    proto: 'mpp',
    scheme: 'charge',
    network: 'mpp:tempo',
    coin: '0x20c00000',
    asset: '0x20c0000000000000000000000000000000000000',
    usd: 1,
    payTo: '0xr',
  }])
})

test('D6 returns offers for both x402 and mpp', () => {
  const res = offersOf({
    status: 402,
    headers: { 'x-payment-required': encode(x402), 'WWW-Authenticate': ['Bearer realm="api"', solanaCharge] },
    body: '',
  })
  expect(res.offers.map((o) => o.proto)).toEqual(['x402', 'mpp'])
  expect(res.offers.map((o) => o.asset)).toEqual([USDC_BASE, USDC_SOLANA])
  expect(res.x402Source).toBe('header')
})

test('D7 garbage header and non-JSON body give no offers', () => {
  expect(offersOf({ status: 402, headers: { 'payment-required': '%%not base64%%' }, body: '<html>' })).toEqual({
    offers: [],
    x402Source: null,
    x402Version: null,
    resourceUrl: null,
  })
})
