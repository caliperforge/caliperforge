import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { adopt } from '../../cli/adopt.ts'
import { approve as approveCard } from '../../cli/batch.ts'
import type { Pr } from '../../cli/gh.ts'
import { load } from '../../runner/rules.ts'
import { filesOf } from '../../store/files.ts'
import { advance, dropPlan, rewind } from '../../store/plans.ts'
import { approve as approvePublish } from '../card.ts'
import { tick } from '../index.ts'
import { push, type Wire } from '../push.ts'
import { checkout, maybe, srcDir } from '../workspace.ts'
import { approve, CARRIED, plan, PR, stub, watched, world, type World } from './world.ts'

const BRANCH = 'hello-v1'

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()

const view = (): unknown => ({ number: 7, url: PR, state: 'OPEN', title: 'hello', closingIssuesReferences: [],
  body: '- D1 add `hello()` in `src/hello.ts`\n- D2 a call with no name is refused\n',
  headRefName: BRANCH, headRepositoryOwner: { login: 'caliperforge' } })

const pr = (): Pr => ({ number: 7, url: PR, state: 'OPEN', mergedAt: null, mergedBy: null, reviewDecision: null,
  comments: [], reviews: [], statusCheckRollup: [] })

/** The fork's `BRANCH` one commit past main, adopted, approved and rewound to `step`. */
function adopted(step: number): { w: World; fork: string; old: string; row: ReturnType<typeof adopt> } {
  const w = world()
  const fork = join(w.root, 'remotes/caliperforge/widget')
  git(fork, ['checkout', '-qb', BRANCH])
  writeFileSync(join(fork, 'src/hello.ts'), 'export const hello = (): string => "v1"\n')
  git(fork, ['commit', '-qam', 'the v1 round'])
  const old = git(fork, ['rev-parse', 'HEAD'])
  git(fork, ['checkout', '-q', 'main'])
  dropPlan(w.db, 1)
  const row = adopt(w.db, w.root, 'acme/widget#7', '2026-09-18', view)
  approve(w.db, row.target)
  rewind(w.db, row.plan, step)
  load(w.db, w.root)
  return { w, fork, old, row }
}

test('D1 D3 an adopted plan at step 3 is railed on its fork branch', { timeout: 60_000 }, async () => {
  const { w, fork, old, row } = adopted(3)
  await tick(w.db, w.root, stub(CARRIED), undefined, pr, watched([], w.root, row.plan))
  const src = srcDir(w.root, row.plan)
  expect(git(src, ['rev-parse', 'HEAD'])).toBe(old)
  expect(git(src, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(BRANCH)
  expect(git(src, ['remote', 'get-url', 'origin'])).toBe(fork)
  expect(plan(w.db, row.plan).step).toBe(4)
  expect(filesOf(w.db, row.plan).map((f) => f.path)).toEqual(['src/hello.ts'])
})

test('D2 a clone on another branch is cloned again on pr.branch', { timeout: 60_000 }, async () => {
  const { w, row } = adopted(3)
  const dir = checkout(w.root, row.plan, 'acme/widget', 'widget-7-a1').dir
  git(dir, ['checkout', '-q', '-B', 'main', 'origin/main'])
  expect(maybe(w.root, row.plan, 'base.sha')).not.toBeNull()
  await tick(w.db, w.root, stub(CARRIED), undefined, pr, watched([], w.root, row.plan))
  expect(git(srcDir(w.root, row.plan), ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(BRANCH)
})

test('D4 a plan with no pr.branch still needs its hand-back', { timeout: 60_000 }, async () => {
  const w = world()
  checkout(w.root, 1, 'acme/widget', 'widget-12-a1')
  approve(w.db, 1)
  rewind(w.db, 1, 3)
  const [fired] = await tick(w.db, w.root, stub(CARRIED))
  expect(fired?.spans.some((s) => s.startsWith('threw:') && s.includes('step-2.handback.md'))).toBe(true)
})

test('D5 an adopted PR round fast-forwards its own branch', { timeout: 90_000 }, async () => {
  const { w, fork, old, row } = adopted(1)

  const sent: string[] = []
  const log = watched(sent, w.root, row.plan)
  const wire: Wire = { ...log, send: (dir, ref) => {
    log.send(dir, ref)
    git(dir, ['push', '-q', 'origin', ref])
  } }
  for (let at = 0; at < 12 && plan(w.db, row.plan).step < 7; at += 1) {
    if (plan(w.db, row.plan).step === 2) writeFileSync(join(srcDir(w.root, row.plan), 'src/hello.ts'), 'export const hello = (): string => "hey"\n')
    await tick(w.db, w.root, stub(CARRIED), undefined, pr, wire)
  }
  expect(plan(w.db, row.plan).step).toBe(7)

  approveCard(w.db, w.root, 'plan', row.plan, 'ceo')
  advance(w.db, plan(w.db, row.plan), 8)
  push(w.db, w.root, plan(w.db, row.plan), wire)
  approvePublish(w.db, w.root, row.plan, 'ceo')
  expect(push(w.db, w.root, plan(w.db, row.plan), wire)).toMatchObject({ outcome: 'pass', note: `pushed ${BRANCH} onto ${PR}` })
  expect(sent.filter((l) => l.startsWith('open '))).toEqual([])
  expect(sent.filter((l) => l === `send src ${BRANCH}`)).toHaveLength(1)
  const tip = git(fork, ['rev-parse', BRANCH])
  expect(tip).not.toBe(old)
  git(fork, ['merge-base', '--is-ancestor', old, tip])
})
