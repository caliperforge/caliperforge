import { setTimeout as sleep } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { gh, type Read, WINDOW } from '../cli/gh.ts'
import type { Db } from '../store/index.ts'
import { type Mismatch, mismatched } from '../store/parity.ts'
import { type Case, cases, type Given } from './cases.ts'
import { compared, methods, type Reply } from './rpc.ts'

const REPO = 'solana-foundation/surfpool'

const Open = z.array(z.object({ number: z.int(), title: z.string(), body: z.string() }))

const Block = z.object({ transactions: z.array(z.object({ version: z.union([z.literal('legacy'), z.int()]),
  transaction: z.object({ signatures: z.tuple([z.string()], z.string()) }) })) })

const Transaction = z.object({ transaction: z.tuple([z.string(), z.literal('base64')]) })

type Send = (c: Pick<Case, 'method' | 'params'>) => Promise<Reply>

const body = ({ method, params }: Pick<Case, 'method' | 'params'>): string => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })

export const sender = (url: string): Send => async (c) =>
  (await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(c) })).json()) as Reply

export function paced(send: Send, gap: number): Send {
  let last = -Infinity
  return async (c) => {
    for (let wait = last + gap - Date.now(); wait > 0; wait = last + gap - Date.now()) await sleep(wait)
    const reply = await send(c)
    last = Date.now()
    return reply
  }
}

const curl = (url: string, c: Case): string => `curl -s ${url} -X POST -H 'Content-Type: application/json' -d '${body(c).replaceAll("'", "'\\''")}'`

function claims(read: Read): string[] {
  return ['issue', 'pr'].flatMap((kind) => {
    const open = Open.parse(read([kind, 'list', '--repo', REPO, '--state', 'open', '--limit', String(WINDOW), '--json', 'number,title,body']))
    if (open.length >= WINDOW) throw new Error(`gh ${kind} list hit its cap of ${String(WINDOW)}; open rows past it are unread`)
    return open.map((o) => `${o.title}\n${o.body}`)
  })
}

async function seeded(send: Send): Promise<Given> {
  const seed = async <S extends z.ZodType>(schema: S, method: string, params: unknown[]): Promise<z.output<S>> => {
    const reply = await send({ method, params })
    if ('error' in reply) throw new Error(`mainnet ${method}: ${reply.error.message}`)
    return schema.parse(reply.result)
  }
  const tip = await seed(z.int(), 'getSlot', [])
  const [slot] = await seed(z.tuple([z.int()]), 'getBlocksWithLimit', [tip - 1000, 1])
  const { transactions } = await seed(Block, 'getBlock', [slot, { transactionDetails: 'accounts', maxSupportedTransactionVersion: 0, rewards: false }])
  const first = (version: 'legacy' | 0) => transactions.find((t) => t.version === version)?.transaction.signatures[0]
  const [signature, versioned] = [first('legacy'), first(0)]
  if (signature === undefined || versioned === undefined) throw new Error(`block ${String(slot)} lacks a legacy or a version-0 transaction`)
  const [transaction] = (await seed(Transaction, 'getTransaction', [signature, { encoding: 'base64', maxSupportedTransactionVersion: 0 }])).transaction
  return { pubkey: 'SysvarC1ock11111111111111111111111111111111', signature, unknownPubkey: '11111111111111111111111111111112',
    unknownSignature: '1'.repeat(64), transaction, slot, tip, versioned: { signature: versioned, slot } }
}

export async function mismatches(db: Db, checkout: string, sides: { mainnet: string; surfpool: string }, read: Read = gh, gap = 1000,
  at = new Date().toISOString()): Promise<{ filed: number; flaky: number; claimed: number; disabled: string[] }> {
  const claimed = claims(read)
  const [mainnet, surfpool] = [paced(sender(sides.mainnet), gap), sender(sides.surfpool)]
  const both = async (c: Case): Promise<[Reply, Reply]> => [await mainnet(c), await surfpool(c)]
  const given = await seeded(mainnet)
  const tally = { flaky: 0, claimed: 0, disabled: new Set<string>() }
  const rows: Mismatch[] = []
  for (const c of methods(checkout).filter((m) => m.name !== 'exit').flatMap((m) => cases(m, given))) {
    const first = await both(c)
    const verdict = compared(...first)
    if (verdict.verdict === 'mainnet-disabled') tally.disabled.add(c.method)
    if (verdict.verdict !== 'differs') continue
    if (claimed.some((text) => new RegExp(`\\b${c.method}\\b`).test(text))) { tally.claimed++; continue }
    let repeats = true
    for (let rerun = 0; rerun < 3 && repeats; rerun++) repeats = isDeepStrictEqual(compared(...await both(c)), verdict)
    if (!repeats) { tally.flaky++; continue }
    rows.push({ method: c.method, case: c.name, mainnet: JSON.stringify(first[0]), surfpool: JSON.stringify(first[1]),
      curls: [curl(sides.mainnet, c), curl(sides.surfpool, c)] })
  }
  mismatched(db, REPO, at, rows)
  return { filed: rows.length, flaky: tally.flaky, claimed: tally.claimed, disabled: [...tally.disabled] }
}
