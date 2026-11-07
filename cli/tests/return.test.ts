import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { expect, test } from 'vitest'
import { drop, maybe, OPERATOR, put } from '../../sequencer/workspace.ts'
import { ofKind } from '../../store/events.ts'
import { migrate, open } from '../../store/index.ts'
import { planById } from '../../store/plans.ts'
import { registerReturn } from '../cf-return.ts'
import type { Read } from '../gh.ts'

const repo = join(import.meta.dirname, '../..')
const OLD = '# the title\n\nthe old body\n'
const NEW = '# the title\n\nthe new body\n'
const DIRECTOR = '## Answer from the director (2026-10-01)\n\nuse a.ts\n'
const LATE = '## Answer from the coo (2026-10-02)\n\nkeep b.ts\n'
const REFRESH = { plan: 7, kind: 'refresh', actor: 'coo', outcome: 'pass',
  message: 'caliperforge/caliperforge#139 changed: ask.md rewritten, issue.md dropped' }

function seeded(state = 'blocked_on_ceo') {
  const db = open(':memory:')
  migrate(db, join(repo, 'schema'))
  db.exec(readFileSync(join(repo, 'runner/tests/fixtures/waiting.sql'), 'utf8'))
  db.exec(`UPDATE plans SET state = '${state}' WHERE id = 7`)
  const home = mkdtempSync(join(tmpdir(), 'cf-return-'))
  put(home, 7, 'ask.md', OLD)
  put(home, 7, 'issue.md', '# the brief\n\n## Standing\n\n- none\n')
  put(home, 7, 'ask.briefed.md', OLD)
  return { db, home, calls: [] as string[][] }
}

const body = (text: string): Read => () => ({ number: 139, title: 'the title', body: text, url: 'u', labels: [] })
const never: Read = () => { throw new Error('read gh') }

function returned(seed: ReturnType<typeof seeded>, read: Read, ...args: string[]): void {
  const cf = new Command().exitOverride()
  registerReturn(cf.command('return').argument('<plan>').requiredOption('--by <actor>'),
    { root: seed.home, db: () => seed.db, out: () => undefined }, read, (args) => { seed.calls.push(args); return '' })
  cf.parse(['return', '7', '--by', 'coo', ...args], { from: 'user' })
}

test('D1 return --to 1 rewrites ask.md from the edited issue', () => {
  const seed = seeded()
  returned(seed, body('the new body'), '--to', '1')
  expect(maybe(seed.home, 7, 'ask.md')).toBe(NEW)
  expect(maybe(seed.home, 7, 'issue.md')).toBeNull()
  expect(maybe(seed.home, 7, 'ask.briefed.md')).toBeNull()
  expect(ofKind(seed.db, 'refresh')).toEqual([REFRESH])
})

test('D2 the refresh leaves rulings.md as it was', () => {
  const seed = seeded()
  put(seed.home, 7, 'rulings.md', 'accepted:\n  ids: g1\n')
  returned(seed, body('the new body'), '--to', '1')
  expect(maybe(seed.home, 7, 'rulings.md')).toBe('accepted:\n  ids: g1\n')
})

test('D3 answers and the Fork line follow the new body', () => {
  const seed = seeded()
  put(seed.home, 7, 'ask.md', `${OLD}\n${DIRECTOR}\nFork: x/y#3\n`)
  put(seed.home, 7, 'issue.md', `# the brief\n\n${LATE}\n## Standing\n\n- none\n`)
  returned(seed, body('the new body'), '--to', '1')
  expect(maybe(seed.home, 7, 'ask.md')).toBe(`${NEW}\n${DIRECTOR}\nFork: x/y#3\n\n${LATE}\n`)
})

test('D4 an unchanged issue writes nothing and logs no refresh', () => {
  const seed = seeded()
  returned(seed, body('the old body'), '--to', '1')
  expect(maybe(seed.home, 7, 'ask.md')).toBe(OLD)
  expect(maybe(seed.home, 7, 'issue.md')).toBe('# the brief\n\n## Standing\n\n- none\n')
  expect(ofKind(seed.db, 'refresh')).toEqual([])
})

test('D5 step 2, no origin or no ask.md reads nothing', () => {
  const at2 = seeded()
  returned(at2, never, '--to', '2')
  const bare = seeded()
  bare.db.exec("UPDATE plans SET template = 'research', origin = NULL, lane = NULL WHERE id = 7")
  returned(bare, never, '--to', '1')
  const asked = seeded()
  drop(asked.home, 7, 'ask.md')
  returned(asked, never, '--to', '1')
  for (const { db } of [at2, bare, asked]) expect(ofKind(db, 'refresh')).toEqual([])
})

test('D6 a refused return throws before any read', () => {
  const seed = seeded('running')
  expect(() => { returned(seed, never, '--to', '1') }).toThrow('is neither blocked on the ceo nor halted')
  expect(() => { returned(seeded(), never, '--to', '-1') }).toThrow('not -1')
  expect(maybe(seed.home, 7, 'ask.md')).toBe(OLD)
})

const PREMISE = 'the table holds class_name, not class'
const ISSUE = 'https://github.com/caliperforge/caliperforge/issues/139'

function premise(): ReturnType<typeof seeded> {
  const seed = seeded('done')
  put(seed.home, 7, 'step-2.handback.md', `${PREMISE}\n\n---\ndone:\n  - id: D1\n    status: cannot-be-done\n---\n`)
  return seed
}

const thread: Read = (args) => args.at(-1) === 'comments'
  ? { comments: [
    { author: { login: OPERATOR }, body: 'landed on main as abc', url: `${ISSUE}#issuecomment-41` },
    { author: { login: 'someone' }, body: 'landed on main as abc', url: `${ISSUE}#issuecomment-42` },
  ] }
  : body('the old body')(args)

test('an unlanded done plan returns at step 1 with its premise', () => {
  const seed = premise()
  returned(seed, thread)
  expect(planById(seed.db, 7)).toMatchObject({ state: 'queued', step: 1 })
  expect(ofKind(seed.db, 'return')).toEqual([{ plan: 7, kind: 'return', actor: 'coo', outcome: 'pass', message: 'step 1' }])
  expect(maybe(seed.home, 7, 'ask.md')).toBe(`${OLD}\n## Answer from the premise\n\n${PREMISE}\n`)
  expect(seed.calls).toEqual([
    ['issue', 'reopen', '139', '--repo', 'caliperforge/caliperforge'],
    ['api', '-X', 'DELETE', 'repos/caliperforge/caliperforge/issues/comments/41'],
  ])
})

test('a done plan that landed still throws', () => {
  const seed = premise()
  seed.db.exec(`INSERT INTO approvals (id, subject_kind, subject_id, subject_digest, who, decision, reason, approved_at)
    VALUES (1, 'deliverable', 1, printf('%064d', 0), 'ceo', 'approved', NULL, '2026-10-03');
    INSERT INTO deliverables (plan_id, step, seat, diff_digest, state, tests_pass, byte_identical_elsewhere, fork_ci_green, bot_clean,
      target_warm, approval_id, evidence) VALUES (7, 2, 'typescript_specialist', printf('%064d', 0), 'pushed', 1, 1, 1, 1, 1, 1, 'pr1')`)
  expect(() => { returned(seed, never) }).toThrow('is neither blocked on the ceo nor halted')
  expect(seed.calls).toEqual([])
  expect(maybe(seed.home, 7, 'ask.md')).toBe(OLD)
})
