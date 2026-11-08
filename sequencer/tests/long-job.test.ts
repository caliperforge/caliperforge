import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { Provider } from '../../providers/kind.ts'
import { eventsOf } from '../../store/events.ts'
import { set } from '../../store/lanes.ts'
import { dropPlan, putPlan } from '../../store/plans.ts'
import { tick } from '../index.ts'
import { route } from '../next.ts'
import { get, maybe, put } from '../workspace.ts'
import { plan, stub, world, type World } from './world.ts'

const ASK = '# The cap\n\n**Question:** what is the cap?\n**Would be wrong if:** a page names another cap\n**Done when:** a quote names it\n**Measure:** time it\n'

const FOUND = 'The cap is 3 [source:1].\n\n---\nsources:\n  - url: https://a.example/doc\n    fetched_at: 2026-10-04T10:00:00Z\n    quote: The cap is 3.\n    claim: The cap is 3\n---\n'

afterEach(() => {
  vi.unstubAllEnvs()
})

const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-home-'))
  vi.stubEnv('HOME', dir)
  return dir
}

const researching = (): World => {
  const w = world()
  const { queued_at } = plan(w.db, 1)
  dropPlan(w.db, 1)
  putPlan(w.db, { id: 1, pipe_id: 1, target_id: 1, template: 'research', state: 'queued', queued_at, step: 0, retries: 0 })
  put(w.root, 1, 'ask.md', ASK)
  return w
}

/** The measurer answers each of `replies` in turn and its prompts land in `prompts`. */
const measurer = (replies: string[], prompts: string[]): Provider => ({
  name: 'claude-agent-sdk',
  fire: (packet) => {
    if (packet.prompt.includes('# measurer\n')) prompts.push(packet.prompt)
    const text = replies[prompts.length - 1] ?? ''
    return stub(text, 0, text).fire(packet)
  },
})

test('a Run reply waits on its job, then gathers with its exit', async () => {
  const out = join(home(), 'cf_work/job')
  const w = researching()
  const prompts: string[] = []
  const seats = measurer(['**Run:** echo measured; exit 3\n**Output:** ~/cf_work/job/\n', FOUND], prompts)
  await tick(w.db, w.root, seats)
  await tick(w.db, w.root, seats)
  expect(JSON.parse(get(w.root, 1, 'job.json'))).toMatchObject({ command: 'echo measured; exit 3', out })
  expect(eventsOf(w.db, 1, 'long_job')).toEqual([{ actor: 'started', outcome: 'pass', message: 'echo measured; exit 3' }])
  expect(plan(w.db, 1)).toMatchObject({ state: 'running', step: 1 })
  expect(route(w.db, plan(w.db, 1), new Date())).toEqual({ wait: 'long_job', on: null })
  await vi.waitFor(() => { expect(existsSync(join(out, 'job.exit'))).toBe(true) })
  await tick(w.db, w.root, seats)
  expect(eventsOf(w.db, 1, 'long_job').at(-1)).toEqual({ actor: 'exited', outcome: 'pass', message: 'exit 3' })
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain(`# Long job\n\n\`echo measured; exit 3\` exited 3; its log, ${join(out, 'job.log')}, ends:\n\nmeasured`)
  expect(plan(w.db, 1).step).toBe(2)
})

test('a job past research.long_job_seconds halts its plan', async () => {
  home()
  const w = researching()
  set(w.db, 'research.long_job_seconds', '0', 'ceo', '2026-11-08')
  const prompts: string[] = []
  const seats = measurer(['**Run:** sleep 30\n**Output:** ~/cf_work/job/\n'], prompts)
  for (let n = 0; n < 4; n += 1) await tick(w.db, w.root, seats)
  expect(eventsOf(w.db, 1, 'long_job').map((e) => e.actor)).toEqual(['started', 'walled'])
  expect(plan(w.db, 1).state).toBe('halted')
  expect(eventsOf(w.db, 1, 'halted')).toEqual([{ actor: 'tick', outcome: 'refuse', message: 'long job walled at 0s: sleep 30' }])
  expect(prompts).toHaveLength(1)
  const { pid } = JSON.parse(get(w.root, 1, 'job.json')) as { pid: number }
  await vi.waitFor(() => { expect(() => process.kill(-pid, 0)).toThrow() })
})

test.each(['', '**Output:** /tmp/x\n'])('a Run reply with Output %j is refused', async (output) => {
  home()
  const w = researching()
  const seats = measurer([`**Run:** echo measured\n${output}`], [])
  await tick(w.db, w.root, seats)
  await tick(w.db, w.root, seats)
  expect(eventsOf(w.db, 1, 'gather')).toMatchObject([{ outcome: 'refuse', message: '**Run:** needs an **Output:** folder under ~/cf_work/' }])
  expect(eventsOf(w.db, 1, 'long_job')).toEqual([])
  expect(maybe(w.root, 1, 'job.json')).toBeNull()
})
