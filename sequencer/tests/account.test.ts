import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { built } from '../../store/deliverables.ts'
import { addRule } from '../../store/index.ts'
import { allPlans, planById, putPlan, type PlanRow } from '../../store/plans.ts'
import { addAccount, putTarget, targetRows } from '../../store/targets.ts'
import { ideas, log, reading } from '../../templates/account.ts'
import { route } from '../next.ts'
import { mapOf } from '../steps.ts'
import { maybe, put } from '../workspace.ts'
import { world, type World } from './world.ts'

const DAY = '2026-10-14'

const AT = `${DAY}T00:00:00.000Z`

const FILE = 'accounts/evm-security.md'

const accounted = (ask = '# Weekly\n\n**Account:** evm-security\n'): World => {
  const w = world()
  putPlan(w.db, { id: 2, pipe_id: 1, target_id: null, template: 'account', state: 'queued', queued_at: AT, step: 0, retries: 0 })
  put(w.root, 2, 'ask.md', ask)
  cpSync(join(import.meta.dirname, '../../accounts'), join(w.root, 'accounts'), { recursive: true })
  return w
}

const idea = (repo: string, issue: number): object => ({ repo, issue, why: 'it fits', size: 'small' })

test('D1: an account plan is stored and parsed', () => {
  const w = accounted()
  expect(allPlans(w.db).at(-1)).toMatchObject({ id: 2, template: 'account', state: 'queued' })
  expect(() => {
    putPlan(w.db, { id: 3, pipe_id: 1, target_id: null, template: 'nonsense' as PlanRow['template'], state: 'queued', queued_at: AT, step: 0, retries: 0 })
  }).toThrow(/CHECK constraint failed/)
})

test('D2: the account map, while route still says no_step_map', () => {
  const w = accounted()
  expect(mapOf('account').steps.map((s) => s.name)).toEqual(['read', 'brief', 'check', 'ideas', 'log'])
  expect(mapOf('account').at(1)).toMatchObject({ seat: 'account_lead', fires: 'seat', runs: 'account_lead' })
  expect(route(w.db, planById(w.db, 2), new Date())).toEqual({ wait: 'no_step_map', on: null })
})

test('D3: reading.md holds the file and our rows on its repos', () => {
  const w = accounted()
  addAccount(w.db, { id: 2, repo: 'pashov/skills', measured_at: DAY, maintainers: 1, doors: 1, last_outsider_merge: DAY,
    open_pr_age_p50_days: 1, cross_repo_activity: 1, pulse: 'warm', evidence: 'https://github.com/pashov/skills' })
  putTarget(w.db, { id: 2, account_id: 2, repo: 'pashov/skills', issue_no: 5, named_merger: '', state: 'ready', evidence_measured_at: DAY,
    evidence: 'https://github.com/pashov/skills/issues/5' })
  putPlan(w.db, { id: 3, pipe_id: 1, target_id: null, template: 'pr_path', state: 'done', queued_at: AT, step: 0, retries: 0,
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/fuzz-bench/issues/9' })
  addRule(w.db, { id: 'typescript_specialist', kind: 'roster', path: 'seats/typescript_specialist', content_hash: '0'.repeat(64), loaded_at: DAY })
  built(w.db, { plan: 3, step: 2, seat: 'typescript_specialist', diff_digest: '0'.repeat(64), evidence: 'https://github.com/caliperforge/fuzz-bench/pull/10' })
  expect(reading(w.db, w.root, planById(w.db, 2))).toMatchObject({ outcome: 'pass' })
  const md = maybe(w.root, 2, 'reading.md') ?? ''
  expect(md.startsWith(readFileSync(join(w.root, FILE), 'utf8').trimEnd())).toBe(true)
  expect(md).toContain('"repo":"pashov/skills","issue_no":5')
  expect(md).toContain('"origin":"https://github.com/caliperforge/fuzz-bench/issues/9"')
  expect(md).toContain('"evidence":"https://github.com/caliperforge/fuzz-bench/pull/10"')
  expect(md).not.toContain('acme/widget')
})

test('D4: reading refuses with no Account line or no file', () => {
  const w = accounted('# Weekly\n')
  expect(reading(w.db, w.root, planById(w.db, 2))).toMatchObject({ outcome: 'refuse', spans: ['ask.md'] })
  put(w.root, 2, 'ask.md', '**Account:** nobody\n')
  expect(reading(w.db, w.root, planById(w.db, 2))).toMatchObject({ outcome: 'refuse', spans: ['accounts/nobody.md'] })
  expect(maybe(w.root, 2, 'reading.md')).toBeNull()
})

test('D5: a new idea lands ready and a parked one stays parked', () => {
  const w = accounted()
  putTarget(w.db, { id: 2, account_id: 1, repo: 'acme/widget', issue_no: 13, named_merger: '', state: 'parked', evidence_measured_at: DAY,
    evidence: 'https://github.com/acme/widget/issues/13' })
  put(w.root, 2, 'ideas.json', JSON.stringify([idea('acme/widget', 13), idea('acme/widget', 14)]))
  expect(ideas(w.db, w.root, planById(w.db, 2))).toMatchObject({ outcome: 'pass' })
  expect(targetRows(w.db).slice(1)).toMatchObject([{ issue_no: 13, state: 'parked' },
    { account_id: 1, repo: 'acme/widget', issue_no: 14, state: 'ready', evidence: 'https://github.com/acme/widget/issues/14' }])
})

test('D5: an idea on a repo with no account writes nothing', () => {
  const w = accounted()
  put(w.root, 2, 'ideas.json', JSON.stringify([idea('acme/widget', 14), idea('nobody/here', 1)]))
  expect(ideas(w.db, w.root, planById(w.db, 2))).toMatchObject({ outcome: 'refuse', note: 'no accounts row for nobody/here' })
  expect(targetRows(w.db)).toHaveLength(1)
})

test('D6: log adds new dated rows at the end of ## Log, once', () => {
  const w = accounted()
  const path = join(w.root, FILE)
  writeFileSync(path, '# A\n\n## Log\n\n- 2026-10-01 old\n\n## Rules\n\n- one\n')
  put(w.root, 2, 'answer.md', '## Their world\n\nnot a row\n- 2026-10-01 old\n- 2026-10-14 new\n- undated row\n')
  expect(log(w.root, planById(w.db, 2))).toMatchObject({ outcome: 'pass' })
  const once = '# A\n\n## Log\n\n- 2026-10-01 old\n- 2026-10-14 new\n\n## Rules\n\n- one\n'
  expect(readFileSync(path, 'utf8')).toBe(once)
  expect(log(w.root, planById(w.db, 2))).toMatchObject({ outcome: 'pass' })
  expect(readFileSync(path, 'utf8')).toBe(once)
})

test('D6: an account file with no ## Log is refused', () => {
  const w = accounted()
  writeFileSync(join(w.root, FILE), '# A\n')
  put(w.root, 2, 'answer.md', '- 2026-10-14 new\n')
  expect(log(w.root, planById(w.db, 2))).toMatchObject({ outcome: 'refuse', spans: [FILE] })
})
