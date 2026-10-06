import { execFileSync } from 'node:child_process'
import { expect, test } from 'vitest'
import { kindsOf } from '../../store/events.ts'
import { record as recordFiles } from '../../store/files.ts'
import { priority, width } from '../../store/lanes.ts'
import { addPipe, needsCeo, pipeNamed, putPlan, resume } from '../../store/plans.ts'
import { holder, took, waitsFor } from '../../store/slot.ts'
import { addTarget, targetRow } from '../../store/targets.ts'
import { tick } from '../index.ts'
import type { Wire } from '../push.ts'
import { put, srcDir } from '../workspace.ts'
import { approve, CARRIED, internalPlan, plan, runsAll, runsOn, scored, stub, watched, world, type World } from './world.ts'

const SECOND = 2
const HOLDER = 3
const AT = '2026-09-18T00:00:00.000Z'

const issue = (w: World, no: number): number =>
  addTarget(w.db, { ...targetRow(w.db, 1), issue_no: no, evidence: `https://github.com/acme/widget/issues/${String(no)}` })

/** Two plans on acme/widget in one lane open for both; a third, in a closed lane, holds the repo's fork slot. */
function pair(): World {
  const w = world()
  approve(w.db, w.target)
  const second = issue(w, 13)
  approve(w.db, second)
  putPlan(w.db, { id: SECOND, pipe_id: 1, target_id: second, template: 'pr_path', state: 'queued', queued_at: AT, step: 0, retries: 0 })
  put(w.root, SECOND, 'ask.md', '# hello again\n\n- **D1** add `hello()` in `src/hello.ts`\n')
  width(w.db, 1, 2)
  addPipe(w.db, { name: 'closed', enabled: 0, window_start: '00:00', window_end: '23:59', max_concurrent: 1 })
  putPlan(w.db, { id: HOLDER, pipe_id: pipeNamed(w.db, 'closed')?.id ?? 0, target_id: issue(w, 14), template: 'pr_path',
    state: 'running', queued_at: AT, step: 6, retries: 0 })
  took(w.db, plan(w.db, HOLDER))
  return w
}

/** The watched transport, with each rehearsal scored 5 on the plan its branch names. */
function wire(log: string[], w: World, runs = runsAll(w.root, [1, SECOND])): Wire {
  return {
    ...watched(log, w.root, 1, runs),
    rehearse: (fork, branch) => {
      scored(w.root, branch.startsWith('widget-13-') ? SECOND : 1, 5)
      log.push(`rehearse ${fork} ${branch}`)
    },
  }
}

/** Both plans driven to step 6 while the third holds the slot, the second briefed on its own file. */
async function atReady(w: World, log: string[]): Promise<void> {
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire(log, w))
  recordFiles(w.db, SECOND, [{ path: 'src/two.ts', is_new: true }])
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire(log, w))
}

const sends = (log: string[]): string[] => log.filter((l) => /^(send|rehearse) /.test(l))
const sent = (w: World, id: number): boolean => kindsOf(w.db, id).some((e) => e.kind === 'fork.sent')

test('D4: a step-3 pass while the slot is held makes no send', async () => {
  const w = pair()
  const log: string[] = []
  await atReady(w, log)
  expect([plan(w.db, 1).step, plan(w.db, SECOND).step]).toEqual([6, 6])
  expect(sends(log)).toEqual([])
  expect([plan(w.db, 1).wait_reason, plan(w.db, SECOND).wait_reason]).toEqual(['ready_proof', 'ready_proof'])
})

test('D1 D2 D5: P0 is sent first, P1 after its verdict', async () => {
  const w = pair()
  const log: string[] = []
  priority(w.db, SECOND, 0)
  await atReady(w, log)
  needsCeo(w.db, plan(w.db, HOLDER))
  expect(waitsFor(w.db, plan(w.db, 1))).toBe(SECOND)
  expect(holder(w.db, plan(w.db, 1))).toBeNull()

  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire(log, w))
  expect(sends(log)).toEqual([expect.stringMatching(/^send .*widget-13-a1-next$/), 'rehearse caliperforge/widget widget-13-a1-next'])
  expect(kindsOf(w.db, SECOND).filter((e) => e.kind.startsWith('fork.')).map((e) => e.kind)).toEqual(['fork.sent', 'fork.judged'])
  expect(plan(w.db, 1)).toMatchObject({ step: 6, wait_reason: 'ready_proof' })
  expect(sent(w, 1)).toBe(false)

  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire(log, w))
  expect(sends(log).at(-1)).toBe('rehearse caliperforge/widget widget-12-a1-next')
  expect(kindsOf(w.db, 1).filter((e) => e.kind.startsWith('fork.')).map((e) => e.kind)).toEqual(['fork.sent', 'fork.judged'])
})

test('D3: at equal priority the lower id is sent first', async () => {
  const w = pair()
  const log: string[] = []
  await atReady(w, log)
  needsCeo(w.db, plan(w.db, HOLDER))
  const running = wire(log, w, runsOn(w.root, 1, 'in_progress', ''))
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, running)
  expect(sent(w, 1)).toBe(true)
  expect(sends(log).filter((l) => l.includes('widget-13-'))).toEqual([])
  expect(plan(w.db, SECOND)).toMatchObject({ step: 6, wait_reason: 'ready_proof' })
  expect(sent(w, SECOND)).toBe(false)
})

test('D5: a holder stuck on CI is freed for its return', async () => {
  const w = pair()
  const log: string[] = []
  await atReady(w, log)
  needsCeo(w.db, plan(w.db, HOLDER))
  const running = wire(log, w, runsOn(w.root, 1, 'in_progress', ''))
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, running)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: srcDir(w.root, 1), encoding: 'utf8' }).trim()
  put(w.root, 1, 'ci.waits', `${head} 45`)
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, running)
  expect(plan(w.db, 1).state).toBe('blocked_on_ceo')
  resume(w.db, 1)
  expect(holder(w.db, plan(w.db, SECOND))).toBeNull()
})

test('D5 D6: a departed holder loses the slot; internal is free', () => {
  const w = pair()
  expect(waitsFor(w.db, plan(w.db, HOLDER))).toBeNull()
  expect(waitsFor(w.db, plan(w.db, 1))).toBe(HOLDER)
  internalPlan(w.db, w.root, 4)
  expect(waitsFor(w.db, plan(w.db, 4))).toBeNull()
  needsCeo(w.db, plan(w.db, HOLDER))
  expect(waitsFor(w.db, plan(w.db, 1))).toBeNull()
  took(w.db, plan(w.db, 1))
  resume(w.db, HOLDER)
  expect(waitsFor(w.db, plan(w.db, HOLDER))).toBe(1)
})
