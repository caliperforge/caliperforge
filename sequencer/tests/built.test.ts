import { expect, test } from 'vitest'
import { building, record, sharing } from '../../store/files.ts'
import { builderRan } from '../../store/plans.ts'
import { narrow } from '../rails.ts'
import { unanswered } from '../steps.ts'
import { plan, world } from './world.ts'

const HASH = '0'.repeat(64)
const PATH = 'src/hello.ts'

test('#284: a fixer or orchestrator run is never read as a build', () => {
  const { db } = world()
  for (const seat of ['fixer', 'orchestrator']) {
    db.prepare(`INSERT OR IGNORE INTO rules (id, kind, path, content_hash, loaded_at)
      VALUES (?, 'card', 'rules/roster.yaml', ?, '2026-09-22T00:00:00.000Z')`).run(seat, HASH)
  }
  db.prepare("INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at, step, retries) VALUES (2, 1, 1, 'pr_path', 'queued', ?, 2, 0)")
    .run(new Date().toISOString())
  db.prepare('UPDATE plans SET step = 2 WHERE id = 1').run()
  for (const id of [1, 2]) record(db, id, [{ path: PATH, is_new: false }])
  db.prepare(`INSERT INTO signals (repo, pr, kind, author, at, external_id, score, plan)
    VALUES ('acme/widget', 7, 'bot_review', 'greptile[bot]', ?, 'low', 1, 1)`).run(new Date().toISOString())
  const reads = (): unknown[] =>
    [builderRan(db, 1), narrow(db, plan(db, 1)), unanswered(db, 1), sharing(db, 1), building(db, 2, [PATH])]
  const before = reads()
  for (const id of [1, 2]) {
    for (const seat of ['fixer', 'orchestrator']) {
      db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort,
        input_tokens, cache_tokens, output_tokens, seconds, exit, at, transcript_path)
        VALUES (?, 2, ?, ?, 'claude-agent-sdk', 'm', 'high', 0, 0, 0, 0, 0, '2999-01-01 00:00:00', 'x.transcript.jsonl')`)
        .run(id, seat, HASH)
    }
  }
  expect(reads()).toEqual(before)
})
