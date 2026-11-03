import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { cases, type Given } from '../cases.ts'
import { type Compared, compared, masked, methods, type Reply } from '../rpc.ts'

const pairs = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/rpc.json'), 'utf8')) as Record<string, { mainnet: Reply; surfpool: Reply }>

const differs = (on: 'code' | 'message' | 'shape', mainnet: string, surfpool: string): Compared => ({ verdict: 'differs', on, mainnet, surfpool })

const SURFPOOL = join(import.meta.dirname, 'fixtures', 'surfpool')

const given: Given = {
  pubkey: 'Pk', signature: 'Sig', unknownPubkey: 'NoPk', unknownSignature: 'NoSig', transaction: 'Tx',
  slot: 7, tip: 10, versioned: { signature: 'VSig', slot: 8 },
}

const method = (name: string) => {
  const found = methods(SURFPOOL).find((m) => m.name === name)
  if (found === undefined) throw new Error(`${name} not read`)
  return found
}

const params = (name: string) => Object.fromEntries(cases(method(name), given).map((c) => [c.name, c.params]))

it.each([
  { row: 'D1', pair: 'version', want: differs('code', '-32015', '-32603') },
  { row: 'D2', pair: 'balance', want: { verdict: 'same' } },
  { row: 'D3', pair: 'apiVersion', want: differs('shape', '{"context":{"apiVersion":"string","slot":"number"},"value":"number"}',
    '{"context":{"slot":"number"},"value":"number"}') },
  { row: 'D4', pair: 'disabled', want: { verdict: 'mainnet-disabled' } },
  { row: 'D5', pair: 'slot', want: { verdict: 'same' } },
  { row: 'D6', pair: 'pubkey', want: { verdict: 'same' } },
  { row: 'D7', pair: 'param', want: differs('message', 'Invalid param: WrongSize', 'Invalid params: expected <n> to <n> parameters, got <n>') },
  { row: 'D8', pair: 'errorResult', want: differs('code', '-32004', 'result') },
  { row: 'D2', pair: 'emptyArray', want: { verdict: 'same' } },
  { row: 'D2', pair: 'nestedArray', want: { verdict: 'same' } },
])('$row the $pair pair gives $want.verdict', ({ pair, want }) => {
  const got = pairs[pair]
  if (got === undefined) throw new Error(`rpc.json has no ${pair} pair`)
  expect(compared(got.mainnet, got.surfpool)).toEqual(want)
})

it('D9 masked replaces a slot and a pubkey', () => {
  expect(masked('Slot 312345678 for 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin')).toBe('Slot <n> for <b58>')
})

it('lists methods in file then source order without surfnet_*', () => {
  expect(methods(SURFPOOL).map((m) => m.name)).toEqual(['getAccountInfo', 'getHealth', 'getMultipleAccounts', 'getNewThing', 'getTransaction'])
})

it('reads params with whitespace removed and wrappers unwrapped', () => {
  expect(method('getTransaction').params).toEqual([{ name: 'signature_str', type: 'String' }, { name: 'config', type: 'RpcTransactionConfig', optional: true }])
  expect(method('getHealth').params).toEqual([])
})

it('builds each table case on the valid params', () => {
  expect(params('getAccountInfo')).toEqual({
    'valid': ['Pk'], 'unknown': ['NoPk'], 'base58': ['0OIl'], 'type:pubkey_str': [1], 'type:config': ['Pk', 'x'],
    'missing': [], 'extra': ['Pk', null, 'extra'], 'encoding': ['Pk', { encoding: 'json' }],
    'commitment': ['Pk', { commitment: 'unknown' }], 'minContextSlot': ['Pk', { minContextSlot: 1_000_010 }],
  })
  expect(cases(method('getAccountInfo'), given).every((c) => c.method === 'getAccountInfo')).toBe(true)
})

it('gives a listed method a limit case one over its maximum', () => {
  const built = params('getMultipleAccounts')
  expect(Object.keys(built)).toEqual(['valid', 'unknown', 'base58', 'type:pubkey_strs', 'type:config', 'missing', 'extra',
    'encoding', 'commitment', 'minContextSlot', 'limit'])
  expect([built.valid, built.unknown, built['type:pubkey_strs']]).toEqual([[['Pk']], [['NoPk']], ['x']])
  expect(built.limit).toEqual([Array<string>(101).fill('Pk')])
})

it('swaps in the versioned signature for the version cases', () => {
  const built = params('getTransaction')
  expect(Object.keys(built)).toEqual(['valid', 'unknown', 'base58', 'type:signature_str', 'type:config', 'missing', 'extra',
    'encoding', 'commitment', 'version-absent', 'version-0'])
  expect([built.unknown, built.encoding]).toEqual([['NoSig'], ['Sig', { encoding: 'base64+zstd' }]])
  expect([built['version-absent'], built['version-0']]).toEqual([['VSig', {}], ['VSig', { maxSupportedTransactionVersion: 0 }]])
})

it('gives a method with no params only valid and extra', () => {
  expect(params('getHealth')).toEqual({ valid: [], extra: ['extra'] })
})

it('gives no cases to a required param of an unlisted type', () => {
  expect(cases(method('getNewThing'), given)).toEqual([])
})

it('leaves out an optional param of an unlisted type', () => {
  const built = cases({ name: 'getSlot', params: [{ name: 'x', type: 'Odd', optional: true }, { name: 'config', type: 'RpcContextConfig', optional: true }] }, given)
  expect(built.map((c) => [c.name, c.params])).toEqual([['valid', []], ['type:config', [null, 'x']], ['extra', [null, null, 'extra']],
    ['commitment', [null, { commitment: 'unknown' }]], ['minContextSlot', [null, { minContextSlot: 1_000_010 }]]])
})

it('throws when the rpc directory is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'surfpool-'))
  expect(() => methods(dir)).toThrow(`${join(dir, 'crates', 'core', 'src', 'rpc')} is missing`)
})

it('throws when the rpc directory holds no #[rpc] method', () => {
  const dir = mkdtempSync(join(tmpdir(), 'surfpool-'))
  const rpc = join(dir, 'crates', 'core', 'src', 'rpc')
  mkdirSync(rpc, { recursive: true })
  writeFileSync(join(rpc, 'full.rs'), '#[rpc]\npub trait Full {\n    #[pubsub(name = "slotSubscribe")]\n    fn slot_subscribe(&self);\n}\n')
  expect(() => methods(dir)).toThrow(`no #[rpc] methods in ${rpc}`)
})
