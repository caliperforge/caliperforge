import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Cases, probe } from '../probe.ts'

type Log = { method: string; params: unknown[]; at: number }[]

const PUBKEY = 'SysvarC1ock11111111111111111111111111111111'

const REAL: Record<string, unknown> = {
  getRecentPrioritizationFees: [{ slot: 1, prioritizationFee: 0 }, { slot: 2, prioritizationFee: 0 }],
  getAccountInfo: { value: { lamports: 1, owner: PUBKEY } }, getBalance: { value: 5 }, getBlocks: [1, 2], getSlot: 7, getHealth: 'ok',
}

const SURFNET: Record<string, unknown> = {
  getRecentPrioritizationFees: [{ slot: 1, prioritizationFee: 0 }, { slot: 1, prioritizationFee: 0 }],
  getAccountInfo: { value: { lamports: 1 } }, getBalance: { value: '5' }, getBlocks: [1],
}

const listed = (params: unknown[]): number => Array.isArray(params[0]) ? params[0].length : 0

const real = (method: string, params: unknown[]) => method === 'getMultipleAccounts' && listed(params) > 100
  ? { error: { code: -32602, message: 'Too many inputs provided; max 100' } } : { result: REAL[method] ?? { value: [] } }

const surfnet = (method: string) => method in SURFNET ? { result: SURFNET[method] } : { result: REAL[method] ?? { value: [] } }

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

const servers = Promise.all([stub(real), stub(surfnet)])
const sides = async () => { const [r, s] = await servers; return { real: r.url, surfnet: s.url } }
let run: Awaited<ReturnType<typeof probe>>
let sent: Log

beforeAll(async () => {
  run = await probe(Cases.parse([
    { method: 'getMultipleAccounts', case: 'over limit', params: [{ repeat: PUBKEY, times: 101 }], compare: 'error' },
    { method: 'getMultipleAccounts', case: 'valid', params: [[PUBKEY]], compare: 'shape' },
    { method: 'getRecentPrioritizationFees', case: 'valid', params: [], compare: 'shape' },
    { method: 'getSlot', case: 'valid', params: [], compare: 'value' },
    { method: 'getHealth', case: 'valid', params: [], compare: 'error' },
  ]), await sides(), 50)
  sent = [...(await servers)[0].log]
})

afterAll(async () => { for (const s of await servers) s.close() })

it('prints only the differing cases and counts the matches', () => {
  expect(run.rows).toEqual(['getMultipleAccounts\tover limit\t-32602 Too many inputs provided; max 100\tresult',
    'getRecentPrioritizationFees\tvalid\t$ length 2\t$ repeats slot 1'])
  expect(run.matched).toBe(3)
})

it('expands a repeat param before sending it', () => {
  expect(sent.map((r) => listed(r.params))).toEqual([101, 1, 0, 0, 0])
})

it('spaces real-node requests at least gap apart', () => {
  expect(Math.min(...sent.slice(1).map((r, i) => r.at - (sent[i]?.at ?? 0)))).toBeGreaterThanOrEqual(50)
})

it.each([
  ['getAccountInfo', '$.value.owner string\t$.value.owner absent'],
  ['getBalance', '$.value number\t$.value string'],
  ['getBlocks', '$ length 2\t$ length 1'],
])('shape reports the first difference in %s', async (method, found) => {
  const { rows } = await probe(Cases.parse([{ method, case: 'valid', params: [], compare: 'shape' }]), await sides(), 0)
  expect(rows).toEqual([`${method}\tvalid\t${found}`])
})

it('ships cases.json with the over-limit and range rows', () => {
  const cases = Cases.parse(JSON.parse(readFileSync(join(import.meta.dirname, '../cases.json'), 'utf8')))
  const errors = cases.filter((c) => c.compare === 'error')
  for (const [method, n] of [['getMultipleAccounts', 101], ['getSignatureStatuses', 257], ['getInflationReward', 33], ['getRecentPrioritizationFees', 129]] as const)
    expect(errors.some((c) => c.method === method && listed(c.params) === n)).toBe(true)
  expect(errors.some((c) => c.method === 'getBlocks' && JSON.stringify(c.params) === '[0,500001]')).toBe(true)
})

it.each([
  { given: 'an unknown compare', row: { method: 'getSlot', case: 'valid', params: [], compare: 'exact' } },
  { given: 'no method', row: { case: 'valid', params: [], compare: 'value' } },
])('refuses a row with $given before sending anything', async ({ row }) => {
  const node = await stub(real)
  const file = join(mkdtempSync(join(tmpdir(), 'parity-')), 'cases.json')
  writeFileSync(file, JSON.stringify([{ method: 'getSlot', case: 'valid', params: [], compare: 'value' }, row]))
  const child = spawn(process.execPath, [join(import.meta.dirname, '../run.ts'), '--rpc', node.url, '--cases', file], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const [code] = await once(child, 'close') as [number]
  node.close()
  expect([code, node.log]).toEqual([1, []])
  expect(stderr).toContain('[1]')
})
