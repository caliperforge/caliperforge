import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh, rejects } from '../../checks/sqlite.ts'
import { homeOf, kernelPlan } from '../../sequencer/home.ts'
import { internalBranch, titleOf } from '../../sequencer/workspace.ts'
import { openPipes, PlanRow } from '../../store/plans.ts'
import type { Db } from '../../store/index.ts'
import type { Read } from '../gh.ts'
import { add } from '../plan.ts'

const schema = join(import.meta.dirname, '../../schema')
const HOOKS = 'https://github.com/caliperforge/v4-hook-index/issues/1'
const OURS = 'https://github.com/caliperforge/caliperforge/issues/25'

const canned = (url: string, labels: string[]): Read => () =>
  ({ number: Number(url.split('/').at(-1)), title: 'Index the hooks', body: 'the ask', url, labels: labels.map((name) => ({ name })) })

const root = (): string => mkdtempSync(join(tmpdir(), 'cf-uniswap-'))

const planOf = (d: Db, id: number | null): PlanRow => PlanRow.parse(d.prepare('SELECT * FROM plans WHERE id = ?').get(id))

const row = (lane: string): string => `INSERT INTO plans (pipe_id, template, state, queued_at, lane, seat, origin)
  VALUES ((SELECT id FROM pipes WHERE name = 'uniswap'), 'pr_path', 'queued', '2026-09-27', '${lane}', 'python_specialist', '${HOOKS}')`

test('the plans table takes the uniswap lane and no lane it does not list', () => {
  const d = fresh(schema)
  expect(rejects(d, row('uniswap'))).toBe(false)
  expect(rejects(fresh(schema), row('solana'))).toBe(true)
})

test('a hook-index issue files on the uniswap lane, pipe and python seat, and branches in its home', () => {
  const d = fresh(schema)
  const at = root()
  const filed = add(d, at, 'caliperforge/v4-hook-index#1', 'ceo', undefined, canned(HOOKS, ['lane:uniswap']))
  expect(filed).toMatchObject({ state: 'queued', lane: 'uniswap', seat: 'python_specialist' })
  const plan = planOf(d, filed.plan)
  expect(d.prepare('SELECT name FROM pipes WHERE id = ?').get(plan.pipe_id)).toEqual({ name: 'uniswap' })
  expect([homeOf(plan), kernelPlan(plan)]).toEqual(['caliperforge/v4-hook-index', false])
  expect(internalBranch(plan.id, String(titleOf(at, plan.id)))).toBe(`p${String(plan.id)}-index-the-hooks`)
})

test('a uniswap issue off the hook index is refused', () => {
  const filed = add(fresh(schema), root(), 'caliperforge/caliperforge#25', 'ceo', undefined, canned(OURS, ['lane:uniswap']))
  expect(filed.state).toBe('refused')
  expect(filed.why).toContain('the uniswap lane builds in caliperforge/v4-hook-index')
})

test('with the lane off a uniswap plan is not picked', () => {
  const d = fresh(schema)
  add(d, root(), 'caliperforge/v4-hook-index#1', 'ceo', undefined, canned(HOOKS, ['lane:uniswap']))
  expect(openPipes(d, '12:00').map((p) => p.name)).not.toContain('uniswap')
  d.prepare("UPDATE pipes SET enabled = 1 WHERE name = 'uniswap'").run()
  expect(openPipes(d, '12:00').map((p) => p.name)).toContain('uniswap')
})
