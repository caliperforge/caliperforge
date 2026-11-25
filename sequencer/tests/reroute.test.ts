import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { migrate, open } from '../../store/index.ts'
import { pipeNamed, planById } from '../../store/plans.ts'
import { question } from '../../templates/research.ts'
import { rerouted } from '../reroute.ts'
import { maybe, put, srcDir } from '../workspace.ts'

const repo = join(import.meta.dirname, '../..')
const ASK = 'the ask\n'
const ISSUE = '# Issue\n\nthe brief\n'
const REFUSAL = 'step 3 rails refused\n'
const ANSWER = `**Question:** how long does a tick take?
**Would be wrong if:** a tick logs no time
**Done when:** the time is measured
**Measure:** time one tick`

function built() {
  const db = open(':memory:')
  migrate(db, join(repo, 'schema'))
  db.exec(readFileSync(join(repo, 'runner/tests/fixtures/waiting.sql'), 'utf8'))
  db.exec("UPDATE plans SET state = 'blocked_on_ceo', wait_reason = NULL WHERE id = 7")
  const home = mkdtempSync(join(tmpdir(), 'cf-reroute-'))
  put(home, 7, 'ask.md', ASK)
  put(home, 7, 'issue.md', ISSUE)
  put(home, 7, 'refusal.md', REFUSAL)
  return { db, home }
}

test('an empty-diff build moves to the research lane', () => {
  const { db, home } = built()
  expect(rerouted(db, home, planById(db, 7), ANSWER)).toBe(true)
  expect(planById(db, 7)).toMatchObject({ template: 'research', lane: 'research', pipe_id: pipeNamed(db, 'research')?.id, step: 0 })
  expect(maybe(home, 7, 'ask.md')).toBe(`${ASK}\n## Answer from the director (${new Date().toISOString().slice(0, 10)})\n\n${ANSWER}\n`)
  expect(maybe(home, 7, 'ask.md')).toContain('**Measure:**')
  expect(['refusal.md', 'issue.md', 'refusal.prev.md', 'issue.prev.md'].map((name) => maybe(home, 7, name))).toEqual([null, null, REFUSAL, ISSUE])
  expect(question(home, planById(db, 7)).outcome).toBe('pass')
})

test('a build with a diff is not moved to research', () => {
  const { db, home } = built()
  writeFileSync(join(srcDir(home, 7), 'a.ts'), 'export const a = 1\n')
  const before = planById(db, 7)
  expect(rerouted(db, home, before, ANSWER)).toBe(false)
  expect(planById(db, 7)).toEqual(before)
  expect([maybe(home, 7, 'ask.md'), maybe(home, 7, 'issue.md')]).toEqual([ASK, ISSUE])
})
