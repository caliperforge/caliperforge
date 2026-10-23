import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Read } from '../../cli/gh.ts'
import { gates } from '../../store/approvals.ts'
import { approved, deliverablesOf, gated } from '../../store/deliverables.ts'
import { ofKind, pointers } from '../../store/events.ts'
import { addRule } from '../../store/index.ts'
import { addPlan, planById } from '../../store/plans.ts'
import { mended } from '../mended.ts'
import { OPERATOR } from '../workspace.ts'

const REPO = 'caliperforge/caliperforge'
const ISSUE = `https://github.com/${REPO}/issues/50`
const SHA = 'a'.repeat(40)
const COMMIT = `https://github.com/${REPO}/commit/${SHA}`
const PULL = `https://github.com/${REPO}/pull/77`
const EVENTS = `api repos/${REPO}/issues/50/events?per_page=100`
const COMPARE = `api repos/${REPO}/compare/main...${SHA}`
const DIGEST = 'd'.repeat(64)
const ALL = { tests_pass: true, byte_identical_elsewhere: true, fork_ci_green: true, bot_clean: true, target_warm: true }

const closedBy = (commit_id: string | null) => [{ event: 'closed', commit_id: 'b'.repeat(40) }, { event: 'reopened', commit_id: null },
  { event: 'referenced', commit_id: 'c'.repeat(40) }, { event: 'closed', commit_id }]

const onMain = (status: string) => ({ [EVENTS]: closedBy(SHA), [COMPARE]: { status } })

function run(answers: Record<string, unknown>, approve = false) {
  const db = fresh(join(import.meta.dirname, '../../schema'))
  addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-10-22', lane: 'machine',
    seat: 'typescript_specialist', origin: ISSUE, step: 6 })
  addRule(db, { id: 'typescript_specialist', kind: 'roster', path: 'seats/typescript_specialist', content_hash: '0'.repeat(64), loaded_at: '2026-10-01' })
  gated(db, { plan: 1, step: 3, seat: 'typescript_specialist', diff_digest: DIGEST, evidence: 'gated' }, ALL)
  if (approve) approved(db, 1, gates(db, 1, DIGEST))
  const all: Record<string, unknown> = { 'issue view': { state: 'CLOSED', comments: [] }, 'pr list': [],
    [`api repos/${REPO}`]: { default_branch: 'main' }, ...answers }
  const log: string[] = []
  const read: Read = (args) => {
    const key = args.slice(0, 2).join(' ')
    log.push(key)
    if (!(key in all)) throw new Error(`no answer for ${args.join(' ')}`)
    if (all[key] instanceof Error) throw all[key]
    return all[key]
  }
  const lines: string[] = []
  mended(db, planById(db, 1), read, lines)
  return { db, log, lines, state: planById(db, 1).state }
}

test.each(['behind', 'identical'])('D1 a close by a commit %s main ends the plan done', (status) => {
  const { db, state } = run(onMain(status))
  expect(state).toBe('done')
  expect(ofKind(db, 'close', 'halted')).toEqual([{ plan: 1, kind: 'close', actor: 'tick', outcome: 'pass', message: `fixed by ${COMMIT}` }])
  expect(pointers(db, 'close')).toEqual([COMMIT])
})

test('D2 the approved deliverable is pushed with the commit URL', () => {
  expect(deliverablesOf(run(onMain('behind'), true).db, 1)).toEqual([{ state: 'pushed', evidence: COMMIT }])
  const { db, state } = run(onMain('behind'))
  expect(state).toBe('done')
  expect(deliverablesOf(db, 1)).toEqual([{ state: 'gated', evidence: 'gated' }])
})

test.each([[closedBy(null)], [[]]])('D3 a close with no commit halts and reads no compare', (events) => {
  const { db, log, state } = run({ [EVENTS]: events }, true)
  expect(state).toBe('halted')
  expect(ofKind(db, 'halted').map((e) => e.message)).toEqual([`${ISSUE} is closed or has lost its lane label`])
  expect(log.filter((l) => l.includes('/compare/'))).toEqual([])
  expect(deliverablesOf(db, 1)).toEqual([{ state: 'approved', evidence: 'gated' }])
})

test.each(['ahead', 'diverged'])('D4 a commit that compares %s halts the plan', (status) => {
  const { db, state } = run(onMain(status), true)
  expect(state).toBe('halted')
  expect(ofKind(db, 'close')).toEqual([])
  expect(deliverablesOf(db, 1)).toEqual([{ state: 'approved', evidence: 'gated' }])
})

test('D5 a merged PR or operator note reads no events or compare', () => {
  for (const answers of [{ 'pr list': [{ url: PULL, title: 'mend it', body: 'Fixes #50' }] },
    { 'issue view': { state: 'CLOSED', comments: [{ author: { login: OPERATOR }, body: `fixed in ${PULL}` }] },
      'pr view': { url: PULL, mergedAt: '2026-10-22T09:00:00Z' } }]) {
    const { db, log, state } = run({ ...onMain('behind'), ...answers })
    expect(state).toBe('done')
    expect(pointers(db, 'close')).toEqual([PULL])
    expect(log.filter((l) => l.startsWith('api '))).toEqual([])
  }
})

test.each([{ read: 'events', key: EVENTS }, { read: 'compare', key: COMPARE }])('D6 a throwing $read read leaves the plan queued', ({ key }) => {
  const { db, lines, state } = run({ ...onMain('behind'), [key]: new Error('HTTP 502\nbody') })
  expect(state).toBe('queued')
  expect(lines).toEqual([`${ISSUE}: HTTP 502`])
  expect(ofKind(db, 'swallowed')).toEqual([{ plan: 1, kind: 'swallowed', actor: 'halt', outcome: 'pass', message: 'HTTP 502' }])
})
