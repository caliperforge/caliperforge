import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { prs } from '../prs.ts'
import type { Scanned } from '../scan.ts'

const base64 = (name: string): string => readFileSync(join(import.meta.dirname, 'fixtures', 'listing', name)).toString('base64')
const BLOBS: Record<string, string> = {
  pay: base64('PAY.md'), spec: base64('openapi.json'), bad: Buffer.from('---\ntitle: [unclosed\n---\n').toString('base64'),
}
const TREE = [
  { path: 'docs/x.md', type: 'blob', sha: 'doc' },
  { path: 'providers/acme/weather', type: 'tree', sha: 'dir' },
  { path: 'providers/acme/weather/PAY.md', type: 'blob', sha: 'pay' },
  { path: 'providers/acme/weather/openapi.json', type: 'blob', sha: 'spec' },
  { path: 'providers/acme/broken/PAY.md', type: 'blob', sha: 'bad' },
]
const OPEN = [
  { number: 11, headRefOid: 'aaa', files: [{ path: 'providers/acme/weather/openapi.json', additions: 1, deletions: 0 }] },
  { number: 12, headRefOid: 'bbb', files: [{ path: 'docs/x.md', additions: 1, deletions: 0 }] },
]
const reader = (open: unknown[], calls: string[][]) => (args: string[]): unknown => {
  calls.push(args)
  if (args[0] === 'pr') return open
  const path = args[1] ?? ''
  return path.includes('/git/trees/')
    ? { sha: 'x', truncated: false, tree: TREE }
    : { content: BLOBS[path.slice(path.lastIndexOf('/') + 1)], encoding: 'base64' }
}
const calls: string[][] = []
const read = reader(OPEN, calls)
const net = { fetch: (() => Promise.resolve(new Response('', { status: 404 }))) as typeof fetch, resolve: () => Promise.resolve() }
const tmp = mkdtempSync(join(tmpdir(), 'paydesk-prs-'))
let ran: { prs: number; listings: Scanned[]; skipped: number[] }

beforeAll(async () => {
  ran = await prs(tmp, join(tmp, 'out.json'), undefined, net, read)
})

test('D1 a changed provider folder is scanned with its pr', () => {
  expect(ran.prs).toBe(2)
  expect(ran.listings).toHaveLength(1)
  expect(ran.listings[0]).toMatchObject({ fqn: 'acme/weather', pr: 11 })
})

test('D2 a docs-only PR is skipped and reads no blob', () => {
  expect(ran.skipped).toEqual([12])
  expect(calls.filter((c) => c[1]?.includes('/git/blobs/'))).toEqual([
    ['api', 'repos/solana-foundation/pay-skills/git/blobs/pay'],
    ['api', 'repos/solana-foundation/pay-skills/git/blobs/spec'],
  ])
})

test('D3 every read is pr list or a bare api GET', () => {
  expect(calls.every(([verb, sub, ...rest]) => (verb === 'pr' && sub === 'list') || (verb === 'api' && rest.length === 0))).toBe(true)
})

test('D5 invalid PAY.md YAML crashes only its listing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paydesk-prs-'))
  const broken = { number: 13, headRefOid: 'ccc', files: [{ path: 'providers/acme/broken/PAY.md', additions: 1, deletions: 0 }] }
  const both = await prs(dir, join(dir, 'out.json'), undefined, net, reader([OPEN[0], broken], []))
  expect(both.listings).toEqual([
    expect.objectContaining({ fqn: 'acme/weather', pr: 11 }),
    { fqn: 'acme/broken', crash: expect.any(String) as string },
  ])
})

test('D4 prs --help lists --out and --cards', () => {
  const help = execFileSync(process.execPath, [join(import.meta.dirname, '../../cli/cf.ts'), 'paydesk', 'prs', '--help'], { encoding: 'utf8' })
  expect(help).toContain('--out <file>')
  expect(help).toContain('--cards <dir>')
})
