import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Db } from '../../store/index.ts'
import { dial } from '../../store/lanes.ts'
import { allPlans, pipeNamed, planById, putPlan, type PlanRow } from '../../store/plans.ts'
import { scratch } from '../../templates/bench.ts'
import { dry } from '../index.ts'
import { route } from '../next.ts'
import { kernel, mapOf } from '../steps.ts'
import { get, git, maybe, planDir, put, srcDir } from '../workspace.ts'

const schema = join(import.meta.dirname, '../../schema')

/** 07:00 in Guatemala, when every lane's window opens. */
const OPENS = new Date('2026-09-18T13:00:00.000Z')

const AT = '2026-09-18T13:00:00.000Z'

function queued(db: Db, template: PlanRow['template']): void {
  putPlan(db, { id: 1, pipe_id: Number(pipeNamed(db, 'bench')?.id), target_id: null, template, state: 'queued', queued_at: AT, step: 0, retries: 0 })
}

test('a bench plan is stored and parsed', () => {
  const db = fresh(schema)
  queued(db, 'bench')
  expect(allPlans(db)).toMatchObject([{ id: 1, template: 'bench', state: 'queued', step: 0 }])
})

test('the bench map lists checkout, generate, score', () => {
  expect(mapOf('bench').steps.map((s) => s.name)).toEqual(['checkout', 'generate', 'score'])
})

test('the bench pipe routes its plan to step 0', () => {
  const db = fresh(schema)
  dial(db, 3, AT)
  queued(db, 'bench')
  expect(dry(db, OPENS).would).toContainEqual({ pipe: 'bench', plan: 1, step: 0, template: 'bench' })
  expect(route(db, planById(db, 1), OPENS)).toEqual({ fire: mapOf('bench').at(0) })
})

test('an unknown template and a step past score are refused', () => {
  const db = fresh(schema)
  expect(() => { queued(db, 'nonsense' as PlanRow['template']) }).toThrow(/CHECK constraint failed/)
  expect(() => mapOf('bench').at(3)).toThrow('bench has no step 3')
})

const FINDING = 'convertToShares rounds the share price down'

function commit(dir: string, path: string, body: string, message: string): string {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), body)
  git(dir, ['add', '-A'])
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message])
  return git(dir, ['rev-parse', 'HEAD']).trim()
}

/** `<root>/remotes/org/fixture`: c1, then c2, the fix, which adds the report. */
function fixture(body = 'export const vault = 1\n', message = 'vault'): { root: string; c1: string; c2: string } {
  const root = mkdtempSync(join(tmpdir(), 'cf-bench-'))
  const dir = join(root, 'remotes/org/fixture')
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  const c1 = commit(dir, 'src/vault.ts', body, message)
  const c2 = commit(dir, 'audits/report-m01.md', `# M-01\n\n${FINDING}\n`, 'fix: share price rounds down')
  mkdirSync(join(root, '.cf'))
  writeFileSync(join(root, '.cf/git-base'), join(root, 'remotes'))
  return { root, c1, c2 }
}

function target(root: string, keys: Record<string, string>): void {
  put(root, 1, 'target.yml', Object.entries(keys).map(([k, v]) => `${k}: ${v}`).join('\n'))
}

function benched(): PlanRow {
  const db = fresh(schema)
  queued(db, 'bench')
  return planById(db, 1)
}

test('kernel checks out the pre-fix sha and writes checkout.json', () => {
  const { root, c1, c2 } = fixture()
  const fix = c2.slice(0, 12)
  target(root, { repo: 'org/fixture', fix, pre_fix: `${fix}^`, report: 'audits/report-m01.md', finding: FINDING })
  const db = fresh(schema)
  queued(db, 'bench')
  expect(kernel(db, root, planById(db, 1))).toEqual({ outcome: 'pass', spans: [], note: `checkout.json written at ${c1.slice(0, 12)}` })
  const dir = srcDir(root, 1)
  expect(git(dir, ['rev-parse', 'HEAD']).trim()).toBe(c1)
  expect(spawnSync('git', ['cat-file', '-e', `${c2}^{commit}`], { cwd: dir }).status).not.toBe(0)
  expect(JSON.parse(get(root, 1, 'checkout.json'))).toEqual({ repo: 'org/fixture', fix, pre_fix: c1 })
  expect(existsSync(join(planDir(root, 1), 'resolve.git'))).toBe(false)
})

test('a fix the scratch tree holds is refused', () => {
  const { root, c1 } = fixture()
  target(root, { repo: 'org/fixture', fix: c1, pre_fix: c1 })
  expect(scratch(root, benched())).toMatchObject({ outcome: 'refuse', spans: ['bench.fix_reachable'] })
  expect(maybe(root, 1, 'checkout.json')).toBeNull()
})

test('a pre-fix file holding the finding text is refused', () => {
  const { root, c2 } = fixture(`// ${FINDING}\n`)
  target(root, { repo: 'org/fixture', fix: c2, pre_fix: `${c2}^`, finding: FINDING })
  expect(scratch(root, benched())).toMatchObject({ outcome: 'refuse', spans: ['bench.seen'], note: `"${FINDING}" is in the file src/vault.ts` })
})

test('a pre-fix commit message naming the report is refused', () => {
  const { root, c2 } = fixture(undefined, 'see report-m01.md')
  target(root, { repo: 'org/fixture', fix: c2, pre_fix: `${c2}^`, report: 'audits/report-m01.md' })
  expect(scratch(root, benched())).toMatchObject({ outcome: 'refuse', spans: ['bench.seen'], note: '"report-m01.md" is in a commit message' })
})

test('a missing or incomplete target.yml is refused', () => {
  const { root, c2 } = fixture()
  expect(scratch(root, benched())).toMatchObject({ outcome: 'refuse', spans: ['target.yml'] })
  target(root, { repo: 'org/fixture', fix: c2 })
  expect(scratch(root, benched())).toEqual({ outcome: 'refuse', spans: ['target.yml'], note: 'target.yml has no pre_fix' })
})
