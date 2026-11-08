import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { Provider } from '../../providers/kind.ts'
import { eventsOf } from '../../store/events.ts'
import { set } from '../../store/lanes.ts'
import { dropPlan, putPlan } from '../../store/plans.ts'
import { refusalRows } from '../../store/refusals.ts'
import { tick } from '../index.ts'
import { route } from '../next.ts'
import { get, headSha, maybe, put, srcDir } from '../workspace.ts'
import { plan, stub, world, type World } from './world.ts'

const ASK = '# The cap\n\n**Question:** what is the cap?\n**Would be wrong if:** a page names another cap\n**Done when:** a quote names it\n**Measure:** time it\n'

const JOB = '**Run:** echo measured; exit 3\n**Output:** ~/cf_work/job/\n'

/** An answer citing the job's command at `head` with `quote`. */
const cited = (head: string, quote: string): string =>
  `The job measured [source:1].\n\n---\nsources:\n  - run:\n      command: echo measured; exit 3\n      commit: ${head}\n      quote: ${quote}\n      claim: The job measured\n---\n`

afterEach(() => {
  vi.unstubAllEnvs()
})

const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-home-'))
  vi.stubEnv('HOME', dir)
  return dir
}

const researching = (ask = ASK): World => {
  const w = world()
  const { queued_at } = plan(w.db, 1)
  dropPlan(w.db, 1)
  putPlan(w.db, { id: 1, pipe_id: 1, target_id: 1, template: 'research', state: 'queued', queued_at, step: 0, retries: 0 })
  put(w.root, 1, 'ask.md', ask)
  return w
}

const FETCH = `${ASK}**Output:** ~/cf_work/job/\n`

/** `seat` answers each of `replies` in turn and its prompts land in `prompts`. */
const answering = (replies: string[], prompts: string[], seat = 'measurer'): Provider => ({
  name: 'claude-agent-sdk',
  fire: (packet) => {
    if (packet.prompt.includes(`# ${seat}\n`)) prompts.push(packet.prompt)
    const text = replies[prompts.length - 1] ?? ''
    return stub(text, 0, text).fire(packet)
  },
})

test('a Run reply waits on its job, then gathers with its exit', async () => {
  const out = join(home(), 'cf_work/job')
  const w = researching()
  const prompts: string[] = []
  const replies = [JOB]
  const seats = answering(replies, prompts)
  await tick(w.db, w.root, seats)
  await tick(w.db, w.root, seats)
  replies.push(cited(headSha(srcDir(w.root, 1)), 'measured'))
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
  expect(JSON.parse(get(w.root, 1, 'runs.json'))).toEqual([{ command: 'echo measured; exit 3', output: 'measured\n' }])
  await tick(w.db, w.root, seats)
  expect(eventsOf(w.db, 1, 'check')).toMatchObject([{ outcome: 'pass' }])
})

test('a fetcher Run reply waits on its job, then gathers its exit', async () => {
  const out = join(home(), 'cf_work/job')
  const w = researching(FETCH)
  const prompts: string[] = []
  const replies = [JOB]
  const seats = answering(replies, prompts, 'fetcher')
  await tick(w.db, w.root, seats)
  await tick(w.db, w.root, seats)
  replies.push(cited(headSha(srcDir(w.root, 1)), 'measured'))
  expect(eventsOf(w.db, 1, 'gather')).toMatchObject([{ outcome: 'pass', message: 'long job started: echo measured; exit 3' }])
  expect(JSON.parse(get(w.root, 1, 'job.json'))).toMatchObject({ command: 'echo measured; exit 3', out })
  expect(eventsOf(w.db, 1, 'long_job')).toEqual([{ actor: 'started', outcome: 'pass', message: 'echo measured; exit 3' }])
  expect(route(w.db, plan(w.db, 1), new Date())).toEqual({ wait: 'long_job', on: null })
  await vi.waitFor(() => { expect(existsSync(join(out, 'job.exit'))).toBe(true) })
  await tick(w.db, w.root, seats)
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain(`# Long job\n\n\`echo measured; exit 3\` exited 3`)
  expect(plan(w.db, 1).step).toBe(2)
  expect(JSON.parse(get(w.root, 1, 'runs.json'))).toEqual([{ command: 'echo measured; exit 3', output: 'measured\n' }])
})

test('a cite of the job with a quote not in its log is refused', async () => {
  const out = join(home(), 'cf_work/job')
  const w = researching()
  const replies = [JOB]
  const seats = answering(replies, [])
  await tick(w.db, w.root, seats)
  await tick(w.db, w.root, seats)
  replies.push(cited(headSha(srcDir(w.root, 1)), 'unmeasured'))
  await vi.waitFor(() => { expect(existsSync(join(out, 'job.exit'))).toBe(true) })
  await tick(w.db, w.root, seats)
  await tick(w.db, w.root, seats)
  expect(refusalRows(w.db, 1)[0]).toMatchObject({ step: 2, span: 'research.run_missing' })
})

test('a job past research.long_job_seconds halts its plan', async () => {
  home()
  const w = researching()
  set(w.db, 'research.long_job_seconds', '0', 'ceo', '2026-11-08')
  const prompts: string[] = []
  const seats = answering(['**Run:** sleep 30\n**Output:** ~/cf_work/job/\n'], prompts)
  for (let n = 0; n < 4; n += 1) await tick(w.db, w.root, seats)
  expect(eventsOf(w.db, 1, 'long_job').map((e) => e.actor)).toEqual(['started', 'walled'])
  expect(plan(w.db, 1).state).toBe('halted')
  expect(eventsOf(w.db, 1, 'halted')).toEqual([{ actor: 'tick', outcome: 'refuse', message: 'long job walled at 0s: sleep 30' }])
  expect(prompts).toHaveLength(1)
  const { pid } = JSON.parse(get(w.root, 1, 'job.json')) as { pid: number }
  await vi.waitFor(() => { expect(() => process.kill(-pid, 0)).toThrow() })
})

test.each([
  ['measurer', '', ASK], ['measurer', '**Output:** /tmp/x\n', ASK], ['fetcher', '', FETCH], ['fetcher', '**Output:** /tmp/x\n', FETCH],
])('a %s Run reply with Output %j is refused', async (seat, output, ask) => {
  home()
  const w = researching(ask)
  const seats = answering([`**Run:** echo measured\n${output}`], [], seat)
  await tick(w.db, w.root, seats)
  await tick(w.db, w.root, seats)
  expect(eventsOf(w.db, 1, 'gather')).toMatchObject([{ outcome: 'refuse', message: '**Run:** needs an **Output:** folder under ~/cf_work/' }])
  expect(eventsOf(w.db, 1, 'long_job')).toEqual([])
  expect(maybe(w.root, 1, 'job.json')).toBeNull()
})
