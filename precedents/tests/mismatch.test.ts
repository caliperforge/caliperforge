import { cpSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Read } from '../../cli/gh.ts'
import { mismatched } from '../../store/parity.ts'
import { cases, type Given } from '../cases.ts'
import { mismatches } from '../mismatch.ts'
import { openings } from '../openings.ts'
import { methods } from '../rpc.ts'

type Log = { method: string; params: unknown[]; at: number }[]

const SCHEMA = join(import.meta.dirname, '../../schema')

const REPO = 'solana-foundation/surfpool'

const AT = '2026-11-03T00:00:00Z'

const PUBKEY = 'SysvarC1ock11111111111111111111111111111111'

const SEEDS: Record<string, unknown> = {
  getSlot: 5000, getBlocksWithLimit: [4000], getTransaction: { transaction: ['AQID', 'base64'] },
  getBlock: { transactions: [{ version: 'legacy', transaction: { signatures: ['Legacy'] } }, { version: 0, transaction: { signatures: ['Versioned'] } }] },
}

const VALID: Record<string, string> = { getAccountInfo: JSON.stringify([PUBKEY]), getMultipleAccounts: JSON.stringify([[PUBKEY]]), getTransaction: '["Legacy"]' }

const result = (method: string) => ({ result: SEEDS[method] ?? { context: { slot: 1 }, value: null } })

const disabling = (method: string) => method === 'getHealth' ? { error: { code: -32601, message: 'getHealth is disabled' } } : result(method)

const read: Read = (args) => args[0] === 'issue' ? [{ number: 1, title: 'getTransaction drops meta', body: '' }]
  : [{ number: 2, title: 'Add getAccountInfoBatch', body: '' }]

async function stub(answer: (method: string, params: unknown[]) => unknown) {
  const log: Log = []
  const server = createServer((req, res) => {
    let text = ''
    req.on('data', (chunk: Buffer) => { text += chunk.toString() })
    req.on('end', () => {
      const { method, params } = JSON.parse(text) as { method: string; params: unknown[] }
      log.push({ method, params, at: Date.now() })
      res.setHeader('Content-Type', 'application/json').end(JSON.stringify(answer(method, params)))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, log, close: () => { server.closeAllConnections(); server.close() } }
}

function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), 'surfpool-'))
  cpSync(join(import.meta.dirname, 'fixtures', 'surfpool'), dir, { recursive: true })
  writeFileSync(join(dir, 'crates/core/src/rpc/admin.rs'),
    '#[rpc]\npub trait AdminRpc {\n    type Metadata;\n\n    #[rpc(meta, name = "exit")]\n    fn exit(&self, meta: Self::Metadata);\n}\n')
  return dir
}

const db = fresh(SCHEMA)
const dir = checkout()
let flips = 0
const servers = Promise.all([stub(disabling), stub((method, params) =>
  VALID[method] !== JSON.stringify(params) || (method === 'getMultipleAccounts' && ++flips > 1) ? result(method) : { result: { value: null } })])
let run: Awaited<ReturnType<typeof mismatches>>

beforeAll(async () => {
  const [mainnet, surfpool] = await servers
  run = await mismatches(db, dir, { mainnet: mainnet.url, surfpool: surfpool.url }, read, 50, AT)
})

afterAll(async () => { for (const s of await servers) s.close() })

it('sends every case but exit to both sides', async () => {
  const [mainnet, surfpool] = await servers
  const given: Given = { pubkey: PUBKEY, signature: 'Legacy', unknownPubkey: '11111111111111111111111111111112', unknownSignature: '1'.repeat(64),
    transaction: 'AQID', slot: 4000, tip: 5000, versioned: { signature: 'Versioned', slot: 4000 } }
  const sent = (log: Log) => log.map((r) => JSON.stringify([r.method, r.params]))
  expect([...new Set(sent(surfpool.log))]).toEqual(methods(dir).filter((m) => m.name !== 'exit').flatMap((m) => cases(m, given))
    .map((c) => JSON.stringify([c.method, c.params])))
  expect(sent(mainnet.log).slice(4)).toEqual(sent(surfpool.log))
  expect(sent(mainnet.log).slice(0, 2)).toEqual(['["getSlot",[]]', '["getBlocksWithLimit",[4000,1]]'])
})

it('spaces mainnet requests at least gap apart', async () => {
  const [{ log }] = await servers
  expect(Math.min(...log.slice(1).map((r, i) => r.at - (log[i]?.at ?? 0)))).toBeGreaterThanOrEqual(50)
})

it('files a repeating difference and drops a one-off as flaky', () => {
  expect([run.filed, run.flaky]).toEqual([1, 1])
  expect(openings(db, REPO).map((o) => o.area)).toEqual(['getAccountInfo valid'])
})

it('reports a mainnet-disabled method without filing it', () => {
  expect(run.disabled).toEqual(['getHealth'])
})

it('skips a method an open issue names as a whole word', () => {
  expect(run.claimed).toBe(1)
})

it('stores both raw replies and both curls', async () => {
  const [mainnet, surfpool] = await servers
  const body = `{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["${PUBKEY}"]}`
  const quote = openings(db, REPO)[0]?.quote
  for (const part of [`mainnet: ${JSON.stringify(result('getAccountInfo'))}`, 'surfpool: {"result":{"value":null}}',
    `curl -s ${mainnet.url} -X POST -H 'Content-Type: application/json' -d '${body}'`,
    `curl -s ${surfpool.url} -X POST -H 'Content-Type: application/json' -d '${body}'`]) expect(quote).toContain(part)
})

it('stores nothing when the run throws', async () => {
  const earlier = fresh(SCHEMA)
  mismatched(earlier, REPO, AT, [{ method: 'getHealth', case: 'valid', mainnet: '{}', surfpool: '{}', curls: ['a', 'b'] }])
  const mainnet = await stub(() => ({ error: { code: -32005, message: 'node is behind' } }))
  await expect(mismatches(earlier, dir, { mainnet: mainnet.url, surfpool: mainnet.url }, read, 0, AT)).rejects.toThrow('mainnet getSlot: node is behind')
  mainnet.close()
  expect(openings(earlier, REPO).map((o) => o.area)).toEqual(['getHealth valid'])
})
