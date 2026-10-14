import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { prs, type Row } from '../prs.ts'

const base64 = (name: string): string => readFileSync(join(import.meta.dirname, 'fixtures', 'listing', name)).toString('base64')
const BLOBS: Record<string, string> = {
  pay: base64('PAY.md'), spec: base64('openapi.json'), bad: Buffer.from('---\ntitle: [unclosed\n---\n').toString('base64'),
  empty: Buffer.from('{"openapi":"3.0.0","paths":{}}').toString('base64'),
}
const TREE = [
  { path: 'docs/x.md', type: 'blob', sha: 'doc' },
  { path: 'providers/acme/weather', type: 'tree', sha: 'dir' },
  { path: 'providers/acme/weather/PAY.md', type: 'blob', sha: 'pay' },
  { path: 'providers/acme/weather/openapi.json', type: 'blob', sha: 'spec' },
  { path: 'providers/acme/broken/PAY.md', type: 'blob', sha: 'bad' },
  { path: 'providers/acme/lite/PAY.md', type: 'blob', sha: 'pay' },
  { path: 'providers/acme/lite/openapi.json', type: 'blob', sha: 'empty' },
]
interface Pr { number: number; headRefOid: string; files: string[] }
const WEATHER: Pr = { number: 11, headRefOid: 'aaa', files: ['providers/acme/weather/openapi.json'] }
const OPEN: Pr[] = [WEATHER, { number: 12, headRefOid: 'bbb', files: ['docs/x.md'] }]
const FILES = /pulls\/(\d+)\/files\?per_page=100&page=(\d+)$/
const reader = (open: Pr[], calls: string[][], fail: (path: string) => string | undefined = () => undefined) => (args: string[]): unknown => {
  calls.push(args)
  if (args[0] === 'pr') return open.map(({ number, headRefOid }) => ({ number, headRefOid }))
  const path = args[1] ?? ''
  const failed = fail(path)
  if (failed !== undefined) throw new Error(failed)
  const [, n, page] = FILES.exec(path) ?? []
  if (n !== undefined) {
    const files = open.find((p) => p.number === Number(n))?.files ?? []
    return files.slice((Number(page) - 1) * 100, Number(page) * 100).map((filename) => ({ filename, status: 'modified' }))
  }
  return path.includes('/git/trees/')
    ? { sha: 'x', truncated: false, tree: TREE }
    : { content: BLOBS[path.slice(path.lastIndexOf('/') + 1)], encoding: 'base64' }
}
const calls: string[][] = []
const read = reader(OPEN, calls)
const net = { fetch: (() => Promise.resolve(new Response('', { status: 404 }))) as typeof fetch, resolve: () => Promise.resolve() }
const tmp = mkdtempSync(join(tmpdir(), 'paydesk-prs-'))
let ran: Awaited<ReturnType<typeof prs>>

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
  const broken = { number: 13, headRefOid: 'ccc', files: ['providers/acme/broken/PAY.md'] }
  const both = await prs(dir, join(dir, 'out.json'), undefined, net, reader([WEATHER, broken], []))
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

const many = Array.from(Array(150).keys(), (i): Pr => ({ number: i + 1, headRefOid: `h${String(i)}`, files: ['providers/acme/lite/PAY.md'] }))
const backlog: string[][] = []
let full: Awaited<ReturnType<typeof prs>>
const wide = mkdtempSync(join(tmpdir(), 'paydesk-prs-'))

beforeAll(async () => {
  full = await prs(wide, join(wide, 'out.json'), join(wide, 'cards'), net,
    reader(many, backlog, (path) => (path.includes('/pulls/77/') ? 'gh: Not Found (HTTP 404)' : undefined)))
})

test('D1 150 PRs with one failed files read write 150 rows', () => {
  const rows = JSON.parse(readFileSync(join(wide, 'out.json'), 'utf8')) as Row[]
  expect(rows).toHaveLength(150)
  expect(rows.filter((r) => 'fqn' in r)).toHaveLength(149)
  expect(rows.filter((r) => 'unfetched' in r)).toEqual([{ pr: 77, unfetched: expect.stringContaining('HTTP 404') as string }])
  expect(full.unfetched.map((u) => u.pr)).toEqual([77])
  expect(readFileSync(join(wide, 'cards', 'pr-77.md'), 'utf8')).toContain('files not fetched')
})

test('D2 files are read per PR, never through --json', () => {
  expect(backlog.filter((c) => c.includes('--json')).map((c) => c[c.indexOf('--json') + 1])).toEqual(['number,headRefOid'])
  const list = backlog.find((c) => c[0] === 'pr') ?? []
  expect(Number(list[list.indexOf('--limit') + 1])).toBeGreaterThanOrEqual(150)
  const files = backlog.filter((c) => c[1]?.includes('/files'))
  expect(files).toHaveLength(150)
  expect(files.every((c) => /\/pulls\/\d+\/files\?/.test(c[1] ?? ''))).toBe(true)
})

test('D3 a PR with 101 files reads page 2', async () => {
  const at = mkdtempSync(join(tmpdir(), 'paydesk-prs-'))
  const files = [...Array.from(Array(100).keys(), (i) => `docs/${String(i)}.md`), 'providers/acme/weather/openapi.json']
  const seen: string[][] = []
  const got = await prs(at, join(at, 'out.json'), undefined, net, reader([{ number: 21, headRefOid: 'ddd', files }], seen))
  expect(seen.filter((c) => c[1]?.includes('/files')).map((c) => c[1]?.slice(-6))).toEqual(['page=1', 'page=2'])
  expect(got.listings).toEqual([expect.objectContaining({ fqn: 'acme/weather', pr: 21 })])
})

const flaky = async (errors: string[]): Promise<{ got: Awaited<ReturnType<typeof prs>>; reads: number }> => {
  const at = mkdtempSync(join(tmpdir(), 'paydesk-prs-'))
  const seen: string[][] = []
  const left = [...errors]
  const got = await prs(at, join(at, 'out.json'), undefined, net,
    reader([WEATHER], seen, (path) => (path.includes('/files') ? left.shift() : undefined)))
  return { got, reads: seen.filter((c) => c[1]?.includes('/files')).length }
}

test('D4 a 502 once is retried and the PR is scanned', async () => {
  const { got, reads } = await flaky(['HTTP 502: Bad Gateway'])
  expect(reads).toBe(2)
  expect(got.listings).toEqual([expect.objectContaining({ fqn: 'acme/weather', pr: 11 })])
})

test('D4 a 504 twice makes 2 calls and is unfetched', async () => {
  const { got, reads } = await flaky(['HTTP 504: Gateway Timeout', 'HTTP 504: Gateway Timeout'])
  expect(reads).toBe(2)
  expect(got.unfetched).toEqual([{ pr: 11, unfetched: 'HTTP 504: Gateway Timeout' }])
})

test('D4 a 404 is not retried', async () => {
  const { got, reads } = await flaky(['HTTP 404: Not Found'])
  expect(reads).toBe(1)
  expect(got.unfetched).toEqual([{ pr: 11, unfetched: 'HTTP 404: Not Found' }])
})
