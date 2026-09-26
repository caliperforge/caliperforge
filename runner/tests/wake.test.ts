import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { reviewerNotBuilder } from '../../checks/reviewer-not-builder.ts'
import { drop, put, srcDir } from '../../sequencer/workspace.ts'
import { migrate, open } from '../../store/index.ts'
import { overBudget } from '../../store/refusals.ts'
import { CAP, wake } from '../wake.ts'

const root = join(import.meta.dirname, '../..')
const SENTINEL = 'SENTINEL do not send'
const MESSAGE = 'the message under the fence'
const refusal = (path: string) => ({ refusal: { origin_kind: 'ruling', origin_ref: 'orchestrator.packet', path } })

function seeded(ask = 'the ask\n') {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  db.exec(readFileSync(join(import.meta.dirname, 'fixtures/waiting.sql'), 'utf8'))
  const home = mkdtempSync(join(tmpdir(), 'cf-wake-'))
  put(home, 7, 'ask.md', ask)
  put(home, 7, 'step-4.verdict.md', `---\noutcome: refuse\nspans:\n  - runner/wake.ts\n---\n\n${MESSAGE}\n`)
  put(home, 7, 'base.sha', `${'a'.repeat(40)}\n`)
  put(home, 7, 'step-2.transcript.jsonl', `${SENTINEL}\n`)
  writeFileSync(join(srcDir(home, 7), 'index.ts'), `${SENTINEL}\n`)
  return { db, home }
}

test('D1 a waiting plan wakes with every section in order and no file content', () => {
  const { db, home } = seeded()
  const { text } = wake(db, home, 7) as { text: string }
  expect([...text.matchAll(/^# (\w+)$/gm)].map((m) => m[1]))
    .toEqual(['card', 'step', 'verdict', 'stop', 'refusals', 'runs', 'queue', 'lanes', 'usage', 'base'])
  expect(text).toContain('spans:\n  - runner/wake.ts\n---')
  expect(text).not.toContain(SENTINEL)
  expect(text).not.toContain(MESSAGE)
})

test('D2 a missing section refuses rather than sending a short packet', () => {
  const { db, home } = seeded()
  drop(home, 7, 'base.sha')
  expect(wake(db, home, 7)).toEqual(refusal('base'))
  db.exec('UPDATE plans SET wait_reason = NULL WHERE id = 7')
  expect(wake(db, home, 7)).toEqual(refusal('card'))
})

test('D3 an ask past the cap is refused whole, not cut', () => {
  const { db, home } = seeded('x'.repeat(CAP * 4 + 1))
  expect(wake(db, home, 7)).toEqual(refusal('cap'))
})

test('#284b: fixer and orchestrator runs land at steps 4 and 5 and leave the ceiling and the packet alone', () => {
  const { db, home } = seeded()
  const before = [wake(db, home, 7), overBudget(db, 7)]
  for (const seat of ['fixer', 'orchestrator']) {
    db.prepare(`INSERT OR IGNORE INTO rules (id, kind, path, content_hash, loaded_at)
      VALUES (?, 'card', 'rules/roster.yaml', ?, '2026-09-22T00:00:00.000Z')`).run(seat, '0'.repeat(64))
    for (const step of [4, 5]) {
      db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort,
        input_tokens, cache_tokens, output_tokens, seconds, exit, transcript_path)
        VALUES (7, ?, ?, ?, 'claude-agent-sdk', 'm', 'high', 7000000, 0, 0, 0, 0, 'x.transcript.jsonl')`)
        .run(step, seat, '0'.repeat(64))
    }
  }
  expect([wake(db, home, 7), overBudget(db, 7)]).toEqual(before)
})

test('#284b: a seat other than fixer or orchestrator is still refused at steps 4 and 5', async () => {
  expect(await reviewerNotBuilder.run(root)).toEqual([])
})
