import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Read, Run } from '../../cli/gh.ts'
import { deliverablesOf, pushed } from '../../store/deliverables.ts'
import { logged, ofKind } from '../../store/events.ts'
import { migrate, open } from '../../store/index.ts'
import { planById } from '../../store/plans.ts'
import { landless } from '../landless.ts'
import { maybe, OPERATOR, put } from '../workspace.ts'

const repo = join(import.meta.dirname, '../..')
const SHA = 'a41bc25'.padEnd(40, '0')
const LANDED = `https://github.com/caliperforge/caliperforge/commit/${SHA}`
const ISSUE = 'https://github.com/caliperforge/caliperforge/issues/139'
const OLD = '# the title\n\nthe old body\n'
const PREMISE = 'the table holds class_name, not class'

function seeded(base: string | null = `${SHA}\n`) {
  const db = open(':memory:')
  migrate(db, join(repo, 'schema'))
  db.exec(readFileSync(join(repo, 'runner/tests/fixtures/waiting.sql'), 'utf8'))
  db.exec(`UPDATE plans SET state = 'done' WHERE id = 7;
    INSERT INTO approvals (id, subject_kind, subject_id, subject_digest, who, decision, reason, approved_at)
    VALUES (1, 'deliverable', 1, printf('%064d', 0), 'ceo', 'approved', NULL, '2026-10-03');
    INSERT INTO deliverables (plan_id, step, seat, diff_digest, state, tests_pass, byte_identical_elsewhere, fork_ci_green, bot_clean,
      target_warm, approval_id, evidence) VALUES (7, 2, 'typescript_specialist', printf('%064d', 0), 'pushed', 1, 1, 1, 1, 1, 1, '${LANDED}')`)
  const home = mkdtempSync(join(tmpdir(), 'cf-landless-'))
  put(home, 7, 'ask.md', OLD)
  put(home, 7, 'step-2.handback.md', `${PREMISE}\n\n---\ndone:\n  - id: D1\n    status: cannot-be-done\n---\n`)
  if (base !== null) put(home, 7, 'base.sha', base)
  const calls: string[][] = []
  const exec: Run = (args) => { calls.push(args); return '' }
  return { db, home, calls, exec }
}

const thread: Read = (args) => args.at(-1) === 'comments'
  ? { comments: [
    { author: { login: OPERATOR }, body: `landed on main as ${SHA}`, url: `${ISSUE}#issuecomment-41` },
    { author: { login: 'someone' }, body: `landed on main as ${SHA}`, url: `${ISSUE}#issuecomment-42` },
  ] }
  : { number: 139, title: 'the title', body: 'the old body', url: 'u', labels: [] }

function untouched(seed: ReturnType<typeof seeded>): void {
  expect(planById(seed.db, 7).state).toBe('done')
  expect(deliverablesOf(seed.db, 7)).toEqual([{ state: 'pushed', evidence: LANDED }])
  expect(maybe(seed.home, 7, 'ask.md')).toBe(OLD)
}

test('a plan landed at its own base sha is queued at step 1', () => {
  const seed = seeded()
  expect(landless(seed.db, seed.home, thread, seed.exec)).toHaveLength(1)
  expect(planById(seed.db, 7)).toMatchObject({ state: 'queued', step: 1 })
  expect(pushed(seed.db, 7)).toBe(false)
  expect(deliverablesOf(seed.db, 7)).toEqual([{ state: 'approved', evidence: LANDED }])
  expect(maybe(seed.home, 7, 'base.sha')).toBeNull()
  expect(maybe(seed.home, 7, 'ask.md')).toBe(`${OLD}\n## Answer from the premise\n\n${PREMISE}\n`)
  expect(seed.calls).toEqual([
    ['issue', 'reopen', '139', '--repo', 'caliperforge/caliperforge'],
    ['api', '-X', 'DELETE', 'repos/caliperforge/caliperforge/issues/comments/41'],
  ])
})

test('a plan landed elsewhere or with no base.sha is left alone', () => {
  for (const seed of [seeded(`${'b'.repeat(40)}\n`), seeded(null)]) {
    expect(landless(seed.db, seed.home, thread, seed.exec)).toEqual([])
    untouched(seed)
    expect(seed.calls).toEqual([])
  }
})

test('a plan mended by hand is left alone', () => {
  const seed = seeded()
  logged(seed.db, { plan: 7, kind: 'close', actor: 'tick', outcome: 'pass', message: `fixed by ${LANDED}`, pointer: LANDED, run: null })
  expect(landless(seed.db, seed.home, thread, seed.exec)).toEqual([])
  untouched(seed)
  expect(seed.calls).toEqual([])
})

test('a gh failure moves nothing and is logged', () => {
  const seed = seeded()
  const down: Run = () => { throw new Error('gh down') }
  expect(landless(seed.db, seed.home, thread, down)).toEqual([`${ISSUE}: gh down`])
  untouched(seed)
  expect(maybe(seed.home, 7, 'base.sha')).toBe(`${SHA}\n`)
  expect(ofKind(seed.db, 'swallowed')).toEqual([{ plan: 7, kind: 'swallowed', actor: 'halt', outcome: 'pass', message: 'gh down' }])
})
