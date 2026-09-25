import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Packet } from '../../providers/kind.ts'
import type { Gh } from '../../rails/ci-green/index.ts'
import { rewind } from '../../store/plans.ts'
import { tick } from '../index.ts'
import { put, srcDir } from '../workspace.ts'
import { approve, CARRIED, plan, runsAfter, stub, watched, world, type World } from './world.ts'

/** The builder's bytes, written the way a real builder writes them: into the checkout it was handed, mid-fire. */
const writes = (packet: Packet): void => {
  if (packet.tools.includes('Write')) writeFileSync(join(packet.cwd, 'src/hello.ts'), 'export const hello = (): string => "hey"\n')
}

function ready(): World {
  const w = world()
  approve(w.db, w.target)
  return w
}

test('chains queue to sign-off in one tick', async () => {
  const w = ready()
  const sent: string[] = []
  const fired = await tick(w.db, w.root, stub(CARRIED, 0, undefined, writes), undefined, undefined, watched(sent, w.root, 1), 5)
  expect(fired.map((f) => [f.step, f.name, f.outcome])).toEqual([
    [0, 'measure', 'pass'], [1, 'ruling', 'pass'], [2, 'build', 'pass'], [3, 'rails', 'pass'],
    [4, 'review', 'pass'], [5, 'senior', 'pass'], [6, 'ready', 'pass'],
  ])
  expect(plan(w.db, 1)).toMatchObject({ step: 7, state: 'running' })
})

test('stops at a CI wait, next tick resumes', async () => {
  const w = ready()
  const wire = watched([], w.root, 1, runsAfter(w.root, 1, 1))
  const fired = await tick(w.db, w.root, stub(CARRIED, 0, undefined, writes), undefined, undefined, wire, 5)
  expect(fired.at(-1)).toMatchObject({ step: 6, name: 'ready' })
  expect(plan(w.db, 1)).toMatchObject({ step: 6, state: 'running' })
  expect((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire, 5)).map((f) => f.step)).toEqual([6])
  expect(plan(w.db, 1).step).toBe(7)
})

test('stops when the lane is switched off', async () => {
  const w = ready()
  const off = (packet: Packet): void => {
    writes(packet)
    if (packet.tools.includes('Write')) w.db.prepare("UPDATE pipes SET enabled = 0 WHERE name = 'pr-path'").run()
  }
  const fired = await tick(w.db, w.root, stub(CARRIED, 0, undefined, off), undefined, undefined, watched([], w.root, 1), 5)
  expect(fired.map((f) => f.step)).toEqual([0, 1, 2])
  expect(plan(w.db, 1).step).toBe(3)
})

test('one step per tick without a budget', async () => {
  const w = ready()
  expect((await tick(w.db, w.root, stub(CARRIED))).map((f) => f.step)).toEqual([0])
})

test('a refused build rebuilds in the same tick', async () => {
  const w = ready()
  let builds = 0
  const inner = stub(CARRIED, 0, undefined, writes)
  const flaky = { ...inner, fire: async (packet: Packet) => {
    const out = await inner.fire(packet)
    if (!packet.tools.includes('Write')) return out
    builds += 1
    return builds === 1 ? { ...out, ended: 'stopped' as const, exit: 1, stop_reason: 'hook_stopped' } : out
  } }
  const fired = await tick(w.db, w.root, flaky, undefined, undefined, watched([], w.root, 1), 5)
  expect(fired.slice(0, 4).map((f) => [f.step, f.outcome])).toEqual([[0, 'pass'], [1, 'pass'], [2, 'refuse'], [2, 'pass']])
  expect(plan(w.db, 1).step).toBe(7)
})

test('waits on every workflow, judges only its own', async () => {
  const w = ready()
  let reads = 0
  const runs: Gh = () => {
    reads += 1
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: srcDir(w.root, 1), encoding: 'utf8' }).trim()
    const url = 'https://github.com/caliperforge/widget/actions/runs/2'
    return JSON.stringify([
      { headSha, status: 'completed', conclusion: 'success', url, workflowName: 'Src' },
      { headSha, status: reads === 1 ? 'in_progress' : 'completed', conclusion: reads === 1 ? '' : 'failure', url, workflowName: 'Python' },
    ])
  }
  const wire = watched([], w.root, 1, runs)
  await tick(w.db, w.root, stub(CARRIED, 0, undefined, writes), undefined, undefined, wire, 5)
  expect(plan(w.db, 1).step).toBe(6)
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire, 5)
  expect(plan(w.db, 1).step).toBe(7)
  expect(JSON.parse(readFileSync(join(w.root, '.cf/work/1/ci.json'), 'utf8'))).toEqual([
    { workflow: 'Src', status: 'completed', conclusion: 'success', gates: true },
    { workflow: 'Python', status: 'completed', conclusion: 'failure', gates: false },
  ])
})

test('a second round before any PR goes out on the next branch', async () => {
  const w = ready()
  await tick(w.db, w.root, stub(CARRIED, 0, undefined, writes), undefined, undefined, watched([], w.root, 1), 5)
  const src = srcDir(w.root, 1)
  execFileSync('git', ['push', '-q', 'origin', 'widget-12-a1'], { cwd: src })
  rewind(w.db, 1, 2)
  const again = (packet: Packet): void => {
    if (packet.tools.includes('Write')) writeFileSync(join(packet.cwd, 'src/hello.ts'), 'export const hello = (): string => "hello"\n')
  }
  const sent: string[] = []
  await tick(w.db, w.root, stub(CARRIED, 0, undefined, again), undefined, undefined, watched(sent, w.root, 1), 5)
  expect(plan(w.db, 1).step).toBe(7)
  expect(sent).toEqual(['unrehearse caliperforge/widget widget-12-a1', 'send src widget-12-a2', 'rehearse caliperforge/widget widget-12-a2',
    'send src widget-12-a2'])
  const count = execFileSync('git', ['rev-list', '--count', 'refs/remotes/upstream/main..HEAD'], { cwd: src, encoding: 'utf8' })
  expect(count.trim()).toBe('1')
})

test('Tight reads the PR text the card set, and never the handback', async () => {
  const told = 'Updated `src/hello.ts` so hello() says hey.\n\n' + CARRIED
  const w = ready()
  put(w.root, 1, 'pr.md', 'Addresses #12.\n\n## Summary\n\n- `hello()` says hey.\n')
  const fired = await tick(w.db, w.root, stub(told, 0, undefined, writes), undefined, undefined, watched([], w.root, 1), 5)
  expect(fired.find((f) => f.step === 3)).toMatchObject({ outcome: 'pass' })

  const bare = ready()
  const unset = await tick(bare.db, bare.root, stub(told, 0, undefined, writes), undefined, undefined, watched([], bare.root, 1), 5)
  expect(unset.find((f) => f.step === 3)).toMatchObject({ outcome: 'pass' })
})
