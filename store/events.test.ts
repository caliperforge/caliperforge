import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../checks/sqlite.ts'
import type { Fired } from '../providers/kind.ts'
import { planRow } from '../runner/index.ts'
import { load, seat } from '../runner/rules.ts'
import { repriced, runAt, runLogged } from './events.ts'
import type { Db } from './index.ts'

const root = join(import.meta.dirname, '..')

const price = (db: Db, model: string, from: string, input = 5, url = 'https://example.com/pricing', write1h: number | null = 10): unknown =>
  db.prepare(`INSERT INTO prices (provider, model, input, cache_read, cache_write, cache_write_1h, output, effective_from, source_url)
    VALUES ('claude-agent-sdk', ?, ?, 0.5, 6.25, ?, 25, ?, ?)`).run(model, input, write1h, from, url)

const setup = (): { db: Db; log: (usage: Fired['usage'], model?: string) => number; computed: (id: number) => unknown; dated: (at: string) => number } => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  const { hash } = seat(root, 'typescript_specialist')
  const log = (usage: Fired['usage'], model = 'm'): number => runLogged(db, { plan, step: 4, seat: 'typescript_specialist', rule_hash: hash,
    provider: 'claude-agent-sdk', model, effort: 'high', exit: 0, fired: { usage, seconds: 1, transcript_path: 'x.transcript.jsonl' } })
  const computed = (id: number): unknown =>
    (db.prepare('SELECT cost_computed_usd FROM runs WHERE id = ?').get(id) as { cost_computed_usd: number | null }).cost_computed_usd
  const dated = (at: string): number => {
    const id = runAt(db, plan, 4, 'typescript_specialist', at)
    db.prepare('UPDATE runs SET input_tokens = 21000, cache_write_tokens = 20000, cache_write_1h_tokens = 0, cache_read_tokens = 100000, output_tokens = 5000 WHERE id = ?').run(id)
    return id
  }
  return { db, log, computed, dated }
}

const usage = { input: 21000, write: 20000, write_1h: 0, cache: 100000, output: 5000, cost: 0.305 }

test('D1 Opus 5.5 runs 3367, 3530, 3531 price at 1-hour writes', () => {
  const { log, computed } = setup()
  const opus = (input: number, write: number, cache: number, output: number): unknown =>
    computed(log({ input, write, write_1h: write, cache, output }, 'claude-opus-5-5'))
  expect(opus(35266, 20089, 2139, 1234)).toBeCloseTo(0.2465278, 7)
  expect(opus(244508, 146841, 557024, 17100)).toBeCloseTo(2.0188008, 7)
  expect(opus(6197, 3698, 2139, 611)).toBeCloseTo(0.0522278, 7)
})

test('D2 run 3367 with 10000 of its writes at 5 minutes', () => {
  const { log, computed } = setup()
  const id = log({ input: 35266, write: 20089, write_1h: 10089, cache: 2139, output: 1234 }, 'claude-opus-5-5')
  expect(computed(id)).toBeCloseTo(0.2165278, 7)
})

test('D3 a negative 1-hour count or price fails its CHECK', () => {
  const { db, log } = setup()
  expect(() => log({ ...usage, write_1h: -1 })).toThrow(/CHECK constraint failed: cache_write_1h_tokens/)
  expect(() => price(db, 'm', '2026-01-01', 5, 'https://example.com/pricing', -1)).toThrow(/CHECK constraint failed: cache_write_1h/)
})

test('D4 a price row with no cache_write_1h leaves the cost NULL', () => {
  const { db, log, computed } = setup()
  price(db, 'm', '2026-01-01', 5, 'https://example.com/pricing', null)
  expect(computed(log(usage))).toBeNull()
})

test('D1 cost_computed_usd prices cache writes apart, within 1%', () => {
  const { db, log, computed } = setup()
  price(db, 'm', '2026-01-01')
  const cost = computed(log(usage)) as number
  expect(Math.abs(cost - usage.cost) / usage.cost).toBeLessThan(0.01)
})

test('D2 a run takes the row in force at runs.at, NULL before any', () => {
  const { db, computed, dated } = setup()
  price(db, 'm', '2026-01-01')
  price(db, 'm', '2026-06-01', 50)
  const march = dated('2026-03-01 00:00:00')
  const before = dated('2025-12-31 00:00:00')
  repriced(db)
  expect(computed(march)).toBeCloseTo(0.305, 9)
  expect(computed(before)).toBeNull()
})

