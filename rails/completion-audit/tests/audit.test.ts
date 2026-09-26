import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import { planRow } from '../../../runner/index.ts'
import { load } from '../../../runner/rules.ts'
import { audit, record } from '../index.ts'

const root = join(import.meta.dirname, '../../..')

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, name), 'utf8')
}

test('passes when every expected done-condition carries a pointer', () => {
  const verdict = audit(fixture('handback-carried.md'), ['D1', 'D2'])
  expect(verdict.outcome).toBe('pass')
  expect(verdict.spans).toEqual([])
})

test('refuses an expected done-condition the handback does not carry', () => {
  const verdict = audit(fixture('handback-unpointed.md'), ['D1', 'D2', 'D3'])
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.spans).toEqual(['D2', 'D3'])
  expect(verdict.origin_kind).toBe('rail')
  expect(verdict.origin_ref).toBe('completion-audit')
})

const touching = (path: string): string => `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,2 @@\n x\n+y\n`

test('a one-line rebuild carries forward the rows its diff never touched', () => {
  const verdict = audit(fixture('handback-rebuilt.md'), ['D1', 'D2', 'D3', 'D4', 'D5'],
    fixture('handback-five.md'), touching('src/hello.ts'))
  expect(verdict.outcome).toBe('pass')
  expect(verdict.spans).toEqual([])
  expect(verdict.message).toContain('D2, D3, D4, D5')
})

test('refuses an id neither the rebuild nor the previous handback carries', () => {
  const verdict = audit(fixture('handback-rebuilt.md'), ['D1', 'D2', 'D6'],
    fixture('handback-five.md'), touching('src/hello.ts'))
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.spans).toEqual(['D6'])
})

test('refuses an absent id whose previous pointer names a file the rebuild touched', () => {
  const verdict = audit(fixture('handback-rebuilt.md'), ['D1', 'D2'],
    fixture('handback-five.md'), touching('src/greet.ts'))
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.spans).toEqual(['D2'])
})

test('refuses every expected done-condition when the handback carries no fence', () => {
  const verdict = audit('Not logged in \u00b7 Please run /login', ['D1'])
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.spans).toEqual(['D1'])
})

test('reads the rows past a summary YAML cannot parse', () => {
  expect(audit(fixture('handback-colon.md'), ['D1', 'D2']).outcome).toBe('pass')
})

test('writes a verdicts row the store accepts', () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  const id = record(db, plan, audit(fixture('handback-unpointed.md'), ['D1', 'D2']), 0.01)
  const row = db.prepare('SELECT gate, kind, outcome, rail_id, origin_kind, origin_ref, tokens FROM verdicts WHERE id = ?').get(id)
  expect(row).toEqual({ gate: 'pre_review', kind: 'rail', outcome: 'refuse', rail_id: 'completion-audit', origin_kind: 'rail', origin_ref: 'completion-audit', tokens: 0 })
})

test('refuses rather than throws on a fence that is not a done envelope', () => {
  const fences = ['---\nstatus: partial\ndone: []\n---\n', '---\ndone:\n  - status: done\n---\n']
  for (const fence of fences) {
    const verdict = audit(fence, ['D1'])
    expect(verdict.outcome).toBe('refuse')
    expect(verdict.spans).toEqual(['D1'])
  }
})

test('refuses on the parse error when no rows can be read from the fence', () => {
  for (const fence of [fixture('handback-unparsed.md'), '---\n: : :\n---\n']) {
    const verdict = audit(fence, ['D1', 'D2'])
    expect(verdict.outcome).toBe('refuse')
    expect(verdict.spans).toEqual(['step-2.handback.md'])
    expect(verdict.message).toContain('not YAML')
  }
})

test('a previous handback YAML cannot parse carries nothing and refuses nothing', () => {
  expect(audit(fixture('handback-carried.md'), ['D1', 'D2'], fixture('handback-unparsed.md'), '').outcome).toBe('pass')
})
