import { expect, test } from 'vitest'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY } from './drifting.ts'

test('D6 writer_log is silent until a log run, comms on', () => {
  const log = REGISTRY.filter((e) => e.name === 'writer_log')
  const d = db()
  const hash = '0'.repeat(64)
  const ran = (mode: string): void => {
    d.exec(`INSERT OR IGNORE INTO rules (id, kind, path, content_hash, loaded_at)
      VALUES ('writer', 'card', 'rules/roster.yaml', '${hash}', '2026-09-22');
      INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort,
      input_tokens, cache_read_tokens, output_tokens, seconds, exit, at, mode, transcript_path)
      VALUES (1, 1, 'writer', '${hash}', 'claude-agent-sdk', 'm', 'high', 0, 0, 0, 0, 0, '2026-10-02 10:00:00', '${mode}', 'x.transcript.jsonl')`)
  }
  const silent = [{ name: 'writer_log', state: 'silent', detail: "no row in runs WHERE seat = 'writer' AND mode = 'log'" }]
  expect(drift(d, log, NOW)).toEqual(silent)
  ran('ship')
  expect(drift(d, log, NOW)).toEqual(silent)
  ran('log')
  expect(drift(d, log, NOW)).toEqual([])
})
