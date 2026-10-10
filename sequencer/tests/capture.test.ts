import { expect, test } from 'vitest'
import type { Pr } from '../../cli/gh.ts'
import { load } from '../../runner/rules.ts'
import { gates } from '../../store/approvals.ts'
import { pushedRow } from '../../store/deliverables.ts'
import { ofKind } from '../../store/events.ts'
import { reached } from '../../store/unreached.ts'
import { capture } from '../capture.ts'
import { cause } from '../unpolled.ts'
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
