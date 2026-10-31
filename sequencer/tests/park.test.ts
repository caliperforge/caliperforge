import { expect, test } from 'vitest'
import type { Read } from '../../cli/gh.ts'
import { decide } from '../../store/approvals.ts'
import { logged } from '../../store/events.ts'
import { targetRow } from '../../store/targets.ts'
import { targetDigest } from '../approve.ts'
import { tick } from '../index.ts'
import { route } from '../next.ts'
import { kernel } from '../steps.ts'
import { get } from '../workspace.ts'
import { CARRIED, plan, stub, world, type World } from './world.ts'

const URL = 'https://github.com/acme/widget/issues/12'

function gh(wanted: boolean): Read {
  return (args) => {
    if (args[0] === 'issue') {
      return { number: 12, title: 'hello', body: 'b', state: 'OPEN', url: URL, author: { login: wanted ? 'keeper' : 'reporter' },
        assignees: [], comments: [], closedByPullRequestsReferences: [], projectItems: [] }
    }
    if (args[0] === 'search' || !args.includes('merged')) return []
    return [{ url: 'https://github.com/acme/widget/pull/2', author: { login: 'outsider' }, mergedBy: { login: 'keeper' },
      body: 'b', additions: 1, deletions: 0, files: [{ path: 'src/a.ts' }] }]
  }
}

const state = (w: ReturnType<typeof world>): unknown => w.db.prepare('SELECT state FROM targets WHERE id = 1').pluck().get()

/** What `cf approve target --by <actor>` writes, on the measurement taken at `measured`. */
function signed(w: World, actor: 'ceo' | 'coo', measured?: string): void {
  const row = targetRow(w.db, 1)
  const digest = targetDigest(measured === undefined ? row : { ...row, evidence_measured_at: measured })
  decide(w.db, 'target', 1, digest, null)
  logged(w.db, { plan: 1, kind: 'signoff', actor, outcome: 'pass', message: digest.slice(0, 12), pointer: 'target:1', run: null })
}

test('D4: a no parks the target; next route is target_parked',() => {
  const w = world()
  expect(kernel(w.db, w.root, plan(w.db, 1), undefined, gh(false))).toMatchObject({ outcome: 'refuse', held: true,
    note: `wanted: no maintainer opened or commented on it, and it is on no board ${URL}` })
  expect(state(w)).toBe('parked')
  expect(route(w.db, plan(w.db, 1), new Date())).toEqual({ wait: 'target_parked', on: null })
})

test.each([
  { why: 'D4: a COO sign-off', actor: 'coo' as const, measured: undefined },
  { why: 'D6: a CEO sign-off on an older measure', actor: 'ceo' as const, measured: '2000-01-01' },
])('$why still parks on wanted', ({ actor, measured }) => {
  const w = world()
  signed(w, actor, measured)
  expect(kernel(w.db, w.root, plan(w.db, 1), undefined, gh(false))).toMatchObject({ outcome: 'refuse', held: true,
    note: `wanted: no maintainer opened or commented on it, and it is on no board ${URL}` })
  expect(state(w)).toBe('parked')
})

test('D5: a CEO sign-off passes step 0 and names itself',() => {
  const w = world()
  signed(w, 'ceo')
  expect(kernel(w.db, w.root, plan(w.db, 1), undefined, gh(false))).toMatchObject({ outcome: 'pass', note: 'acme/widget#12 warm' })
  expect(state(w)).toBe('ready')
  expect(get(w.root, 1, 'ask.md')).toContain('\n- wanted: yes — the CEO approved target 1 (')
})

test('D5: step 0 again replaces its section and leaves it ready',() => {
  const w = world()
  kernel(w.db, w.root, plan(w.db, 1), undefined, gh(true))
  expect(kernel(w.db, w.root, plan(w.db, 1), undefined, gh(true))).toMatchObject({ outcome: 'pass', note: 'acme/widget#12 warm' })
  const ask = get(w.root, 1, 'ask.md')
  expect(ask.split('## Target check')).toHaveLength(2)
  expect(ask).toMatch(/^# hello\n\n- \*\*D1\*\* add `hello\(\)` in `src\/hello\.ts`\n\n## Target check\n\n- wanted: yes .*\n- unclaimed: yes .*\n- shape: yes .*\n$/)
  expect(state(w)).toBe('ready')
})

test('a lap with no Read passes step 0 and leaves the ask alone',async () => {
  const w = world()
  const before = get(w.root, 1, 'ask.md')
  expect((await tick(w.db, w.root, stub(CARRIED)))[0]).toMatchObject({ step: 0, name: 'measure', outcome: 'pass', note: 'acme/widget#12 warm' })
  expect(get(w.root, 1, 'ask.md')).toBe(before)
})
