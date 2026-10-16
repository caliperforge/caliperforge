import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { EndpointVerdict } from '../paydesk/assess.ts'
import type { ListingScan } from '../paydesk/card.ts'
import type { Row } from '../paydesk/prs.ts'
import { parsed, recent, type Spend } from './paydesk-paid.ts'

const CF = join(import.meta.dirname, '../cli/cf.ts')
const TX = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW'
const DAY = 24 * 60 * 60 * 1000

const endpoint = (verdict: EndpointVerdict['verdict'], path: string, quotedUsd: number | null, declaredUsd: number | null = null): ListingScan['endpoints'][number] =>
  ({ verdict, issues: [], protocols: [], quotedUsd, declaredUsd, coins: [], method: 'GET', path })
const listing = (pr: number, name: string, endpoints: ListingScan['endpoints'], dns = true): ListingScan =>
  ({ pr, fqn: `acme/${name}`, title: name, serviceUrl: `https://${name}.test/`, host: `${name}.test`, dns, freehost: null, flagwords: [], nOps: 1, nScanned: 1, endpoints })
const SCAN: Row[] = [
  listing(1, 'a', [endpoint('fail', '/x', 0.001), endpoint('ok', '/zero', 0), endpoint('warn', '/w', 0.02), endpoint('ok', '/a/{id}', null, 0.01)]),
  listing(2, 'bad', [endpoint('ok', '/b', 0.01)]),
  { fqn: 'acme/crash', crash: 'boom' },
  { pr: 4, unfetched: 'HTTP 404' },
  listing(5, 'nodns', [endpoint('ok', '/n', 0.01)], false),
  listing(6, 'free', [endpoint('no_402', '/f', 0.01), endpoint('ok', '/g', null)]),
  listing(7, 'seen', [endpoint('ok', '/s', 0.01)]),
  listing(8, 'old', [endpoint('ok', '/o', 0.01)]),
  listing(9, 'big', [endpoint('ok', '/big', 0.05)]),
  listing(10, 'after', [endpoint('ok', '/cheap', 0.001)]),
]

const ledgerLine = (fqn: string, ago: number): string => JSON.stringify({ at: new Date(Date.now() - ago * DAY).toISOString(), fqn })

function swept(): { tmp: string; said: string; argv: string[][]; ledger: string[] } {
  const tmp = mkdtempSync(join(tmpdir(), 'paydesk-paid-'))
  const argv = join(tmp, 'argv.jsonl')
  writeFileSync(join(tmp, 'pay'), [
    `#!${process.execPath}`,
    'const args = process.argv.slice(2)',
    `require('node:fs').appendFileSync(${JSON.stringify(argv)}, JSON.stringify(args) + '\\n')`,
    "if (args.at(-1) === 'https://bad.test/b') { process.stderr.write('status=500\\n'); process.stdout.write('{\"error\":\"declined\"}'); process.exit(1) }",
    "process.stdout.write('{\"ok\":true}')",
    `process.stderr.write('status=200 paid 0.01 USDC tx=${TX}\\n')`,
  ].join('\n'))
  chmodSync(join(tmp, 'pay'), 0o755)
  writeFileSync(join(tmp, 'scan.json'), JSON.stringify(SCAN))
  writeFileSync(join(tmp, 'ledger.jsonl'), `${ledgerLine('acme/seen', 1)}\nnot json\n${ledgerLine('acme/old', 8)}\n`)
  const said = execFileSync(process.execPath, [CF, 'paydesk', 'paid', join(tmp, 'scan.json'), '--cap', '0.04', '--ledger', join(tmp, 'ledger.jsonl'),
    '--out', join(tmp, 'out.jsonl'), '--account', 'test'], { encoding: 'utf8', env: { ...process.env, PAY_BIN: join(tmp, 'pay') } })
  const lines = (file: string): string[] => readFileSync(file, 'utf8').trimEnd().split('\n')
  return { tmp, said, argv: lines(argv).map((l) => JSON.parse(l) as string[]), ledger: lines(join(tmp, 'ledger.jsonl')) }
}

