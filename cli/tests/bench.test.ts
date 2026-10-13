import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh, rejects } from '../../checks/sqlite.ts'
import { homeOf } from '../../sequencer/home.ts'
import { dial, lanes } from '../../store/lanes.ts'
import { openPipes, pipeNamed, planById } from '../../store/plans.ts'
import { laneLine } from '../brief.ts'
import type { Read } from '../gh.ts'
import { add } from '../plan.ts'

const schema = join(import.meta.dirname, '../../schema')
const BENCH = 'https://github.com/caliperforge/fuzz-bench/issues/1'
const OURS = 'https://github.com/caliperforge/caliperforge/issues/25'

const canned = (url: string): Read => () =>
  ({ number: Number(url.split('/').at(-1)), title: 'Bench the fuzzers', body: 'the ask', url, labels: [{ name: 'lane:bench' }] })

const root = (): string => mkdtempSync(join(tmpdir(), 'cf-bench-'))

const row = (lane: string): string => `INSERT INTO plans (pipe_id, template, state, queued_at, lane, seat, origin)
  VALUES ((SELECT id FROM pipes WHERE name = 'bench'), 'pr_path', 'queued', '2026-10-13', '${lane}', 'solidity_specialist', '${BENCH}')`

test('D2 plans table takes the bench lane and no unlisted lane', () => {
  expect(rejects(fresh(schema), row('bench'))).toBe(false)
  expect(rejects(fresh(schema), row('solana'))).toBe(true)
})

test('D3 the bench pipe ships on, all day, two wide', () => {
  const d = fresh(schema)
  expect(pipeNamed(d, 'bench')).toMatchObject({ enabled: 1, window_start: '00:00', window_end: '23:59', max_concurrent: 2 })
  expect(openPipes(d, '03:00').map((p) => p.name)).toContain('bench')
})

test('D4 fuzz-bench: bench lane, pipe, solidity seat, home', () => {
  const d = fresh(schema)
  const filed = add(d, root(), 'caliperforge/fuzz-bench#1', 'ceo', undefined, canned(BENCH))
  expect(filed).toMatchObject({ state: 'queued', lane: 'bench', seat: 'solidity_specialist' })
  const plan = planById(d, Number(filed.plan))
  expect(plan.pipe_id).toBe(pipeNamed(d, 'bench')?.id)
  expect(homeOf(plan)).toBe('caliperforge/fuzz-bench')
})

test('D5 a bench issue off fuzz-bench is refused', () => {
  const filed = add(fresh(schema), root(), 'caliperforge/caliperforge#25', 'ceo', undefined, canned(OURS))
  expect(filed.state).toBe('refused')
  expect(filed.why).toContain('the bench lane builds in caliperforge/fuzz-bench')
})

test('D7 brief counts the bench pipe at 03:00', () => {
  const d = fresh(schema)
  dial(d, 1, '2026-10-13')
  expect(laneLine(lanes(d, '03:00'))).toMatch(/^lanes 0\/2 live\/open/)
})
