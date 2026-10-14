import { expect, test, vi } from 'vitest'
import type { Offer } from '../offers.ts'
import { payee } from '../payee.ts'

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const WALLET = '11111111111111111111111111111111'
const offer: Offer = { proto: 'x402', scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', coin: 'USDC', asset: USDC, usd: 0.01, payTo: 'Pay1' }

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
  expect(await owes([offer])).toEqual([])
  expect(sent).toEqual([
    { jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: ['Pay1', { encoding: 'jsonParsed' }] },
    { jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: ['Pay1', { mint: USDC }, { encoding: 'jsonParsed' }] },
  ])
})

test('D2 a recipient with no token account for the mint', async () => {
  expect(await chain(WALLET, []).owes([offer])).toEqual(['recipient has no USDC token account'])
})

test.each(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'])('D3 a payTo owned by %s', async (program) => {
  const { sent, owes } = chain(program, [])
  expect(await owes([offer])).toEqual(['payTo is a token account, not a wallet'])
  expect(sent).toHaveLength(1)
})

test('a pair asked twice is fetched once', async () => {
  const { sent, owes } = chain(WALLET, [])
  await owes([offer])
  expect(await owes([offer, { ...offer, proto: 'mpp' }])).toEqual(['recipient has no USDC token account'])
  expect(sent).toHaveLength(2)
})

test('D5 a 429 adds no issue and writes one stderr line', async () => {
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const owes = payee(() => Promise.resolve(new Response('slow down', { status: 429 })))
  expect(await owes([offer, { ...offer, payTo: 'Pay2' }])).toEqual([])
  expect(write).toHaveBeenCalledTimes(1)
  write.mockRestore()
})
