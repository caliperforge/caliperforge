import { expect, test } from 'vitest'
import { rows } from '../fixlist.ts'

const STDERR = [
  '\u001b[1mpay catalog check\u001b[0m',
  '- acme/ok: \u001b[32mPASS\u001b[0m',
  '- fixtures/listing: \u001b[31mGET /paid: 402 without a readable offer\u001b[0m',
  '- fixtures/listing: \u001b[33msummary length must be 24-63 characters\u001b[0m',
  '- fixtures/listing: title is missing',
].join('\n')

test('D1-D4 stderr becomes fix rows with ranges on lengths', () => {
  expect(rows(STDERR, 12, import.meta.dirname)).toStrictEqual([
    { pr: 12, listing: 'fixtures/listing', method: 'GET', path: '/paid', msg: '402 without a readable offer' },
    { pr: 12, listing: 'fixtures/listing', msg: 'summary length must be 24-63 characters', range: [24, 63], length: 13 },
    { pr: 12, listing: 'fixtures/listing', msg: 'title is missing' },
  ])
})
