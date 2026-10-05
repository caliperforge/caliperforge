import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'
import { addPlan, builderRan } from './plans.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('D1-D4 coo_lite and director build nothing; no self-review', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  for (const seat of ['coo_lite', 'director', 'typescript_specialist']) {
    db.prepare("INSERT INTO rules VALUES (?, 'card', 'rules/seats.yaml', ?, '2026-09-27')").run(seat, 'a'.repeat(64))
  }
  const plan = addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-09-27T00:00:00.000Z',
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/caliperforge/issues/1', step: 0 })
  const run = (step: number, seat: string): unknown => db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_read_tokens, output_tokens, seconds, exit, transcript_path)
    VALUES (?, ?, ?, ?, 'anthropic-api', 'm', 'low', 0, 0, 0, 0, 0, 'x.transcript.jsonl')`).run(plan, step, seat, '0'.repeat(64))
  for (const step of [2, 4, 5]) for (const seat of ['coo_lite', 'director']) run(step, seat)
  expect(builderRan(db, plan)).toBe(false)
  run(2, 'typescript_specialist')
  expect(() => run(4, 'typescript_specialist')).toThrow(/reviewer != builder/)
})
