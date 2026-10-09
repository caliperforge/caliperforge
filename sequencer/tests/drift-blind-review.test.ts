import { expect, test } from 'vitest'
import type { Db } from '../../store/index.ts'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY } from './drifting.ts'

const ENTRY = REGISTRY.filter((e) => e.name === 'blind_review')

function plan(outside: boolean): Db {
  const d = db()
  for (const seat of ['senior_review', 'blind_review']) {
    d.exec(`INSERT INTO rules (id, kind, path, content_hash, loaded_at) VALUES ('${seat}', 'card', 'rules/roster.yaml', '${'0'.repeat(64)}', '2026-09-22')`)
  }
  if (!outside) return d
  d.exec(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge, open_pr_age_p50_days,
    cross_repo_activity, pulse, evidence) VALUES (1, 'acme/kit', '2026-09-24', 2, 1, '2026-09-24', 3, 4, 'warm', 'https://github.com/acme/kit');
    INSERT INTO targets (id, account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (1, 1, 'acme/kit', 706, 'm', 'ready', '2026-09-24', 'https://github.com/acme/kit/issues/706');
    UPDATE plans SET target_id = 1, lane = NULL, seat = NULL, origin = NULL WHERE id = 1`)
  return d
}

function run(d: Db, seat: string, mode: string, at: string): void {
  d.exec(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort,
    input_tokens, cache_read_tokens, output_tokens, seconds, exit, at, mode, transcript_path)
    VALUES (1, 5, '${seat}', '${'0'.repeat(64)}', 'claude-agent-sdk', 'm', 'high', 0, 0, 0, 0, 0, '${at}', '${mode}', 'x.transcript.jsonl')`)
}

test('D2 outside step 5 with no blind_review run is silent', () => {
  const d = plan(true)
  run(d, 'senior_review', 'review', '2026-10-02 10:00:00')
  expect(drift(d, ENTRY, NOW)).toEqual([{ name: 'blind_review', state: 'silent', detail: "no row in runs WHERE seat = 'blind_review' AND mode = 'review'" }])
})

test('D3 a blind_review run 8 days old is stale', () => {
  const d = plan(true)
  run(d, 'senior_review', 'review', '2026-10-02 10:00:00')
  run(d, 'blind_review', 'review', '2026-09-25 10:00:00')
  expect(drift(d, ENTRY, NOW).map((r) => r.state)).toEqual(['stale'])
})

test('D4 internal or old step-5 runs do not fire', () => {
  const internal = plan(false)
  run(internal, 'senior_review', 'review', '2026-10-02 10:00:00')
  expect(drift(internal, ENTRY, NOW)).toEqual([])
  const old = plan(true)
  run(old, 'senior_review', 'review', '2026-09-20 10:00:00')
  expect(drift(old, ENTRY, NOW)).toEqual([])
})

test('D5 a recent blind_review run is quiet', () => {
  const d = plan(true)
  run(d, 'senior_review', 'review', '2026-10-02 10:00:00')
  run(d, 'blind_review', 'review', '2026-10-02 11:00:00')
  expect(drift(d, ENTRY, NOW)).toEqual([])
})
