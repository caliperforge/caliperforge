import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { EndpointVerdict } from '../assess.ts'
import type { ListingScan } from '../card.ts'
import { merge, render, rows } from '../fixlist.ts'

const STDERR = [
  '\u001b[1mpay catalog check\u001b[0m',
  '- acme/ok: \u001b[32mPASS\u001b[0m',
  '- fixtures/listing: \u001b[31mGET /paid: 402 without a readable offer\u001b[0m',
  '- fixtures/listing: \u001b[33mdescription length must be 64-255 characters\u001b[0m',
  '- fixtures/listing: summary length must be 24-63 characters',
  '- fixtures/listing: title is missing',
].join('\n')

test('D1-D5 stderr rows: description sized, summary not', () => {
  expect(rows(STDERR, 12, import.meta.dirname)).toStrictEqual([
    { pr: 12, listing: 'fixtures/listing', method: 'GET', path: '/paid', msg: '402 without a readable offer' },
    { pr: 12, listing: 'fixtures/listing', msg: 'description length must be 64-255 characters', range: [64, 255], length: 16 },
    { pr: 12, listing: 'fixtures/listing', msg: 'summary length must be 24-63 characters' },
    { pr: 12, listing: 'fixtures/listing', msg: 'title is missing' },
  ])
})

const endpoint = (verdict: EndpointVerdict['verdict'], issues: string[], path: string): ListingScan['endpoints'][number] =>
  ({ verdict, issues, protocols: [], quotedUsd: null, declaredUsd: null, coins: [], method: 'GET', path })
const listing = (pr: number, fqn: string, endpoints: ListingScan['endpoints']): ListingScan =>
  ({ pr, fqn, title: fqn, serviceUrl: 'https://x.test', host: 'x.test', dns: true, freehost: null, flagwords: [], nOps: 1, nScanned: 1, endpoints })
const CHECKED = '- providers/acme/weather: GET /paid: 402 without a readable offer\n- providers/acme/weather: title is missing\n'
const SCAN = [
  listing(11, 'acme/ok', [endpoint('ok', [], '/free')]),
  listing(12, 'acme/weather', [
    endpoint('warn', ['asks for $0'], '/cheap'),
    endpoint('no_402', ['HTTP 404'], '/gone'),
    endpoint('fail', ['402 without a readable offer'], '/paid'),
  ]),
]
const MERGED = [
  { pr: 11, items: [], passes: ['acme/ok GET /free'] },
  { pr: 12, passes: [], items: [
    { listing: 'acme/weather', where: 'GET /paid', what: '402 without a readable offer', blocking: true },
    { listing: 'acme/weather', where: 'PAY.md', what: 'title is missing', blocking: true },
    { listing: 'acme/weather', where: 'GET /gone', what: 'HTTP 404', blocking: true },
    { listing: 'acme/weather', where: 'GET /cheap', what: 'asks for $0', blocking: false },
  ] },
]

test('D1 D2 one fix per PR, blocking first, ok PR passes', () => {
  const fixes = merge(rows(CHECKED, 12, ''), SCAN)
  expect(fixes).toStrictEqual(MERGED)
  expect(fixes.map(render)[0]).toBe('## #11: passes\n\n### Passes\n- acme/ok GET /free\n')
})

test('D3 fixlist writes md and json per PR', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'paydesk-fixlist-'))
  const checks = join(tmp, 'checks')
  mkdirSync(checks)
  writeFileSync(join(checks, '11.stderr'), '- providers/acme/ok: PASS\n')
  writeFileSync(join(checks, '12.stderr'), CHECKED)
  writeFileSync(join(tmp, 'scan.jsonl'), JSON.stringify(SCAN))
  const said = execFileSync(process.execPath,
    [join(import.meta.dirname, '../../cli/cf.ts'), 'paydesk', 'fixlist', join(tmp, 'scan.jsonl'), checks, '--out', join(tmp, 'out')], { encoding: 'utf8' })
  expect(said).toBe(`2 PRs, 1 blocking -> ${join(tmp, 'out')}\n`)
  for (const fix of MERGED) {
    expect(JSON.parse(readFileSync(join(tmp, 'out', `${String(fix.pr)}.json`), 'utf8'))).toStrictEqual(fix)
    expect(readFileSync(join(tmp, 'out', `${String(fix.pr)}.md`), 'utf8')).toBe(render(fix))
  }
})

test('D4 a check row and the same scan issue give one item', () => {
  const [fix] = merge(rows(CHECKED, 12, '').slice(0, 1), [listing(12, 'acme/weather', [endpoint('fail', ['402 without a readable offer'], '/paid')])])
  expect(fix?.items).toHaveLength(1)
})

test('D5 an unfetched row gives no fix', () => {
  expect(merge([], [{ pr: 77, unfetched: 'HTTP 404' }])).toStrictEqual([])
})

test('D7 an unchecked endpoint neither passes nor blocks', () => {
  const fixes = merge([], [listing(14, 'acme/rpc', [endpoint('unchecked', ['recipient unchecked: HTTP 429'], '/x')])])
  expect(fixes).toStrictEqual([{ pr: 14, passes: [], items: [{ listing: 'acme/rpc', where: 'GET /x', what: 'recipient unchecked: HTTP 429', blocking: false }] }])
  expect(fixes.map(render)).toStrictEqual(['## #14: passes\n\n### To improve\n- `acme/rpc` GET /x: recipient unchecked: HTTP 429\n'])
})

test('D4 an invalid listing is one blocking item', () => {
  const fixes = merge([], [{ fqn: 'acme/bad', pr: 15, field: 'openapi', invalid_listing: 'expected object' }])
  expect(fixes).toStrictEqual([{ pr: 15, passes: [], items: [{ listing: 'acme/bad', where: 'openapi', what: 'expected object', blocking: true }] }])
  expect(fixes.map(render)[0]?.split('\n')[0]).toBe('## #15: 1 blocking')
})

test('D5 a PR with only warn items passes', () => {
  const fixes = merge([], [listing(13, 'acme/meh', [endpoint('warn', ['asks for $0'], '/x')])])
  expect(fixes.map(render)).toStrictEqual(['## #13: passes\n\n### To improve\n- `acme/meh` GET /x: asks for $0\n'])
})
