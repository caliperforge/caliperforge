import { expect, test } from 'vitest'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY, work } from './drifting.ts'

test('D4 each outside seat is silent until its first run', () => {
  for (const name of ['python_specialist', 'lua_specialist', 'rust_specialist']) {
    const entry = REGISTRY.filter((e) => e.name === name)
    const d = db()
    work(d, 3, 'main.lua')
    expect(drift(d, entry, NOW)).toEqual([{ name, state: 'silent', detail: `no row in runs WHERE seat = '${name}'` }])
    d.exec(`INSERT INTO rules (id, kind, path, content_hash, loaded_at) VALUES ('${name}', 'card', 'rules/roster.yaml', '${'0'.repeat(64)}', '2026-09-22');
      INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort,
      input_tokens, cache_read_tokens, output_tokens, seconds, exit, at, mode, transcript_path)
      VALUES (1, 2, '${name}', '${'0'.repeat(64)}', 'claude-agent-sdk', 'm', 'high', 0, 0, 0, 0, 0, '2026-10-02 10:00:00', 'build', 'x.transcript.jsonl')`)
    expect(drift(d, entry, NOW)).toEqual([])
  }
})
