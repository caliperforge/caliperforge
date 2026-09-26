import { expect, test } from 'vitest'
import type { Read } from '../../cli/gh.ts'
import { tick } from '../index.ts'
import { route } from '../next.ts'
import { kernel } from '../steps.ts'
import { get } from '../workspace.ts'
import { CARRIED, plan, stub, world } from './world.ts'

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

test('D4: a no parks the target held, and the next route for the plan waits on target_parked', () => {
  const w = world()
  expect(kernel(w.db, w.root, plan(w.db, 1), undefined, gh(false))).toMatchObject({ outcome: 'refuse', held: true,
    note: `wanted: no maintainer opened or commented on it, and it is on no board ${URL}` })
  expect(state(w)).toBe('parked')
  expect(route(w.db, plan(w.db, 1), new Date())).toEqual({ wait: 'target_parked', on: null })
})

test('D5: step 0 run again replaces its section after the ask, passes, and leaves the target ready', () => {
  const w = world()
  kernel(w.db, w.root, plan(w.db, 1), undefined, gh(true))
  expect(kernel(w.db, w.root, plan(w.db, 1), undefined, gh(true))).toMatchObject({ outcome: 'pass', note: 'acme/widget#12 warm' })
  const ask = get(w.root, 1, 'ask.md')
  expect(ask.split('## Target check')).toHaveLength(2)
  expect(ask).toMatch(/^# hello\n\n- \*\*D1\*\* add `hello\(\)` in `src\/hello\.ts`\n\n## Target check\n\n- wanted: yes .*\n- unclaimed: yes .*\n- shape: yes .*\n$/)
  expect(state(w)).toBe('ready')
})

test('a lap with no Read steps past step 0 as it always has, leaving the ask alone', async () => {
  const w = world()
  const before = get(w.root, 1, 'ask.md')
  expect((await tick(w.db, w.root, stub(CARRIED)))[0]).toMatchObject({ step: 0, name: 'measure', outcome: 'pass', note: 'acme/widget#12 warm' })
  expect(get(w.root, 1, 'ask.md')).toBe(before)
})
