import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { Provider } from '../../providers/kind.ts'
import { allEvents, eventsOf } from '../../store/events.ts'
import { set } from '../../store/lanes.ts'
import { dropPlan, end, putPlan } from '../../store/plans.ts'
import { refusalRows } from '../../store/refusals.ts'
import { unhold } from '../hold.ts'
import { tick } from '../index.ts'
import { route } from '../next.ts'
import { rule } from '../rule.ts'
import { get, headSha, maybe, put, srcDir } from '../workspace.ts'
import { plan, stub, world, type World } from './world.ts'

const QUESTION = '# The cap\n\n**Question:** what is the cap?\n**Would be wrong if:** a page names another cap\n**Done when:** a quote names it\n'

const ASK = `${QUESTION}**Measure:** time it\n`

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

const FETCH = `${QUESTION}**Output:** ~/cf_work/job/\n`

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

/** The job exits and its answer passes check, then a director ruling names `~/cf_work/ruled/` and the plan returns to gather. */
const ruled = async (prompts: string[], replies: string[]): Promise<World> => {
  const out = join(home(), 'cf_work/job')
  const w = researching()
  const seats = answering(replies, prompts)
  await tick(w.db, w.root, seats)
  await tick(w.db, w.root, seats)
  replies.push(cited(headSha(srcDir(w.root, 1)), 'measured'))
  await vi.waitFor(() => { expect(existsSync(join(out, 'job.exit'))).toBe(true) })
  await tick(w.db, w.root, seats)
  await tick(w.db, w.root, seats)
  expect(eventsOf(w.db, 1, 'check')).toMatchObject([{ outcome: 'pass' }])
  end(w.db, 1, 'halted', 'ruled')
  rule(w.db, w.root, plan(w.db, 1), 'director', '**Output:** ~/cf_work/ruled/')
  unhold(w.db, w.root, 1, 'director', 1)
  return w
}

test('a ruling after the job exits starts a new job', async () => {
  const prompts: string[] = []
  const replies = [JOB]
  const w = await ruled(prompts, replies)
  replies.push(JOB)
  await tick(w.db, w.root, answering(replies, prompts))
  expect(prompts).toHaveLength(3)
  expect(prompts[2]).not.toContain('\n\n# Long job\n\n')
  expect(eventsOf(w.db, 1, 'long_job').map((e) => e.actor)).toEqual(['started', 'exited', 'started'])
  expect(JSON.parse(get(w.root, 1, 'job.json'))).toMatchObject({ out: join(process.env.HOME ?? '', 'cf_work/ruled') })
})

test('a cite of the old job after a ruling is refused', async () => {
  const prompts: string[] = []
  const replies = [JOB]
  const w = await ruled(prompts, replies)
  replies.push(replies[1] ?? '')
  const seats = answering(replies, prompts)
  await tick(w.db, w.root, seats)
  await tick(w.db, w.root, seats)
  expect(JSON.parse(get(w.root, 1, 'runs.json'))).toEqual([])
  expect(refusalRows(w.db, 1)[0]).toMatchObject({ span: 'research.run_missing' })
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

/** A job that prints `set` when it sees an OAuth token, run with the token only in a 600 `CF_ENV_FILE` and `ANTHROPIC_BASE_URL` at `base`. */
const credentialed = async (base: string): Promise<{ w: World; log: string }> => {
  const out = join(home(), 'cf_work/job')
  const file = join(mkdtempSync(join(tmpdir(), 'cf-env-')), 'env')
  writeFileSync(file, 'CLAUDE_CODE_OAUTH_TOKEN=tok-long-job-test\n')
  chmodSync(file, 0o600)
  vi.stubEnv('CF_ENV_FILE', file)
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '')
  vi.stubEnv('ANTHROPIC_BASE_URL', base)
  const w = researching()
  const seats = answering(['**Run:** echo "${CLAUDE_CODE_OAUTH_TOKEN:+set}"\n**Output:** ~/cf_work/job/\n'], [])
  await tick(w.db, w.root, seats)
  await tick(w.db, w.root, seats)
  await vi.waitFor(() => { expect(existsSync(join(out, 'job.exit'))).toBe(true) })
  return { w, log: readFileSync(join(out, 'job.log'), 'utf8') }
}

test('a long job sees the host credential and never records it', async () => {
  const { w, log } = await credentialed('')
  expect(log).toBe('set\n')
  expect(get(w.root, 1, 'job.json')).not.toContain('tok-long-job-test')
  expect(JSON.stringify(allEvents(w.db))).not.toContain('tok-long-job-test')
})

test('a long job aimed at another endpoint gets no OAuth token', async () => {
  const { log } = await credentialed('https://proxy.example')
  expect(log).toBe('\n')
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
