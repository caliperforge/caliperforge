import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { maybe } from '../../../sequencer/workspace.ts'
import type { PlanRow } from '../../../store/plans.ts'
import { sourced } from '../../../templates/research.ts'

const plan = { id: 1 } as unknown as PlanRow
const root = (): string => mkdtempSync(join(tmpdir(), 'cf-sources-'))
const fenced = (body: string): string => `Found it.\n\n---\n${body}---\n`

const A = { url: 'https://a.example/doc', fetched_at: '2026-10-04T10:00:00Z', quote: 'The cap is 3.', claim: 'The cap is 3' }
const B = { url: 'https://b.example/page', fetched_at: '2026-10-04T10:05:00Z', quote: 'Note: the limit is 5.', claim: 'The limit is 5' }

const entry = (s: { url: string, fetched_at: string, claim: string }, quote: string | null): string =>
  `  - url: ${s.url}\n    fetched_at: ${s.fetched_at}\n${quote === null ? '' : `    quote:${quote}\n`}    claim: ${s.claim}\n`

const written = (dir: string): unknown => JSON.parse(maybe(dir, 1, 'sources.json') ?? 'null')

test('D1: two sources write both to sources.json in order', () => {
  const dir = root()
  expect(sourced(dir, plan, fenced(`sources:\n${entry(A, ` ${A.quote}`)}${entry(B, ` ${B.quote}`)}`)))
    .toMatchObject({ outcome: 'pass', spans: [] })
  expect(written(dir)).toEqual([A, B])
})

test.each([
  { why: 'missing', quote: null },
  { why: 'empty', quote: '' },
  { why: 'blank', quote: ' "  "' },
])('D2: a $why quote is refused and writes no file', ({ quote }) => {
  const dir = root()
  expect(sourced(dir, plan, fenced(`sources:\n${entry(A, ` ${A.quote}`)}${entry(B, quote)}`)))
    .toMatchObject({ outcome: 'refuse', spans: ['researcher.unquoted'] })
  expect(maybe(dir, 1, 'sources.json')).toBeNull()
})

test.each([
  { why: 'no fence', reply: 'Nothing to close with.' },
  { why: 'a fence that is not sources', reply: fenced('items:\n  - title: x\n') },
])('D3: a reply with $why is refused and writes no file', ({ reply }) => {
  const dir = root()
  expect(sourced(dir, plan, reply)).toMatchObject({ outcome: 'refuse', spans: ['researcher.fence'] })
  expect(maybe(dir, 1, 'sources.json')).toBeNull()
})

test('D4: sources: [] passes and writes []', () => {
  const dir = root()
  expect(sourced(dir, plan, fenced('sources: []\n'))).toMatchObject({ outcome: 'pass' })
  expect(maybe(dir, 1, 'sources.json')).toBe('[]')
})

test('D5: a quote holding ": " is stored exactly as written', () => {
  const dir = root()
  sourced(dir, plan, fenced(`sources:\n${entry(B, ` ${B.quote}`)}`))
  expect(written(dir)).toEqual([B])
})
