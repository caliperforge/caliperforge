import { expect, test } from 'vitest'
import type { Db } from '../../store/index.ts'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY, work } from './drifting.ts'

const go = REGISTRY.filter((e) => e.name === 'go_review')
const SILENT = [{ name: 'go_review', state: 'silent', detail: "no row in runs WHERE staffed = 'go_specialist' AND mode = 'review'" }]

function seats(): Db {
  const d = db()
  for (const seat of ['code_quality', 'go_specialist']) {
    d.exec(`INSERT INTO rules (id, kind, path, content_hash, loaded_at) VALUES ('${seat}', 'card', 'rules/roster.yaml', '${'0'.repeat(64)}', '2026-09-22')`)
  }
  return d
}

function run(d: Db, seat: string, staffed: string | null, at: string, mode = 'review'): void {
  d.exec(`INSERT INTO runs (plan, step, seat, staffed, rule_hash, provider, model, effort,
    input_tokens, cache_read_tokens, output_tokens, seconds, exit, at, mode, transcript_path)
    VALUES (1, 5, '${seat}', ${staffed === null ? 'NULL' : `'${staffed}'`}, '${'0'.repeat(64)}', 'claude-agent-sdk', 'm', 'high', 0, 0, 0, 0, 0, '${at}', '${mode}', 'x.transcript.jsonl')`)
}

test('silentNeedsWork', () => {
  const d = seats()
  expect(drift(d, go, NOW)).toEqual([])
  work(d, 5, 'main.go')
  expect(drift(d, go, NOW)).toEqual([])
  run(d, 'go_specialist', null, '2026-10-02 10:00:00')
  expect(drift(d, go, NOW)).toEqual(SILENT)
})

test('D2 an old go review with a fix run in the gap is quiet', () => {
  const d = seats()
  work(d, 5, 'main.go')
  run(d, 'code_quality', 'go_specialist', '2026-09-20 10:00:00')
  run(d, 'code_quality', null, '2026-10-02 10:00:00', 'fix')
  expect(drift(d, go, NOW)).toEqual([])
})

test('D2 a staffed review past 7d is stale, a recent one quiet', () => {
  const stale = seats()
  work(stale, 5, 'main.go')
  run(stale, 'go_specialist', null, '2026-10-02 10:00:00')
  run(stale, 'code_quality', 'go_specialist', '2026-09-25 10:00:00')
  expect(drift(stale, go, NOW)).toEqual([{
    name: 'go_review', state: 'stale', detail: 'newest runs.at is 2026-09-25 10:00:00, older than 7d', newest: '2026-09-25 10:00:00',
  }])
  const recent = seats()
  work(recent, 5, 'main.go')
  run(recent, 'code_quality', 'go_specialist', '2026-10-02 10:00:00')
  expect(drift(recent, go, NOW)).toEqual([])
})

test('D3 an unstaffed go_specialist review does not count', () => {
  const d = seats()
  work(d, 5, 'main.go')
  run(d, 'go_specialist', null, '2026-10-02 10:00:00')
  expect(drift(d, go, NOW)).toEqual(SILENT)
})

test('D4 done, step 4 or no .go plan raises nothing', () => {
  const done = seats()
  work(done, 5, 'main.go')
  done.exec("UPDATE plans SET state = 'done' WHERE id = 1")
  run(done, 'code_quality', 'go_specialist', '2026-09-20 10:00:00')
  expect(drift(done, go, NOW)).toEqual([])
  const early = db()
  work(early, 4, 'main.go')
  expect(drift(early, go, NOW)).toEqual([])
  const none = db()
  work(none, 5, 'main.ts')
  expect(drift(none, go, NOW)).toEqual([])
})

test('D5 a done plan with a recent run still turns the check on', () => {
  const d = seats()
  work(d, 5, 'main.go')
  d.exec("UPDATE plans SET state = 'done' WHERE id = 1")
  run(d, 'go_specialist', null, '2026-10-02 10:00:00')
  expect(drift(d, go, NOW)).toEqual(SILENT)
})
