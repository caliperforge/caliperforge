import { expect, test } from 'vitest'
import type { Pr } from '../../cli/gh.ts'
import { load } from '../../runner/rules.ts'
import { gates } from '../../store/approvals.ts'
import { pushedRow } from '../../store/deliverables.ts'
import { ofKind } from '../../store/events.ts'
import { putPlan } from '../../store/plans.ts'
import { reached } from '../../store/unreached.ts'
import { capture } from '../capture.ts'
import { cause } from '../unpolled.ts'
import { srcDir } from '../workspace.ts'
import { git } from './bases.ts'
import { world, type World } from './world.ts'

const URL = 'https://github.com/acme/widget/pull/7'
const LIMIT = 'GraphQL: API rate limit exceeded for user ID 1.'
const COMMAND = 'Command failed: gh pr view 7'

const view = (): Pr => ({ number: 7, url: URL, state: 'OPEN', mergedAt: null, mergedBy: null, reviewDecision: null,
  comments: [], reviews: [], statusCheckRollup: [] })

const failed = (stderr: unknown): Error => Object.assign(new Error(`${COMMAND}\n${String(stderr)}`), { stderr })

const down = (): Pr => { throw failed(`${LIMIT}\n\n`) }

function pushed(): World {
  const w = world()
  load(w.db, w.root)
  pushedRow(w.db, { plan: 1, step: 6, seat: 'typescript_specialist', diff_digest: 'd'.repeat(64), evidence: URL },
    gates(w.db, 1, 'd'.repeat(64)))
  return w
}

test('D1 D3 one swallowed per spell, then back after n', () => {
  const w = pushed()
  for (let i = 0; i < 3; i += 1) expect(capture(w.db, down)).toEqual([])
  capture(w.db, view)
  capture(w.db, view)
  capture(w.db, down)
  const event = (kind: string, message: string): object => ({ plan: 1, kind, actor: 'reachable', outcome: 'pass', message })
  expect(ofKind(w.db, 'swallowed', 'back')).toEqual([event('swallowed', LIMIT), event('back', 'back after 3 failed reads'),
    event('swallowed', LIMIT)])
})

test('D4 cause falls back to the first line', () => {
  expect(cause(failed(`${LIMIT}\n`))).toBe(LIMIT)
  expect(cause(failed(' \n\n'))).toBe(COMMAND)
  expect(cause(failed(Buffer.from(LIMIT)))).toBe(COMMAND)
  expect(cause(new Error('HTTP 502\nbody'))).toBe('HTTP 502')
})

test('D5 a gone pr leaves no unreached row', () => {
  const w = pushed()
  capture(w.db, () => { throw new Error('GraphQL: Could not resolve to a PullRequest with the number of 7.') })
  expect(ofKind(w.db, 'gone', 'swallowed').map((e) => e.kind)).toEqual(['gone'])
  expect(reached(w.db, 1)).toBe(0)
})

function rehearsing(): World {
  const w = world()
  putPlan(w.db, { id: 2, pipe_id: 1, target_id: 1, template: 'pr_path', state: 'running', queued_at: '2026-09-17T00:00:00.000Z', step: 7, retries: 0 })
  const dir = srcDir(w.root, 2)
  git(dir, ['init', '-q'])
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base'])
  return w
}

const rehearsal = (message: string): object => ({ plan: 2, kind: 'swallowed', actor: 'rehearsal', outcome: 'pass', message })

test('failed rehearsal lookups log one cause per spell', () => {
  const w = rehearsing()
  for (let i = 0; i < 3; i += 1) capture(w.db, view, w.root, down)
  expect(ofKind(w.db, 'swallowed')).toEqual([rehearsal(LIMIT)])
})

test('a lookup with no pr ends the spell', () => {
  const w = rehearsing()
  capture(w.db, view, w.root, down)
  capture(w.db, view, w.root, () => [])
  expect(reached(w.db, 2)).toBe(0)
  capture(w.db, view, w.root, down)
  expect(ofKind(w.db, 'swallowed')).toEqual([rehearsal(LIMIT), rehearsal(LIMIT)])
})

test('a lookup with a pr leaves the count to the read', () => {
  const w = rehearsing()
  for (let i = 0; i < 2; i += 1) capture(w.db, view, w.root, down)
  capture(w.db, view, w.root, () => [{ number: 7 }])
  expect(ofKind(w.db, 'swallowed', 'back')).toEqual([rehearsal(LIMIT),
    { plan: 2, kind: 'back', actor: 'reachable', outcome: 'pass', message: 'back after 2 failed reads' }])
})
