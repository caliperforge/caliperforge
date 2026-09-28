import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../checks/sqlite.ts'
import type { Fired } from '../providers/kind.ts'
import { planRow } from '../runner/index.ts'
import { load, seat } from '../runner/rules.ts'
import { repriced, runAt, runLogged } from './events.ts'
import type { Db } from './index.ts'

const root = join(import.meta.dirname, '..')

const price = (db: Db, model: string, from: string, input = 5, url = 'https://example.com/pricing'): unknown =>
  db.prepare(`INSERT INTO prices (provider, model, input, cache_read, cache_write, output, effective_from, source_url)
    VALUES ('claude-agent-sdk', ?, ?, 0.5, 6.25, 25, ?, ?)`).run(model, input, from, url)

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
    db.prepare('UPDATE runs SET input_tokens = 21000, cache_write_tokens = 20000, cache_read_tokens = 100000, output_tokens = 5000 WHERE id = ?').run(id)
    return id
  }
  return { db, log, computed, dated }
}

const usage = { input: 21000, write: 20000, cache: 100000, output: 5000, cost: 0.305 }

test('D1: cost_computed_usd prices uncached input apart from cache writes and lands within 1% of cost_usd', () => {
  const { db, log, computed } = setup()
  price(db, 'm', '2026-01-01')
  const cost = computed(log(usage)) as number
  expect(Math.abs(cost - usage.cost) / usage.cost).toBeLessThan(0.01)
})

test('D2: a run is priced from the latest row in force at runs.at, and NULL before the first', () => {
  const { db, computed, dated } = setup()
  price(db, 'm', '2026-01-01')
  price(db, 'm', '2026-06-01', 50)
  const march = dated('2026-03-01 00:00:00')
  const before = dated('2025-12-31 00:00:00')
  repriced(db)
  expect(computed(march)).toBeCloseTo(0.305, 9)
  expect(computed(before)).toBeNull()
})

test('D3: no price row, or no cache writes, leaves cost_computed_usd NULL', () => {
  const { db, log, computed } = setup()
  price(db, 'm', '2026-01-01')
  expect(computed(log(usage, 'unpriced'))).toBeNull()
  expect(computed(log({ input: 21000, cache: 100000, output: 5000, cost: 0.305 }))).toBeNull()
})

test('D4: repriced fills NULL priced runs, skips filled and unpriced ones, and lists runs missing cache writes', () => {
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

test('D5: a negative price or a source_url that is not https fails its CHECK', () => {
  const { db } = setup()
  expect(() => price(db, 'm', '2026-01-01', -1)).toThrow(/CHECK constraint failed/)
  expect(() => price(db, 'm', '2026-01-01', 5, 'http://example.com')).toThrow(/CHECK constraint failed/)
})

test('runLogged writes every column as given, cache into cache_read_tokens, and NULL for a missing cost', () => {
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

test('D2 D3: runLogged writes cache_write_tokens, NULL when absent, and refuses a negative one', () => {
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
