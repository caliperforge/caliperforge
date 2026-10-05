import { expect, test } from 'vitest'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY, work } from './drifting.ts'

test('D2 go_specialist is silent until a build run, at any age', () => {
  const go = REGISTRY.filter((e) => e.name === 'go_specialist')
  const d = db()
  const hash = '0'.repeat(64)
  const ran = (mode: string): void => {
    d.exec(`INSERT OR IGNORE INTO rules (id, kind, path, content_hash, loaded_at)
      VALUES ('go_specialist', 'card', 'rules/roster.yaml', '${hash}', '2026-09-24');
      INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort,
      input_tokens, cache_read_tokens, output_tokens, seconds, exit, at, mode, transcript_path)
      VALUES (1, 2, 'go_specialist', '${hash}', 'claude-agent-sdk', 'm', 'high', 0, 0, 0, 0, 0, '2026-01-01 10:00:00', '${mode}', 'x.transcript.jsonl')`)
  }
  const silent = [{ name: 'go_specialist', state: 'silent', detail: "no row in runs WHERE seat = 'go_specialist' AND mode = 'build'" }]
  work(d, 3, 'main.go')
  expect(drift(d, go, NOW)).toEqual(silent)
  ran('fix')
  expect(drift(d, go, NOW)).toEqual(silent)
  ran('build')
  expect(drift(d, go, NOW)).toEqual([])
})
