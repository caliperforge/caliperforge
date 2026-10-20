import { expect, test } from 'vitest'
import type { Offer } from '../offers.ts'
import { payee } from '../payee.ts'

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const WALLET = '11111111111111111111111111111111'
const PAY1 = 'SysvarRent111111111111111111111111111111111'
const PAY2 = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const EVM = `0x${'ab'.repeat(20)}`
const offer: Offer = { proto: 'x402', scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', coin: 'USDC', asset: USDC, usd: 0.01, payTo: PAY1 }

const chain = (owner: string, held: unknown[]) => {
  const sent: unknown[] = []
  const fetch = (...[, init]: [string, RequestInit]): Promise<Response> => {
    const body = JSON.parse(init.body as string) as { method: string }
    sent.push(body)
    const value = body.method === 'getAccountInfo' ? { owner, lamports: 1, executable: false } : held
    return Promise.resolve(Response.json({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value } }))
  }
  return { sent, owes: payee(fetch as typeof globalThis.fetch) }
}

test('D1 a recipient holding the mint gives no issue', async () => {
  const { sent, owes } = chain(WALLET, [{ pubkey: 'Ata1', account: {} }])
  expect(await owes([offer])).toEqual({ verdict: 'warn', issues: [] })
  expect(sent).toEqual([
    { jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [PAY1, { encoding: 'jsonParsed' }] },
    { jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [PAY1, { mint: USDC }, { encoding: 'jsonParsed' }] },
  ])
})

test('D2 a recipient with no token account for the mint', async () => {
  expect(await chain(WALLET, []).owes([offer])).toEqual({ verdict: 'warn', issues: ['recipient has no USDC token account'] })
})

test.each(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'])('D3 a payTo owned by %s', async (program) => {
  const { sent, owes } = chain(program, [])
  expect(await owes([offer])).toEqual({ verdict: 'warn', issues: ['payTo is a token account, not a wallet'] })
  expect(sent).toHaveLength(1)
})

test('a pair asked twice is fetched once', async () => {
  const { sent, owes } = chain(WALLET, [])
  await owes([offer])
  expect(await owes([offer, { ...offer, proto: 'mpp' }])).toEqual({ verdict: 'warn', issues: ['recipient has no USDC token account'] })
  expect(sent).toHaveLength(2)
})

test('D1 an EVM payTo fails and sends no RPC call', async () => {
  const { sent, owes } = chain(WALLET, [])
  expect(await owes([{ ...offer, payTo: EVM }])).toEqual({ verdict: 'fail', issues: ['payTo is not a Solana address'] })
  expect(sent).toEqual([])
})

test('D2 an EVM asset fails and sends no RPC call', async () => {
  const { sent, owes } = chain(WALLET, [])
  const asset = '0x833589fCD6eDb6E08f4c7C32D4f71b54bda02913'
  expect(await owes([offer, { ...offer, payTo: PAY2, asset }])).toEqual({ verdict: 'fail', issues: ['asset is not a Solana address'] })
  expect(sent).toEqual([])
})

test.each([
  [new Response('slow down', { status: 429 }), 'HTTP 429'],
  [Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'String is the wrong size' } }), 'getAccountInfo replied'],
])('D3 a failed RPC call rejects with %#', async (reply, said) => {
  await expect(payee(() => Promise.resolve(reply))([offer])).rejects.toThrow(said)
})

test('D4 Held needs { context, value }; a bare array rejects', async () => {
  const bare = (...[, init]: [string, RequestInit]): Promise<Response> => Promise.resolve(Response.json({ jsonrpc: '2.0', id: 1,
    result: (init.body as string).includes('getAccountInfo') ? { context: { slot: 1 }, value: null } : [{ pubkey: 'Ata1', account: {} }] }))
  await expect(payee(bare as typeof globalThis.fetch)([offer])).rejects.toThrow('getTokenAccountsByOwner replied')
})
