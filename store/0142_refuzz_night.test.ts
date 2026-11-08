import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { planRow } from '../runner/index.ts'
import { benchWait } from '../sequencer/night.ts'
import { steps } from '../templates/bench.ts'
import { migrate, open, type Db } from './index.ts'
import { hours } from './lanes.ts'
import { dropPipes, inWindow, pipeNamed, planById, type PipeRow } from './plans.ts'

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

const refuzz = (d: Db): PipeRow => pipeNamed(d, 'refuzz') ?? expect.fail('no refuzz pipe')

it('0142 puts a drifted refuzz window back to 22:00-06:00', () => {
  const d = before('0142')
  hours(d, refuzz(d).id, '00:00', '23:59')
  const drifted = refuzz(d)
  expect(migrate(d, join(root, 'schema'))).toEqual(['0142_refuzz_night.sql'])
  expect(refuzz(d)).toEqual({ ...drifted, window_start: '22:00', window_end: '06:00' })
})

it('a fresh database keeps refuzz at 22:00-06:00, width 1', () => {
  expect(refuzz(latest())).toMatchObject({ enabled: 1, window_start: '22:00', window_end: '06:00', max_concurrent: 1 })
})

it('refuzz is shut at 15:00, so a bench score waits on night', () => {
  const d = before('0142')
  hours(d, refuzz(d).id, '00:00', '23:59')
  migrate(d, join(root, 'schema'))
  expect(inWindow(refuzz(d), '15:00')).toBe(false)
  const plan = { ...planById(d, planRow(d)), template: 'bench' as const }
  const score = steps.find((s) => s.name === 'score') ?? expect.fail('no score step')
  expect(benchWait(d, plan, score, new Date('2026-11-07T21:00:00Z'))).toBe('bench_night')
})

it('0142 leaves the bench pipe at 00:00-23:59', () => {
  const d = before('0142')
  const bench = pipeNamed(d, 'bench')
  expect(bench).toMatchObject({ window_start: '00:00', window_end: '23:59' })
  migrate(d, join(root, 'schema'))
  expect(pipeNamed(d, 'bench')).toEqual(bench)
})

it('0142 inserts no refuzz row where there is none', () => {
  const d = before('0142')
  dropPipes(d, ['refuzz'])
  migrate(d, join(root, 'schema'))
  expect(pipeNamed(d, 'refuzz')).toBeNull()
})
