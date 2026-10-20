import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { reviewerNotBuilder } from '../../checks/reviewer-not-builder.ts'
import { drop, put, srcDir } from '../../sequencer/workspace.ts'
import { addRun } from '../../store/brief.ts'
import { addRule, migrate, open } from '../../store/index.ts'
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

test('D1 wakes with every section in order and no file content', () => {
  const { db, home } = seeded()
  const { text } = wake(db, home, 7) as { text: string }
  expect([...text.matchAll(/^# (\w+)$/gm)].map((m) => m[1]))
    .toEqual(['card', 'step', 'verdict', 'stop', 'refusals', 'runs', 'queue', 'lanes', 'usage', 'base'])
  expect(text).toContain('waits_on: null')
  expect(text).toContain('# verdict\n\nreview 4 review refuse ruling reviewers.verdict\n')
  expect(text).toContain('# runs\n\n3 typescript_specialist 3400\n2 typescript_specialist 1200\n')
  expect(text).toContain('# queue\n\n7 4 1 token_ceiling\n')
  expect(text).toContain('spans:\n  - runner/wake.ts\n---')
  expect(text).not.toContain(SENTINEL)
  expect(text).not.toContain(MESSAGE)
})

test('D2 a missing section refuses rather than a short packet', () => {
  const { db, home } = seeded()
  drop(home, 7, 'base.sha')
  expect(wake(db, home, 7)).toEqual(refusal('base'))
  db.exec('UPDATE plans SET wait_reason = NULL WHERE id = 7')
  expect(wake(db, home, 7)).toEqual(refusal('card'))
})

test('a plan with no row throws rather than waking', () => {
  const { db, home } = seeded()
  expect(() => wake(db, home, 99)).toThrow('no plan 99')
})

test('D3 an ask past the cap is refused whole, not cut', () => {
  const { db, home } = seeded('x'.repeat(CAP * 4 + 1))
  expect(wake(db, home, 7)).toEqual(refusal('cap'))
})

test('fixer and orchestrator runs leave ceiling and packet alone', () => {
  const { db, home } = seeded()
  const before = [wake(db, home, 7), overBudget(db, 7)]
  for (const seat of ['fixer', 'orchestrator']) {
    addRule(db, { id: seat, kind: 'card', path: 'rules/roster.yaml', content_hash: '0'.repeat(64), loaded_at: '2026-09-22T00:00:00.000Z' })
    for (const step of [4, 5]) {
      addRun(db, { plan: 7, step, seat, rule_hash: '0'.repeat(64), provider: 'claude-agent-sdk', model: 'm', effort: 'high',
        input_tokens: 7000000, cache_write_tokens: null, cache_write_1h_tokens: null, cache_read_tokens: 0, output_tokens: 0,
        seconds: 0, exit: 0, at: new Date().toISOString(), transcript_path: 'x.transcript.jsonl', cost_usd: null })
    }
  }
  expect([wake(db, home, 7), overBudget(db, 7)]).toEqual(before)
})

test('another seat is still refused at steps 4 and 5', async () => {
  expect(await reviewerNotBuilder.run(root)).toEqual([])
})
