import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { expect, test } from 'vitest'
import { landed } from '../../cli/batch.ts'
import { headApproved, headDigest } from '../../store/approvals.ts'
import { advance } from '../../store/plans.ts'
import { tick } from '../index.ts'
import { headOf, push, type Wire } from '../push.ts'
import { blocked } from '../steps.ts'
import { internalBranch, srcDir } from '../workspace.ts'
import { approve, CARRIED, forkCi, internalPlan, ours, plan, ready, stub, world, type World } from './world.ts'

const ID = 2
const ISSUE = 'https://github.com/caliperforge/caliperforge/issues/34'
const URL = 'https://github.com/caliperforge/caliperforge/pull/40'

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** The pr-path world with its target plan taken out, so the one lane carries our own issue alone. */
function mine(): World {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root)
  internalPlan(w.db, w.root, ID)
  return w
}

function watched(log: string[]): Wire {
  return {
    send: (dir, branch) => void log.push(`send ${basename(dir)} ${branch}`),
    open: (repo, head) => { log.push(`open ${repo} ${head}`); return URL },
    close: (repo, no, sha) => void log.push(`close ${repo}#${String(no)} ${sha.slice(0, 7)}`),
  }
}

test('a plan with an origin and no target passes measure and ruling, and waits on no approval', async () => {
  const w = mine()
  expect(blocked(w.db, plan(w.db, ID), '2026-09-18')).toBeNull()
  const first = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(first).toMatchObject({ plan: ID, step: 0, name: 'measure', outcome: 'pass' })
  expect(first?.note).toContain('caliperforge/caliperforge#34')
  expect(plan(w.db, ID).step).toBe(1)
  expect(blocked(w.db, plan(w.db, ID), '2026-09-18')).toBeNull()

  const second = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(second).toMatchObject({ step: 1, name: 'ruling', outcome: 'pass' })
  expect(plan(w.db, ID).step).toBe(2)
})

test('the internal checkout is our own repo on p<plan>-<slug>, built by the typescript seat', async () => {
  const w = mine()
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const fired = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(fired).toMatchObject({ step: 3, name: 'rails', outcome: 'pass' })
  const src = srcDir(w.root, ID)
  expect(git(src, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('p2-let-an-internal-plan-run')
  expect(git(src, ['remote', 'get-url', 'origin'])).toMatch(/remotes\/caliperforge\/caliperforge$/)
  expect(git(src, ['remote', 'get-url', 'upstream'])).toMatch(/remotes\/caliperforge\/caliperforge$/)
  expect(w.db.prepare('SELECT seat FROM runs WHERE step = 2').get()).toEqual({ seat: 'typescript_specialist' })
  expect(internalBranch(7, 'A/B: an issue — with punctuation!')).toBe('p7-a-b-an-issue-with-punctuation')
  expect(internalBranch(7, '!!!')).toBe('p7-issue')
})

test('step 7 signs an internal plan on the gates and shows it in the batch as a read-out', async () => {
  const w = mine()
  const wire = watched([])
  for (let at = 0; at < 5; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  forkCi(w.db, ID)
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(plan(w.db, ID).step).toBe(7)
  expect(blocked(w.db, plan(w.db, ID), '2026-09-18')).toBeNull()

  const signed = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(signed).toMatchObject({ step: 7, name: 'batch', outcome: 'pass', state: 'running' })
  expect(w.db.prepare("SELECT who, decision, subject_digest FROM approvals WHERE subject_kind = 'plan'").get())
    .toEqual({ who: 'gates', decision: 'approved', subject_digest: plan(w.db, ID).head_digest })
  expect(plan(w.db, ID).step).toBe(8)
  expect(landed(w.db)).toEqual([{ plan: ID, origin: ISSUE, digest: plan(w.db, ID).head_digest }])
  expect(headApproved(w.db, headOf(w.root, ID).sha)).toBe(true)
})

test('a gates signature does not let an external plan leave ready, and the hook will not take one', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED))
  ready(w.db, 1)
  await tick(w.db, w.root, stub(CARRIED))
  expect(plan(w.db, 1).step).toBe(7)

  const digest = String(plan(w.db, 1).head_digest)
  const row = w.db.prepare(`INSERT INTO approvals (subject_kind, subject_id, subject_digest, who, decision, approved_at)
    VALUES ('plan', 1, ?, 'gates', 'approved', '2026-09-18T00:00:00.000Z') RETURNING id`).get(digest) as { id: number }
  w.db.prepare("UPDATE deliverables SET state = 'approved', approval_id = ? WHERE plan_id = 1 AND id = (SELECT max(id) FROM deliverables WHERE plan_id = 1)")
    .run(row.id)
  expect(() => { advance(w.db, plan(w.db, 1), 8) }).toThrow(/no ceo approval row/)
  expect(headApproved(w.db, headOf(w.root, 1).sha)).toBe(false)
  expect(push(w.db, w.root, plan(w.db, 1), watched([]))).toMatchObject({ outcome: 'refuse' })
  expect(headDigest(headOf(w.root, 1).sha)).toBe(digest)
})
