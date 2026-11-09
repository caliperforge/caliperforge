import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import { pipeNamed, putPlan } from '../../../store/plans.ts'
import { compiled } from '../../../templates/extract.ts'
import { held, sampled } from '../../../templates/probes.ts'
import { planted } from '../../../templates/rooted.ts'
import { rows } from '../../../templates/slices.ts'
import { suite } from '../../../templates/suite.ts'

const repo = join(import.meta.dirname, '../../..')
const machine = resolve(repo, '../../../..')
const suites = join(machine, '.cf/work/2223/fuzz-bench/suites/fizz_lean/euler-earn-m01')

test.runIf(process.env.CF_BENCH_LIVE === '1' && existsSync(suites))('every Limits and Conversion row a 2223 probe cites is read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-regrade-2223-'))
  planted(machine, 2223, dir, { suites, target: 'fizz' })
  expect(compiled(dir)).toEqual([])
  const db = fresh(join(repo, 'schema'))
  putPlan(db, { id: 2223, pipe_id: Number(pipeNamed(db, 'bench')?.id), target_id: null, template: 'bench', state: 'done', queued_at: '2026-11-04T00:00:00.000Z', step: 4, retries: 0 })
  const { probes } = suite(dir)
  const read = held(dir, probes, sampled(db, 2223, dir, 'test/fizz', join(suites, 'fizz_data/corpus_medusa')))
  const mapped = rows(readFileSync(join(suites, 'fizz_data/handoff/map.md'), 'utf8'))
  const named = new Set(['Limits', 'Conversion points'].flatMap((section) => (mapped.get(section) ?? []).map((r) => r.name)))
  const cited = [...new Set(probes.flatMap((p) => p.cites !== null && named.has(p.cites) ? [p.cites] : []))]
  expect([cited.length > 0, cited.filter((cite) => read[cite] === undefined)]).toEqual([true, []])
}, 3_600_000)
