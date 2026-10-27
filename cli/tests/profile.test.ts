import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { planDir, put } from '../../sequencer/workspace.ts'
import { allEvents, runLogged } from '../../store/events.ts'
import { addRule, type Db } from '../../store/index.ts'
import { pipeNamed, planById, putPlan, type PlanRow } from '../../store/plans.ts'
import { profiled } from '../../templates/profile.ts'
import { profile } from '../bench.ts'

const schema = join(import.meta.dirname, '../../schema')
const FIXTURE = join(import.meta.dirname, '../../store/fixtures/profiled.transcript.jsonl')

function benched(template: PlanRow['template'] = 'bench', ran = true): { dir: string; d: Db } {
  const dir = mkdtempSync(join(tmpdir(), 'cf-profile-'))
  const d = fresh(schema)
  putPlan(d, { id: 1, pipe_id: Number(pipeNamed(d, 'bench')?.id), target_id: null, template, state: 'done', queued_at: '2026-10-27', step: 4, retries: 0 })
  put(dir, 1, 'target.yml', 'target: euler-earn-m01\n')
  addRule(d, { id: 'fizz_generator', kind: 'card', path: 'rules/roster/fizz_generator.yaml', content_hash: 'a'.repeat(64), loaded_at: '2026-10-27' })
  if (ran) runLogged(d, { plan: 1, step: 1, seat: 'fizz_generator', rule_hash: 'a'.repeat(64), provider: 'claude-agent-sdk', model: 'm', effort: 'low', exit: 0,
    fired: { usage: { input: 0, cache: 0, output: 0 }, seconds: 0, transcript_path: '/elsewhere/run-1.transcript.jsonl' } })
  return { dir, d }
}

test('D1 profile prints the six lines in order', () => {
  const { dir, d } = benched()
  copyFileSync(FIXTURE, join(planDir(dir, 1), 'run-1.transcript.jsonl'))
  expect(profile(d, dir, 1)).toBe([
    'tokens 765  cash $0.43  main 87%',
    'context 110 -> 301',
    'filled tool_use 243 44%',
    'filled Read 154 28%',
    'filled thinking 62 11%',
    'filled Agent 60 11%',
    'filled text 29 5%',
    'calls Read 2',
    'calls Agent 1',
    'agents 1',
    'read 2 /repo/medusa.log',
  ].map((line) => `${line}\n`).join(''))
})

test('D2 two Read calls under one message id both count', () => {
  expect(profiled(FIXTURE)).toMatch(/^calls Read 2\n.*^read 2 \/repo\/medusa\.log\n/ms)
})

test('D3 one id counts once at its largest, sub-agents not main', () => {
  expect(profiled(FIXTURE).split('\n')[0]).toBe('tokens 765  cash $0.43  main 87%')
})

function refused(dir: string, d: Db, why: string): void {
  const before = [planById(d, 1), readdirSync(planDir(dir, 1))]
  expect(() => profile(d, dir, 1)).toThrow(why)
  expect([planById(d, 1), readdirSync(planDir(dir, 1))]).toEqual(before)
  expect(allEvents(d)).toEqual([])
}

test('D4 a plan that is not bench is refused', () => {
  const { dir, d } = benched('research')
  refused(dir, d, 'plan 1 is not a bench plan')
})

test('D4 a bench plan with no generate run is refused', () => {
  const { dir, d } = benched('bench', false)
  refused(dir, d, 'plan 1 has no generate transcript')
})

test('D4 a generate transcript gone from disk is refused', () => {
  const { dir, d } = benched()
  refused(dir, d, 'plan 1 has no generate transcript')
})
