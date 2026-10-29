import { copyFileSync, cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { tokens } from '../../cli/bench.ts'
import { runLogged } from '../../store/events.ts'
import { addRule, type Db } from '../../store/index.ts'
import { pipeNamed, putPlan } from '../../store/plans.ts'
import { planDir, put } from '../workspace.ts'
import { sessionDir, split } from '../subagents.ts'

const schema = join(import.meta.dirname, '../../schema')
const FIXTURES = join(import.meta.dirname, 'fixtures/subagents')

function seeded(seat: string | null, subagents = true): { dir: string; d: Db; projects: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cf-subagents-'))
  const d = fresh(schema)
  putPlan(d, { id: 1, pipe_id: Number(pipeNamed(d, 'bench')?.id), target_id: null, template: 'bench', state: 'done', queued_at: '2026-10-27', step: 4, retries: 0 })
  put(dir, 1, 'target.yml', 'target: euler-earn-m01\n')
  copyFileSync(join(FIXTURES, 'main.transcript.jsonl'), join(planDir(dir, 1), 'run-1.transcript.jsonl'))
  const projects = join(dir, 'projects')
  mkdirSync(join(projects, '-x/s1'), { recursive: true })
  if (subagents) cpSync(join(FIXTURES, 'subagents'), join(projects, '-x/s1/subagents'), { recursive: true })
  if (seat !== null) {
    addRule(d, { id: seat, kind: 'card', path: `rules/roster/${seat}.yaml`, content_hash: 'a'.repeat(64), loaded_at: '2026-10-27' })
    runLogged(d, { plan: 1, step: 1, seat, rule_hash: 'a'.repeat(64), provider: 'claude-agent-sdk', model: 'm', effort: 'low', exit: 0,
      fired: { usage: { input: 500, cache: 4300, write: 430, output: 28 }, seconds: 0, transcript_path: '/elsewhere/run-1.transcript.jsonl', session: 's1' } })
  }
  return { dir, d, projects }
}

test('D1 split counts main, then each sub-agent by name', () => {
  expect(split(join(FIXTURES, 'main.transcript.jsonl'), FIXTURES)).toEqual([
    { file: 'main.transcript.jsonl', description: 'main', input: 30, write: 300, read: 3000, output: 12, turns: 2 },
    { file: 'agent-a1.jsonl', description: 'read the target', input: 3, write: 30, read: 300, output: 4, turns: 1 },
    { file: 'agent-a2.jsonl', description: 'write the harness', input: 10, write: 100, read: 1000, output: 12, turns: 2 },
  ])
})

test('D2 tokens prints each row and the sum beside the run', () => {
  const { dir, d, projects } = seeded('fizz_generator')
  expect(tokens(d, dir, 1, projects)).toBe([
    'run 1\trun-1.transcript.jsonl\tinput 30\twrite 300\tread 3000\toutput 12\tturns 2\tmain',
    'run 1\tagent-a1.jsonl\tinput 3\twrite 30\tread 300\toutput 4\tturns 1\tread the target',
    'run 1\tagent-a2.jsonl\tinput 10\twrite 100\tread 1000\toutput 12\tturns 2\twrite the harness',
    'run 1\tsum\tinput 43/70\twrite 430/430\tread 4300/4300\toutput 28/28\tgap 27',
  ].map((line) => `${line}\n`).join(''))
})

test('D3 with no subagents folder only the main row is read', () => {
  const { dir, d, projects } = seeded('fizz_lean_generator', false)
  expect(tokens(d, dir, 1, projects)).toBe([
    'run 1\trun-1.transcript.jsonl\tinput 30\twrite 300\tread 3000\toutput 12\tturns 2\tmain',
    'run 1\tsum\tinput 30/70\twrite 300/430\tread 3000/4300\toutput 12/28\tgap 1486',
  ].map((line) => `${line}\n`).join(''))
})

test('D4 sessionDir finds the session under any slug, else null', () => {
  const { projects } = seeded(null)
  mkdirSync(join(projects, '-a'))
  expect(sessionDir(projects, 's1')).toBe(join(projects, '-x/s1'))
  expect(sessionDir(projects, 's2')).toBeNull()
  expect(sessionDir(projects, null)).toBeNull()
})

test('D6 tokens heads each lean run with its phase', () => {
  const { dir, d, projects } = seeded(null, false)
  addRule(d, { id: 'fizz_lean_generator', kind: 'card', path: 'rules/roster/fizz_lean_generator.yaml', content_hash: 'a'.repeat(64), loaded_at: '2026-10-27' })
  for (const [at, phase] of ['context', 'scaffold'].entries()) {
    const n = String(at + 1)
    copyFileSync(join(FIXTURES, 'main.transcript.jsonl'), join(planDir(dir, 1), `run-${n}.transcript.jsonl`))
    cpSync(join(FIXTURES, 'subagents'), join(projects, `-x/s${n}/subagents`), { recursive: true })
    runLogged(d, { plan: 1, step: 1, seat: 'fizz_lean_generator', rule_hash: 'a'.repeat(64), provider: 'claude-agent-sdk', model: 'm', effort: 'low', exit: 0, phase,
      fired: { usage: { input: 500, cache: 4300, write: 430, output: 28 }, seconds: 0, transcript_path: `/elsewhere/run-${n}.transcript.jsonl`, session: `s${n}` } })
  }
  const lines = (head: string, file: string): string[] => [
    `${head}\t${file}\tinput 30\twrite 300\tread 3000\toutput 12\tturns 2\tmain`,
    `${head}\tagent-a1.jsonl\tinput 3\twrite 30\tread 300\toutput 4\tturns 1\tread the target`,
    `${head}\tagent-a2.jsonl\tinput 10\twrite 100\tread 1000\toutput 12\tturns 2\twrite the harness`,
    `${head}\tsum\tinput 43/70\twrite 430/430\tread 4300/4300\toutput 28/28\tgap 27`,
  ]
  expect(tokens(d, dir, 1, projects)).toBe([...lines('run 1 context', 'run-1.transcript.jsonl'), ...lines('run 2 scaffold', 'run-2.transcript.jsonl')]
    .map((line) => `${line}\n`).join(''))
})

test('D5 a plan with no fizz generate run is refused', () => {
  for (const seat of ['house_generator', null]) {
    const { dir, d, projects } = seeded(seat)
    expect(() => tokens(d, dir, 1, projects)).toThrow('plan 1 has no fizz generate run')
  }
})
