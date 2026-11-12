import { join } from 'node:path'
import { expect, test } from 'vitest'
import { credit } from '../../../cli/bench.ts'
import { seat } from '../../../runner/rules.ts'
import type { Db } from '../../../store/index.ts'
import { pipeNamed, putPlan } from '../../../store/plans.ts'
import { runTokens } from '../../../store/runs.ts'
import { firing, START, type Sum } from '../../../templates/phases.ts'
import { benched } from './benched.ts'

const { manifest, hash } = seat(join(import.meta.dirname, '../../..'), 'fizz_lean_generator')
const CREDITED = new Map([[14554, 2.1442092000000006], [14560, 4.770059400000002], [14561, 2.137264]])
const RUNS = [...Array(15).keys()].map((i) => 14554 + i)
const SUM: Sum = { ...START, usd: 33.1212625, runs: RUNS }
const INVARIANTS = 7.560571099999999

function ran(db: Db, plan: number, id: number, usd: number): void {
  db.exec(`INSERT INTO runs (id, plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_read_tokens, output_tokens, seconds, exit, transcript_path, cost_usd)
    VALUES (${String(id)}, ${String(plan)}, 1, 'fizz_lean_generator', '${'0'.repeat(64)}', 'claude-agent-sdk', 'm', 'high', 0, 0, 0, 0, 0, 'x.transcript.jsonl', ${String(usd)})`)
}

function replayed() {
  const walls: number[] = []
  const { db, bench } = benched((packet) => {
    walls.push(packet.cost_wall?.usd ?? NaN)
    return { usage: { input: 0, cache: 0, output: 1, cost: INVARIANTS } }
  })
  for (const id of RUNS) ran(db, 1, id, CREDITED.get(id) ?? (SUM.usd - 9.0515326) / 12)
  const fire = (sum: Sum) => firing({ ...bench, walls: { ...bench.walls, usd: 40 } }, manifest, hash)('Generate.', 'Generate.', sum, 'invariants')
  return { db, walls, fire }
}

test('credited runs stay on the wall; usd stays gross', async () => {
  const { db, walls, fire } = replayed()
  credit(db, 1, [...CREDITED.keys()], 'machine bugs')
  const sum = await fire(SUM) as Sum
  expect(walls[0]).toBeCloseTo(40 - 33.1212625, 9)
  expect(sum.runs).toEqual([...RUNS, 14569])
  expect(sum.usd).toBeCloseTo(40.6818336, 9)
  expect(sum.machine).toBeCloseTo(9.0515326, 9)
  expect(sum.usd - sum.machine).toBeCloseTo(31.630301, 9)
  expect(sum.usd - sum.machine).toBeLessThan(40)
})

test('a credit outside the sum or plan takes nothing off', async () => {
  const { db, walls, fire } = replayed()
  putPlan(db, { id: 2, pipe_id: Number(pipeNamed(db, 'bench')?.id), target_id: null, template: 'bench', state: 'queued', queued_at: '2026-11-02T00:00:00.000Z', step: 1, retries: 0 })
  ran(db, 1, 14535, 3)
  ran(db, 2, 14600, 5)
  credit(db, 1, [14535], 'thrown round')
  credit(db, 2, [14600], 'another plan')
  const sum = await fire({ ...SUM, runs: [...RUNS, 14600] }) as Sum
  expect(walls[0]).toBeCloseTo(40 - (SUM.usd + 3), 9)
  expect(sum.machine).toBe(0)
})

test('a plan at the wall is held and fires nothing', async () => {
  const walls: number[] = []
  const { db, bench } = benched((packet) => {
    walls.push(packet.cost_wall?.usd ?? NaN)
    return {}
  })
  ran(db, 1, 1, 45)
  ran(db, 1, 2, 15)
  const got = await firing({ ...bench, walls: { ...bench.walls, usd: 60 } }, manifest, hash)('Generate.', 'Generate.', START, 'invariants')
  expect(got).toEqual({ outcome: 'needs_ceo', spans: ['bench.cost_wall'], note: 'plan 1 spent $60.00 gross against the $60 bench.cost_wall_usd wall' })
  expect(walls).toEqual([])
  expect(runTokens(db, 1).map((r) => r.id)).toEqual([1, 2])
})