test('D3 no price row or cache writes: cost_computed_usd is NULL', () => {
  const { db, log, computed } = setup()
  price(db, 'm', '2026-01-01')
  expect(computed(log(usage, 'unpriced'))).toBeNull()
  expect(computed(log({ input: 21000, cache: 100000, output: 5000, cost: 0.305 }))).toBeNull()
})

test('D4 repriced fills only NULL priced runs, lists no-cache ones', () => {
  const { db, log, computed, dated } = setup()
  const filled = log(usage)
  price(db, 'm', '2026-01-01')
  db.prepare('UPDATE runs SET cost_computed_usd = 9 WHERE id = ?').run(filled)
  const old = dated('2026-03-01 00:00:00')
  const unpriced = log(usage, 'unpriced')
  const noWrites = runAt(db, planRow(db), 4, 'typescript_specialist', '2026-03-01 00:00:00')
  expect(repriced(db)).toEqual({ priced: 1, missing: [noWrites] })
  expect(computed(old)).toBeCloseTo(0.305, 9)
  expect(computed(filled)).toBe(9)
  expect(computed(unpriced)).toBeNull()
  expect(computed(noWrites)).toBeNull()
  expect(repriced(db)).toEqual({ priced: 0, missing: [noWrites] })
})

test('D5 a negative price or non-https source_url fails its CHECK', () => {
  const { db } = setup()
  expect(() => price(db, 'm', '2026-01-01', -1)).toThrow(/CHECK constraint failed/)
  expect(() => price(db, 'm', '2026-01-01', 5, 'http://example.com')).toThrow(/CHECK constraint failed/)
})

test('runLogged: cache to cache_read_tokens, missing cost to NULL', () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  const { hash } = seat(root, 'typescript_specialist')
  const row = (usage: Fired['usage']): unknown => {
    const id = runLogged(db, { plan, step: 4, seat: 'typescript_specialist', rule_hash: hash, provider: 'claude-agent-sdk',
      model: 'm', effort: 'high', exit: 1, fired: { usage, seconds: 7, transcript_path: 'x.transcript.jsonl' } })
    return db.prepare(`SELECT plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_read_tokens, output_tokens,
      seconds, exit, transcript_path, cost_usd FROM runs WHERE id = ?`).get(id)
  }
  const written = {
    plan, step: 4, seat: 'typescript_specialist', rule_hash: hash, provider: 'claude-agent-sdk', model: 'm', effort: 'high',
    input_tokens: 1, cache_read_tokens: 2, output_tokens: 3, seconds: 7, exit: 1, transcript_path: 'x.transcript.jsonl',
  }
  expect(row({ input: 1, cache: 2, output: 3, cost: 0.42 })).toEqual({ ...written, cost_usd: 0.42 })
  expect(row({ input: 1, cache: 2, output: 3 })).toEqual({ ...written, cost_usd: null })
})

test('D2 D3 cache_write_tokens: NULL if absent, negative refused', () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  const { hash } = seat(root, 'typescript_specialist')
  const log = (usage: Fired['usage']): number => runLogged(db, { plan, step: 4, seat: 'typescript_specialist', rule_hash: hash,
    provider: 'claude-agent-sdk', model: 'm', effort: 'high', exit: 0, fired: { usage, seconds: 1, transcript_path: 'x.transcript.jsonl' } })
  const writes = (id: number): unknown => db.prepare('SELECT cache_write_tokens FROM runs WHERE id = ?').get(id)
  expect(writes(log({ input: 1, cache: 2, output: 3 }))).toEqual({ cache_write_tokens: null })
  expect(writes(log({ input: 1, cache: 2, write: 4, output: 3 }))).toEqual({ cache_write_tokens: 4 })
  expect(writes(runAt(db, plan, 4, 'typescript_specialist', '2026-09-27 00:00:00'))).toEqual({ cache_write_tokens: null })
  expect(() => log({ input: 1, cache: 2, write: -1, output: 3 })).toThrow(/CHECK constraint failed: cache_write_tokens/)
})
