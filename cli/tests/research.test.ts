import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { plan, world } from '../../sequencer/tests/world.ts'
import { maybe } from '../../sequencer/workspace.ts'
import { drafted } from '../../templates/research.ts'
import { planOf } from '../research.ts'

const draft = (quote: string): string =>
  `The cap is 3 [source:1].\n\n---\nsources:\n  - url: https://a.example/doc\n    fetched_at: 2026-10-04T10:00:00Z\n    quote: ${quote}\n    claim: The cap is 3\n---\n`

let fetched = vi.fn<typeof fetch>()

beforeEach(() => {
  fetched = vi.fn<typeof fetch>(() => Promise.resolve(new Response('The cap\n  is 3.')))
  vi.stubGlobal('fetch', fetched)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test('D2: a paraphrased quote is quote_missing, nothing written', async () => {
  const w = world()
  expect(await drafted(w.root, plan(w.db, 1), draft('The limit is three.'))).toMatchObject({ outcome: 'refuse', spans: ['research.quote_missing'] })
  expect(maybe(w.root, 1, 'sources.json')).toBeNull()
  expect(maybe(w.root, 1, 'answer.md')).toBeNull()
})

test('D3: a draft with no sources fence is refused unfetched', async () => {
  const w = world()
  expect(await drafted(w.root, plan(w.db, 1), 'The cap is 3 [source:1].')).toMatchObject({ outcome: 'refuse', spans: ['researcher.fence'] })
  expect(fetched).not.toHaveBeenCalled()
})

test('D4: a quote on the page passes', async () => {
  const w = world()
  expect(await drafted(w.root, plan(w.db, 1), draft('The cap is 3.')))
    .toEqual({ outcome: 'pass', spans: [], note: '1 sentence(s) checked against 1 url(s)' })
})

test('D5: planOf reads the plan from its checkout, else throws', () => {
  const root = join(tmpdir(), 'cf-root')
  expect(planOf(root, join(root, '.cf/work/1/src'))).toBe(1)
  expect(() => planOf(root, tmpdir())).toThrow("cf research check runs from a plan's checkout")
})
