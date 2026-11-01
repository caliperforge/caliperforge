import { expect, test } from 'vitest'
import type { Read } from '../../cli/gh.ts'
import { logged } from '../../store/events.ts'
import { setTargetState, targetRow } from '../../store/targets.ts'
import { route } from '../next.ts'
import { kernel } from '../steps.ts'
import { plan, world, type World } from './world.ts'

const URL = 'https://github.com/acme/widget/issues/12'
const WANTED = `wanted: no maintainer opened or commented on it, and it is on no board ${URL}`

function gh(wanted: boolean): Read {
  return (args) => {
    if (args[0] === 'issue') {
      return { number: 12, title: 'hello', body: 'b', state: 'OPEN', url: URL, author: { login: wanted ? 'keeper' : 'reporter' },
        assignees: [], comments: [], closedByPullRequestsReferences: [], projectItems: [] }
    }
    if (String(args[1]).includes('/git/trees/')) return { tree: [] }
    if (args[0] === 'search' || !args.includes('merged')) return []
    return [{ url: 'https://github.com/acme/widget/pull/2', author: { login: 'outsider' }, mergedBy: { login: 'keeper' },
      body: 'Generated with Claude Code', additions: 1, deletions: 0, files: [{ path: 'src/a.ts' }] }]
  }
}

const measured = (w: World, outcome: 'pass' | 'refuse', message: string): number =>
  logged(w.db, { plan: 1, kind: 'measure', actor: 'kernel', outcome, message, pointer: null, run: null })

/** A world whose target step 0 parked on `wanted`, its note logged as `stepped()` logs it. */
function parkedByCheck(): World {
  const w = world()
  const out = kernel(w.db, w.root, plan(w.db, 1), undefined, gh(false))
  measured(w, 'refuse', out.note)
  return w
}

test('D1: a check-parked target that now passes goes back to ready', () => {
  const w = parkedByCheck()
  expect(route(w.db, plan(w.db, 1), new Date())).toMatchObject({ fire: { name: 'measure' } })
  expect(kernel(w.db, w.root, plan(w.db, 1), undefined, gh(true))).toMatchObject({ outcome: 'pass',
    note: 'acme/widget#12 warm; ai stance: open — "Generated with Claude Code" https://github.com/acme/widget/pull/2' })
  expect(targetRow(w.db, 1).state).toBe('ready')
})

test('D2: a check-parked target that still fails stays parked', () => {
  const w = parkedByCheck()
  expect(kernel(w.db, w.root, plan(w.db, 1), undefined, gh(false))).toMatchObject({ outcome: 'refuse', held: true, note: WANTED, quiet: true })
  expect(targetRow(w.db, 1).state).toBe('parked')
})

test.each([
  { why: 'a cold target', make: (): World => world('cold') },
  { why: 'a target parked after a pass', make: (): World => {
    const w = world()
    measured(w, 'pass', 'acme/widget#12 warm')
    setTargetState(w.db, 1, 'parked')
    return w
  } },
])('D3: $why is never re-checked', ({ make }) => {
  const w = make()
  const read: Read = () => { throw new Error('gh was called') }
  expect(route(w.db, plan(w.db, 1), new Date())).toEqual({ wait: 'target_parked', on: null })
  expect(kernel(w.db, w.root, plan(w.db, 1), undefined, read)).toMatchObject({ outcome: 'refuse', note: 'target state parked' })
  expect(targetRow(w.db, 1).state).toBe('parked')
})

test('D4: a check-parked target with no Read stays refused', () => {
  const w = parkedByCheck()
  expect(kernel(w.db, w.root, plan(w.db, 1))).toMatchObject({ outcome: 'refuse', note: 'target state parked' })
  expect(targetRow(w.db, 1).state).toBe('parked')
})
