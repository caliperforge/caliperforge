import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { type Compared, compared, masked, type Reply } from '../rpc.ts'

const pairs = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/rpc.json'), 'utf8')) as Record<string, { mainnet: Reply; surfpool: Reply }>

const differs = (on: 'code' | 'message' | 'shape', mainnet: string, surfpool: string): Compared => ({ verdict: 'differs', on, mainnet, surfpool })

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
])('$row the $pair pair gives $want.verdict', ({ pair, want }) => {
  const got = pairs[pair]
  if (got === undefined) throw new Error(`rpc.json has no ${pair} pair`)
  expect(compared(got.mainnet, got.surfpool)).toEqual(want)
})

it('D9 masked replaces a slot and a pubkey', () => {
  expect(masked('Slot 312345678 for 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin')).toBe('Slot <n> for <b58>')
})
