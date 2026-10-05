import { expect, test } from 'vitest'
import { drift } from '../drift.ts'
import { internal, NOW, queue, REGISTRY } from './drifting.ts'

test('D3 typescript_specialist: silent without a run, stale at 2d', () => {
  const ts = REGISTRY.filter((e) => e.name === 'typescript_specialist')
  const d = internal()
  queue(d, 3)
  const hash = '0'.repeat(64)
  const ran = (at: string): void => {
    d.exec(`INSERT OR IGNORE INTO rules (id, kind, path, content_hash, loaded_at)
      VALUES ('typescript_specialist', 'card', 'rules/roster.yaml', '${hash}', '2026-09-22');
      INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort,
      input_tokens, cache_read_tokens, output_tokens, seconds, exit, at, transcript_path)
      VALUES (1, 2, 'typescript_specialist', '${hash}', 'claude-agent-sdk', 'm', 'high', 0, 0, 0, 0, 0, '${at}', 'x.transcript.jsonl')`)
  }
  expect(drift(internal(0), ts, NOW)).toEqual([])
  expect(drift(d, ts, NOW)).toEqual([{ name: 'typescript_specialist', state: 'silent', detail: "no row in runs WHERE seat = 'typescript_specialist'" }])
  ran('2026-09-30 10:00:00')
  expect(drift(d, ts, NOW).map((r) => r.state)).toEqual(['stale'])
  ran('2026-10-02 10:00:00')
  expect(drift(d, ts, NOW)).toEqual([])
})
