import { expect, test } from 'vitest'
import { runAt } from '../../store/events.ts'
import { building, record, sharing } from '../../store/files.ts'
import { addRule } from '../../store/index.ts'
import { amend } from '../../store/lanes.ts'
import { builderRan, putPlan } from '../../store/plans.ts'
import { record as signal } from '../../store/signals.ts'
import { narrow } from '../rails.ts'
import { unanswered } from '../ready.ts'
import { plan, world } from './world.ts'

const HASH = '0'.repeat(64)
const PATH = 'src/hello.ts'

test('#284: a fixer or orchestrator run is never read as a build', () => {
  const { db } = world()
  for (const seat of ['fixer', 'orchestrator']) {
    addRule(db, { id: seat, kind: 'card', path: 'rules/roster.yaml', content_hash: HASH, loaded_at: '2026-09-22T00:00:00.000Z' })
  }
  putPlan(db, { id: 2, pipe_id: 1, target_id: 1, template: 'pr_path', state: 'queued', queued_at: new Date().toISOString(), step: 2, retries: 0 })
  amend(db, 1, { step: 2 })
  for (const id of [1, 2]) record(db, id, [{ path: PATH, is_new: false }])
  signal(db, { repo: 'acme/widget', pr: 7, kind: 'bot_review', author: 'greptile[bot]', at: new Date().toISOString(), external_id: 'low', score: 1, plan: 1 })
  const reads = (): unknown[] =>
    [builderRan(db, 1), narrow(db, plan(db, 1)), unanswered(db, 1), sharing(db, 1), building(db, 2, [PATH])]
  const before = reads()
  for (const id of [1, 2]) {
    for (const seat of ['fixer', 'orchestrator']) runAt(db, id, 2, seat, '2999-01-01 00:00:00')
  }
  expect(reads()).toEqual(before)
})
