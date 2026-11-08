import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { planRow } from '../runner/index.ts'
import { decided, decisions, type Decision } from './decisions.ts'
import { migrate, open, type Db } from './index.ts'
import { get } from './lanes.ts'
import { addPlan, planById, planRows, waiting, type Wait } from './plans.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function before(version: string): Db {
  const old = mkdtempSync(join(tmpdir(), `cf-${version}-`))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < version)) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const d = open(':memory:')
  migrate(d, old)
  return d
}

function latest(): Db {
  const d = open(':memory:')
  migrate(d, join(root, 'schema'))
  return d
}

function issued(d: Db, pipe: number): number {
  return addPlan(d, { pipe_id: pipe, target_id: null, template: 'research', state: 'queued', queued_at: '2026-11-08T00:00:00.000Z',
    lane: 'research', seat: 'research', origin: 'https://github.com/o/r/issues/1', step: 0 })
}

const row = (plan: number, wait_reason: Decision['wait_reason']): Decision =>
  ({ plan, step: 0, wait_reason, verb: 'next', why: 'waits on its job', evidence: null, tokens: 0 })

it('plans and decisions store long_job', () => {
  const d = latest()
  const plan = planRow(d)
  waiting(d, [{ plan, why: 'long_job' }])
  expect(planById(d, plan).wait_reason).toBe('long_job')
  decided(d, row(plan, 'long_job'))
  expect(decisions(d, plan)).toEqual([row(plan, 'long_job')])
})

it('an unlisted wait reason is refused by both tables', () => {
  const d = latest()
  const plan = planRow(d)
  const why = 'long_jobs' as Wait
  expect(() => { waiting(d, [{ plan, why }]) }).toThrow(/CHECK constraint/)
  expect(() => decided(d, row(plan, why))).toThrow(/CHECK constraint/)
})

it('research.long_job_seconds reads 14400', () => {
  expect(get(latest(), 'research.long_job_seconds')).toBe('14400')
})

it('0141 keeps a 0140 plan and decision, one plan per issue', () => {
  const d = before('0141')
  const plan = issued(d, planById(d, planRow(d)).pipe_id)
  waiting(d, [{ plan, why: 'bench_night' }])
  decided(d, row(plan, 'bench_night'), '2026-11-08 00:00:00')
  const plans = planRows(d)
  expect(migrate(d, join(root, 'schema'))).toEqual(['0141_long_job.sql', '0142_refuzz_night.sql', '0143_bench_report_only.sql'])
  expect(planRows(d)).toEqual(plans)
  expect(decisions(d, plan)).toEqual([row(plan, 'bench_night')])
  expect(() => issued(d, planById(d, plan).pipe_id)).toThrow(/UNIQUE/)
})
