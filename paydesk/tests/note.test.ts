import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { ListingScan } from '../card.ts'
import { note } from '../note.ts'
import type { Row } from '../prs.ts'

const FIXTURE = join(import.meta.dirname, 'fixtures/notes-scan.json')
const LISTINGS = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Row[]).filter((r): r is ListingScan => 'endpoints' in r)
const NOTES = new Map(LISTINGS.map((l) => [l.fqn, note(l, 'Signer')]))
const SENT = ['acme/payto', 'acme/wallet', 'acme/price', 'acme/gone', 'acme/down', 'acme/two', 'acme/many']

test('D1 a missing token account names payTo and the fix', () => {
  expect(NOTES.get('acme/payto')).toContain('POST `https://payto.test/v1/items/{id}`: the payTo named in the 402 has no USDC token account')
  expect(NOTES.get('acme/payto')).toContain('creating the associated token account for that address')
})

test('D2 a token account payTo asks for the owner wallet', () => {
  expect(NOTES.get('acme/wallet')).toContain('GET `https://wallet.test/a`: the 402 names a token account as payTo; it should name the owner wallet.')
})

test('D3 a price mismatch names both prices', () => {
  expect(NOTES.get('acme/price')).toContain('the 402 asks $0.05 but the listing declares $0.01; one of them is wrong.')
})

test('D4 no_402 and unreachable say what answered', () => {
  expect(NOTES.get('acme/gone')).toContain('GET `https://gone.test/g`: it answered HTTP 404 instead of a 402 on an unpaid call.')
  expect(NOTES.get('acme/down')).toContain('it answered fetch failed instead of a 402 on an unpaid call.')
})

test('D5 ok and unfixable listings get no note', () => {
  expect(NOTES.get('acme/ok')).toBeNull()
  expect(NOTES.get('acme/meh')).toBeNull()
})

test('D6 two failing endpoints give one note with both lines', () => {
  expect(NOTES.get('acme/two')).toBe([
    'Hi,',
    'GET `https://two.test/one`: it answered HTTP 500 instead of a 402 on an unpaid call.',
    'POST `https://two.test/two`: the 402 names a token account as payTo; it should name the owner wallet. the 402 asks $0.05 but the listing declares $0.01; one of them is wrong.',
    "Happy to re-test once it's done.",
    'Signer',
    '',
  ].join('\n'))
})

test('D7 every note is short, plain and signed', () => {
  for (const fqn of SENT) {
    const lines = (NOTES.get(fqn) ?? '').trimEnd().split('\n')
    expect(lines.length).toBeLessThanOrEqual(8)
    expect([lines[0], ...lines.slice(-2)]).toStrictEqual(['Hi,', "Happy to re-test once it's done.", 'Signer'])
    expect(lines.filter((l) => l.startsWith('#') || l.startsWith('- '))).toStrictEqual([])
    expect(lines.join('\n')).not.toMatch(/leverage|robust|seamless|hope this finds you/i)
  }
  const many = (NOTES.get('acme/many') ?? '').trimEnd().split('\n')
  expect(many).toHaveLength(8)
  expect(many[5]).toBe('3 more endpoints have issues like these.')
})

test('D5 D8 notes writes one file per note, none for crashes', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'paydesk-notes-')), 'out')
  const said = execFileSync(process.execPath,
    [join(import.meta.dirname, '../../cli/cf.ts'), 'paydesk', 'notes', FIXTURE, '--out', out, '--from', 'Signer'], { encoding: 'utf8' })
  expect(said).toBe(`7 notes -> ${out}\n`)
  expect(readdirSync(out).sort()).toStrictEqual(SENT.map((f) => `${f.replace('/', '__')}.md`).sort())
  expect(readFileSync(join(out, 'acme__two.md'), 'utf8')).toBe(NOTES.get('acme/two'))
})
