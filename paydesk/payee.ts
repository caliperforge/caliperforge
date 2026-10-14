import { z } from 'zod'
import type { Offer } from './offers.ts'

const PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']
const Account = z.object({ owner: z.string() }).nullable()
const Held = z.array(z.unknown())

export function payee(fetch: typeof globalThis.fetch): (usable: Offer[]) => Promise<string[]> {
  const url = process.env.CF_SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com'
  const seen = new Map<string, Promise<string | null>>()
  let told = false
  const call = <T>(method: string, params: unknown[], value: z.ZodType<T>): Promise<T> => rpc(fetch, url, method, params, value)
  const check = (payTo: string, asset: string, coin: string): Promise<string | null> =>
    call('getAccountInfo', [payTo, { encoding: 'jsonParsed' }], Account)
      .then((account) => (account !== null && PROGRAMS.includes(account.owner)
        ? 'payTo is a token account, not a wallet'
        : call('getTokenAccountsByOwner', [payTo, { mint: asset }, { encoding: 'jsonParsed' }], Held)
          .then((held) => (held.length === 0 ? `recipient has no ${coin} token account` : null))))
      .catch((e: unknown) => {
        if (!told) process.stderr.write(`paydesk: Solana RPC failed, recipients left unchecked: ${e instanceof Error ? e.message : String(e)}\n`)
        told = true
        return null
      })
  return async (usable) => {
    const issues = await Promise.all(usable.flatMap(({ payTo, asset, coin }) => {
      if (payTo === null) return []
      const key = `${payTo} ${asset}`
      const pending = seen.get(key) ?? check(payTo, asset, coin)
      seen.set(key, pending)
      return [pending]
    }))
    return [...new Set(issues.filter((i) => i !== null))]
  }
}

async function rpc<T>(fetch: typeof globalThis.fetch, url: string, method: string, params: unknown[], value: z.ZodType<T>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
  const body: unknown = await res.json()
  const reply = z.object({ result: z.object({ value }) }).safeParse(body)
  if (!reply.success) throw new Error(`${method} replied ${JSON.stringify(body)}`)
  return reply.data.result.value
}
