import { expect, test } from 'vitest'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY } from './drifting.ts'

test('D4 fix_mode is silent without a fix run, stale after 7d', () => {
  const fix = REGISTRY.filter((e) => e.name === 'fix_mode')
  const d = db()
  const hash = '0'.repeat(64)
  const ran = (at: string, mode: string): void => {
    d.exec(`INSERT OR IGNORE INTO rules (id, kind, path, content_hash, loaded_at)
      VALUES ('typescript_specialist', 'card', 'rules/roster.yaml', '${hash}', '2026-09-22');
      INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort,
      input_tokens, cache_read_tokens, output_tokens, seconds, exit, at, mode, transcript_path)
      VALUES (1, 2, 'typescript_specialist', '${hash}', 'claude-agent-sdk', 'm', 'high', 0, 0, 0, 0, 0, '${at}', '${mode}', 'x.transcript.jsonl')`)
  }
  const silent = [{ name: 'fix_mode', state: 'silent', detail: "no row in runs WHERE mode = 'fix'" }]
  expect(drift(d, fix, NOW)).toEqual(silent)
  ran('2026-10-02 10:00:00', 'build')
  expect(drift(d, fix, NOW)).toEqual(silent)
  ran('2026-09-25 10:00:00', 'fix')
  expect(drift(d, fix, NOW).map((r) => r.state)).toEqual(['stale'])
  ran('2026-10-02 10:00:00', 'fix')
  expect(drift(d, fix, NOW)).toEqual([])
})