const RUN = swept()
const SPENT = RUN.ledger.slice(3).map((l) => JSON.parse(l) as Spend)

test('D1 the run stops before a call that passes the cap', () => {
  expect(RUN.said).toBe(`3 paid, 5 skipped, $0.02 spent, stopped at cap -> ${join(RUN.tmp, 'out.jsonl')}\n`)
  expect(RUN.argv.map((a) => a.at(-1))).not.toContain('https://after.test/cheap')
})

test('D2 one ledger row per call and none for the rest', () => {
  expect(RUN.argv).toHaveLength(3)
  expect(RUN.ledger).toHaveLength(6)
  expect(SPENT.map((s) => [s.fqn, s.endpoint, s.usdc, s.status, s.data])).toStrictEqual([
    ['acme/a', 'GET https://a.test/a/test', 0.01, 200, true],
    ['acme/bad', 'GET https://bad.test/b', 0, 500, false],
    ['acme/old', 'GET https://old.test/o', 0.01, 200, true],
  ])
})

test('D3 D7 only fresh, priced, reachable listings are called', () => {
  expect(RUN.argv.map((a) => a.at(-1))).toStrictEqual(['https://a.test/a/test', 'https://bad.test/b', 'https://old.test/o'])
})

test('D4 the stub sees the documented argv', () => {
  expect(RUN.argv[0]).toStrictEqual(['--no-dna', '--mainnet', '--yolo-upto', '0.010000', '--verbose', '--account', 'test', 'fetch', '-X', 'GET', 'https://a.test/a/test'])
})

test('D5 a failed call becomes a note and a blocking fix', () => {
  const out = join(RUN.tmp, 'out.jsonl')
  const rows = readFileSync(out, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as ListingScan)
  expect(rows.map((r) => r.endpoints.map((e) => [e.path, e.verdict, e.issues]))).toStrictEqual([
    [['/a/{id}', 'ok', []]], [['/b', 'fail', ['paid call got no data (HTTP 500)']]], [['/o', 'ok', []]],
  ])
  execFileSync(process.execPath, [CF, 'paydesk', 'notes', out, '--out', join(RUN.tmp, 'notes'), '--from', 'Signer'])
  expect(readdirSync(join(RUN.tmp, 'notes'))).toStrictEqual(['acme__bad.md'])
  expect(readFileSync(join(RUN.tmp, 'notes', 'acme__bad.md'), 'utf8'))
    .toContain('GET `https://bad.test/b`: a paid call got no data back (HTTP 500), so a buyer pays and receives nothing.')
  mkdirSync(join(RUN.tmp, 'checks'))
  const said = execFileSync(process.execPath, [CF, 'paydesk', 'fixlist', out, join(RUN.tmp, 'checks'), '--out', join(RUN.tmp, 'fixes')], { encoding: 'utf8' })
  expect(said).toBe(`3 PRs, 1 blocking -> ${join(RUN.tmp, 'fixes')}\n`)
})

test('D6 no tx in stderr is null in parsed and the ledger', () => {
  expect(parsed('', 'status=500\n', 1)).toStrictEqual({ status: 500, usdc: null, tx: null, data: false })
  expect(parsed('{}', `status: 200 paid 0.01 USDC signature="${TX}"`, 0)).toStrictEqual({ status: 200, usdc: 0.01, tx: TX, data: true })
  expect(RUN.ledger[4]).toContain('"tx":null')
  expect(SPENT[0]?.tx).toBe(TX)
})

test('D3 recent ignores malformed lines and old rows', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'paydesk-recent-'))
  const ledger = join(tmp, 'ledger.jsonl')
  writeFileSync(ledger, ['{', 'null', '{"fqn":"acme/nat","at":"never"}', '{"at":"2026-10-15T00:00:00Z"}', ledgerLine('acme/old', 8), ledgerLine('acme/new', 6)].join('\n'))
  expect(recent(ledger, new Date())).toStrictEqual(new Set(['acme/new']))
  expect(recent(join(tmp, 'missing.jsonl'), new Date())).toStrictEqual(new Set())
})
