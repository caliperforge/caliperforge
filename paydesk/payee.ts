import { z } from 'zod'
import type { Offer } from './offers.ts'

const PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']
const Account = z.object({ owner: z.string() }).nullable()
const Held = z.array(z.unknown())
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function payee(fetch: typeof globalThis.fetch): (usable: Offer[]) => Promise<{ verdict: 'fail' | 'warn'; issues: string[] }> {
  const url = process.env.CF_SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com'
  const seen = new Map<string, Promise<string | null>>()
  const call = <T>(method: string, params: unknown[], value: z.ZodType<T>): Promise<T> => rpc(fetch, url, method, params, value)
  const check = (payTo: string, asset: string, coin: string): Promise<string | null> =>
    call('getAccountInfo', [payTo, { encoding: 'jsonParsed' }], Account)
      .then((account) => (account !== null && PROGRAMS.includes(account.owner)
        ? 'payTo is a token account, not a wallet'
        : call('getTokenAccountsByOwner', [payTo, { mint: asset }, { encoding: 'jsonParsed' }], Held)
          .then((held) => (held.length === 0 ? `recipient has no ${coin} token account` : null))))
  return async (usable) => {
    const wrong = usable.flatMap(({ payTo, asset }) => (payTo === null ? [] : Object.entries({ payTo, asset })))
      .filter(([, s]) => !key(s)).map(([field]) => `${field} is not a Solana address`)
    if (wrong.length > 0) return { verdict: 'fail', issues: [...new Set(wrong)] }
    const issues = await Promise.all(usable.flatMap(({ payTo, asset, coin }) => {
      if (payTo === null) return []
      const key = `${payTo} ${asset}`
      const pending = seen.get(key) ?? check(payTo, asset, coin)
      seen.set(key, pending)
      return [pending]
    }))
    return { verdict: 'warn', issues: [...new Set(issues.filter((i) => i !== null))] }
  }
}

function key(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]*$/.test(s)) return false
  const rest = s.replace(/^1+/, '')
  const n = Array.from(rest).reduce((acc, c) => acc * 58n + BigInt(BASE58.indexOf(c)), 0n)
  return s.length - rest.length + (n === 0n ? 0 : Math.ceil(n.toString(16).length / 2)) === 32
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
