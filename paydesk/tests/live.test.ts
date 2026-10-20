import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type { ListingScan } from '../card.ts'
import { diffed, live, recheck } from '../live.ts'
import type { Net, Scanned } from '../scan.ts'

const X402 = { accepts: [{ scheme: 'exact', network: 'solana', amount: '10000', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', payTo: 'SysvarRent111111111111111111111111111111111' }] }
const wallet = (body: string): Response => Response.json({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 },
  value: body.includes('getAccountInfo') ? { owner: '11111111111111111111111111111111' } : [{ pubkey: 'ata', account: {} }] } })
const net: Net = {
  fetch: (...[url, init]: Parameters<typeof fetch>) => Promise.resolve(url === 'https://api.mainnet-beta.solana.com' ? wallet(init?.body as string) : init?.body === '{"symbol":"SOL"}'
    ? new Response('bad', { status: 400 })
    : new Response(JSON.stringify(X402), { status: 402, headers: { 'content-type': 'application/json' } })),
  resolve: () => Promise.resolve(),
}
const listing = join(import.meta.dirname, 'fixtures', 'listing')

const scanned = (fqn: string, verdict: 'pass' | 'fix needed' | 'reject' | 'crash'): Scanned => (verdict === 'crash'
  ? { fqn, crash: 'boom' }
  : { pr: 1, fqn, title: fqn, serviceUrl: 'https://x.example.com', host: 'x.example.com', dns: verdict !== 'reject', freehost: null, flagwords: [], nOps: 1, nScanned: 1,
      endpoints: [{ method: 'GET', path: '/', verdict: verdict === 'pass' ? 'ok' : 'warn', issues: [], protocols: [], quotedUsd: null, declaredUsd: null, coins: [] }] } satisfies ListingScan)
const seed = (dir: string, date: string, rows: Scanned[]): void => {
  writeFileSync(join(dir, `live-${date}.jsonl`), rows.map((r) => `${JSON.stringify(r)}\n`).join(''))
}
const catalog = (): string[] => {
  const root = mkdtempSync(join(tmpdir(), 'paydesk-catalog-'))
  return ['a', 'b', 'c'].map((name) => {
    const dir = join(root, 'org', name)
    cpSync(listing, dir, { recursive: true })
    return dir
  })
}
const outFile = (): string => join(mkdtempSync(join(tmpdir(), 'paydesk-recheck-')), 'recheck.json')

test('D1-D3 diffed lists newly failing, newly passing and gone', () => {
  const last = [scanned('o/fixed', 'pass'), scanned('o/rejected', 'reject'), scanned('o/crashed', 'crash'), scanned('o/same', 'pass'), scanned('o/dropped', 'reject')]
  const now = [scanned('o/fixed', 'fix needed'), scanned('o/rejected', 'pass'), scanned('o/new-bad', 'crash'), scanned('o/crashed', 'pass'), scanned('o/same', 'pass'), scanned('o/new-good', 'pass')]
  expect(diffed(last, now)).toEqual({ failing: ['o/fixed', 'o/new-bad'], passing: ['o/rejected', 'o/crashed', 'o/new-good'], gone: ['o/dropped'] })
})

test('D4 live writes jsonl, cards and md against the last pass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paydesk-live-'))
  seed(dir, '2026-10-05', [scanned('fixtures/listing', 'reject'), scanned('org/old', 'pass')])
  seed(dir, '2026-10-19', [scanned('org/future', 'pass')])
  expect(await live(dir, '2026-10-12', [listing], net)).toEqual({ failing: [], passing: ['fixtures/listing'], gone: ['org/old'] })
  const rows = readFileSync(join(dir, 'live-2026-10-12.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Scanned)
  expect(rows.map((r) => r.fqn)).toEqual(['fixtures/listing'])
  expect(readdirSync(join(dir, 'live-2026-10-12'))).toEqual(['fixtures__listing.md'])
  expect(readFileSync(join(dir, 'live-2026-10-12.md'), 'utf8')).toBe([
    '# pay-skills live 2026-10-12 against 2026-10-05', '',
    '## Newly failing', '- none', '## Newly passing', '- fixtures/listing', '## Gone', '- org/old', '',
  ].join('\n'))
})

test('D6 with no earlier pass the md says so and nothing is gone', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'paydesk-live-')), 'paydesk')
  await live(dir, '2026-10-12', [listing], net)
  expect(readFileSync(join(dir, 'live-2026-10-12.md'), 'utf8')).toBe([
    '# pay-skills live 2026-10-12 against no earlier pass', '',
    '## Newly failing', '- none', '## Newly passing', '- fixtures/listing', '## Gone', '- none', '',
  ].join('\n'))
})

test('D1 recheck scans only the named listings in catalog order', async () => {
  const rows = await recheck(catalog(), ['org/c', 'org/a'], outFile(), net)
  expect(rows.map((r) => r.fqn)).toEqual(['org/a', 'org/c'])
})

test('D2 an unknown fqn goes to stderr and the run continues', async () => {
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const rows = await recheck(catalog(), ['org/a', 'org/nope'], outFile(), net)
  expect(write).toHaveBeenCalledWith('not in the catalog: org/nope\n')
  write.mockRestore()
  expect(rows.map((r) => r.fqn)).toEqual(['org/a'])
})

test('D3-D4 recheck writes only out, as scan rows', async () => {
  const out = outFile()
  const rows = await recheck(catalog(), ['org/b'], out, net)
  expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(rows)
  expect(readdirSync(join(out, '..'))).toEqual(['recheck.json'])
})
