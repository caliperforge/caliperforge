import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'
import { addPlan } from './plans.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('D1-D3 0084 refuses a review run in the build session', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  db.prepare("INSERT INTO rules VALUES ('swift_specialist', 'card', 'rules/seats.yaml', ?, '2026-10-04')").run('a'.repeat(64))
  const plan = addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-10-04T00:00:00.000Z',
    lane: 'machine', seat: 'swift_specialist', origin: 'https://github.com/caliperforge/caliperforge/issues/1', step: 0 })
  const run = (step: number, mode: string | null, session: string | null): number => Number(db.prepare(`INSERT INTO runs (plan, step, seat,
    rule_hash, provider, model, effort, input_tokens, cache_read_tokens, output_tokens, seconds, exit, transcript_path, mode, session)
    VALUES (?, ?, 'swift_specialist', ?, 'anthropic-api', 'm', 'low', 0, 0, 0, 0, 0, 'x.transcript.jsonl', ?, ?)`)
    .run(plan, step, '0'.repeat(64), mode, session).lastInsertRowid)
  expect(() => run(2, 'nope', 's')).toThrow(/CHECK constraint failed/)
  run(2, null, 's')
  run(2, null, null)
  expect(() => run(4, 'review', 's')).toThrow(/reviewer != builder/)
  const other = run(4, 'review', 't')
  run(4, 'review', null)
  expect(() => db.prepare("UPDATE runs SET session = 's' WHERE id = ?").run(other)).toThrow(/reviewer != builder/)
})
