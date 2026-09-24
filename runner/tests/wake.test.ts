import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { drop, put, srcDir } from '../../sequencer/workspace.ts'
import { migrate, open } from '../../store/index.ts'
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
    .toEqual(['card', 'step', 'verdict', 'refusals', 'runs', 'queue', 'lanes', 'usage', 'base'])
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
