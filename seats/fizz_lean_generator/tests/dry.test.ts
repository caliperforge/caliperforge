import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import { planDir, put } from '../../../sequencer/workspace.ts'
import { eventsAfter, runRows } from '../../../store/events.ts'
import type { Db } from '../../../store/index.ts'
import { pipeNamed, putPlan } from '../../../store/plans.ts'
import { dried } from '../../../templates/dry.ts'
import { compiled } from '../../../templates/extract.ts'
import { trackers } from '../../../templates/probes.ts'
import { reach } from '../../../templates/reach.ts'
import { smoke } from '../../../templates/smoke.ts'
import type { Suite } from '../../../templates/suite.ts'

const EMPTY = vi.hoisted((): Suite => ({ deployed: [], actors: [], handlers: [], standIns: [], probes: [], trackers: [], build: { command: null, via_ir: null, optimizer: null } }))

vi.mock('../../../templates/suite.ts', async (importOriginal) => ({ ...await importOriginal<object>(), suite: vi.fn(() => EMPTY) }))

vi.mock('../../../templates/smoke.ts', async (importOriginal) => ({ ...await importOriginal<object>(), smoke: vi.fn(() => ({ results: [], note: null, cache: null, clamped: [] })) }))

vi.mock('../../../templates/reach.ts', async (importOriginal) => ({ ...await importOriginal<object>(), reach: vi.fn(() => []) }))

vi.mock('../../../templates/probes.ts', async (importOriginal) => ({ ...await importOriginal<object>(), trackers: vi.fn(() => new Map()) }))

vi.mock('../../../templates/extract.ts', async (importOriginal) => ({ ...await importOriginal<object>(), compiled: vi.fn(() => []) }))

const repo = join(import.meta.dirname, '../../..')
const AT = '2026-11-04T00:00:00.000Z'
const META = 'test/fizz/fizz_data'
const SECTIONS = (names: string[]): string => names.map((name) => `\n## ${name}\n\n- none\n`).join('')
const HANDED = `\n## Reads\n\n- x-ray/x-ray.md, Vault.deposit — the entry point to call\n${SECTIONS(['Signatures', 'Guards', 'Roles', 'Limits'])}`
const SRC = {
  [`${META}/handoff/context.md`]: `phase: context\nnext: scaffold\nmode: automatic\nagent_model: opus\n${HANDED}${SECTIONS(['Conversion points', 'Aggregates', 'Not tracked'])}`,
  [`${META}/handoff/scaffold.md`]: `phase: scaffold\nnext: coverage\n${HANDED}\n## Stand-ins\n\n- MockStrategy | limits: max interest 1e15 per call\n`,
  'test/fizz/Properties.sol': 'function invariant_held() public {}\n',
}
const PASS = "## Share-Converted Comparisons\n\n```sh\ngrep -rn 'assertEq(.*convertToAssets' {SUITE_DIR}\n```\n\n## Unbounded Stand-ins\n\n```sh\ngrep -rl 'contract Mock' {SUITE_DIR}\n```\n"
const NEEDS = (path: string): string => `cannot run: needs ${path}`
const ROWS = [
  ['context', 'handoff', 'pass'], ['context', 'ast', 'pass'], ['context', 'grade', 'cannot run: target.yml has no fix'],
  ['context', 'map', NEEDS(`${META}/entry-point-selection.json`)],
  ['scaffold', 'handoff', 'pass'], ['scaffold', 'ast', 'pass'], ['scaffold', 'layer', 'cannot run: needs the map as the phase found it'],
  ['scaffold', 'suite', 'pass'], ['scaffold', 'grade', NEEDS('test/fizz/handlers')], ['scaffold', 'smoke', 'pass'], ['scaffold', 'critic.stand_in', 'pass'],
  ['coverage', 'handoff', NEEDS(`${META}/handoff/coverage.md`)], ['coverage', 'probe readings', NEEDS(`${META}/corpus_medusa/call_sequences`)],
  ['coverage', 'reach', NEEDS(`${META}/corpus_medusa/coverage/lcov.info`)], ['coverage', 'boundary', NEEDS(`${META}/corpus_medusa/coverage/lcov.info`)],
  ['coverage', 'grade', NEEDS(`${META}/handoff/coverage.md`)],
  ['invariants', 'handoff', NEEDS(`${META}/handoff/invariants.md`)], ['invariants', 'plan', NEEDS(`${META}/handoff/plan.md`)],
  ['invariants', 'duplicate', NEEDS(`${META}/reports/invariants-global-property-implementer.md`)], ['invariants', 'critic.share_converted', 'pass'],
  ['end', 'count', 'pass'],
]

function written(dir: string, files: Record<string, string>): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

const fizz = (): string => written(mkdtempSync(join(tmpdir(), 'cf-dry-fizz-')), { 'references/critic-pass.md': PASS })

function planted(files: Record<string, string> = {}, src = 'src'): { db: Db; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'cf-dry-'))
  cpSync(join(repo, 'seats/fizz_lean_generator/skill'), join(root, 'seats/fizz_lean_generator/skill'), { recursive: true })
  const db = fresh(join(repo, 'schema'))
  putPlan(db, { id: 1, pipe_id: Number(pipeNamed(db, 'bench')?.id), target_id: null, template: 'bench', state: 'queued', queued_at: AT, step: 1, retries: 0 })
  written(join(planDir(root, 1), src), { ...SRC, ...files })
  return { db, root }
}

const table = (rows: string[][]): string => ['plan 1', ...rows.map((row) => row.join('\t')), ''].join('\n')

test('every check prints in phase order, missing inputs cannot run', () => {
  const { db, root } = planted()
  expect(dried(db, root, 1, fizz())).toBe(table(ROWS))
})

test('a throwing check refuses and every later row still prints', () => {
  const { db, root } = planted({ [`${META}/corpus_medusa/call_sequences/1.json`]: '[]' })
  vi.mocked(trackers).mockImplementationOnce(() => { throw new Error('forge inspect Harness exited 1: boom\nmore') })
  const rows = ROWS.map((row) => row[1] === 'probe readings' ? [...row.slice(0, 2), 'refuse throw | forge inspect Harness exited 1: boom'] : row)
  expect(dried(db, root, 1, fizz())).toBe(table(rows))
  expect(eventsAfter(db, 0).filter((e) => e.kind === 'swallowed').map((e) => [e.actor, e.message])).toEqual([['bench', 'forge inspect Harness exited 1: boom']])
})

test('a hung smoke prints a refusal row', () => {
  const { db, root } = planted()
  const note = 'smoke: medusa ran past --timeout 120 + 60 s and its process group was killed; last 40 lines:\nline 50'
  vi.mocked(smoke).mockReturnValueOnce({ rule: 'smoke.hung', note })
  const rows = ROWS.map((row) => row[1] === 'smoke' ? [...row.slice(0, 2), `refuse smoke.hung | ${note}`] : row)
  expect(dried(db, root, 1, fizz())).toBe(table(rows))
})

test('a smoke with slither off passes with its note', () => {
  const { db, root } = planted()
  const note = 'smoke: slither . --ignore-compile --print echidna --json - ran past its 1200 s limit; medusa ran with slither off'
  vi.mocked(smoke).mockReturnValueOnce({ results: [], note, cache: null, clamped: [] })
  const rows = ROWS.map((row) => row[1] === 'smoke' ? [...row.slice(0, 2), `pass | ${note}`] : row)
  expect(dried(db, root, 1, fizz())).toBe(table(rows))
  expect(eventsAfter(db, 0).filter((e) => e.kind === 'bench.dry').map((e) => e.outcome)).toEqual(['pass'])
})

test('a smoke with a slither cache names it in its row', () => {
  const { db, root } = planted()
  const cache = `cache/fizz-slither-${'a'.repeat(64)}.json`
  vi.mocked(smoke).mockReturnValueOnce({ results: [], note: null, cache, clamped: [] })
  const rows = ROWS.map((row) => row[1] === 'smoke' ? [...row.slice(0, 2), `pass | slither cache ${cache}`] : row)
  expect(dried(db, root, 1, fizz())).toBe(table(rows))
})

test('an unlocated item refuses the reach and boundary rows', () => {
  const corpus = `${META}/corpus_medusa`
  const { db, root } = planted({ [`${corpus}/call_sequences/1.json`]: '[]', [`${corpus}/coverage/lcov.info`]: '', [`${corpus}/coverage/revert_report.json`]: '{}' })
  const key = 'Selected entry points C.transfer(address to)'
  vi.mocked(reach).mockReturnValueOnce([{ key, met: false, cells: ['at: none'], note: `${key}: no at`, reverts: [], located: false, misread: false }])
  const refused = `refuse reach.unlocated | 1 row(s) have no at: <file> L<start>-L<end> in map.md: ${key}`
  const now = new Map([['probe readings', 'pass'], ['reach', refused], ['boundary', refused]])
  const rows = ROWS.map(([phase = '', check = '', result = '']) => [phase, check, now.get(check) ?? result])
  expect(dried(db, root, 1, fizz())).toBe(table(rows))
})

const tree = (dir: string): [string, string][] => readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort()
  .map((path) => [path, statSync(join(dir, path)).isFile() ? readFileSync(join(dir, path), 'utf8') : ''])

test.each(['src', 'src.stopped'])('%s is byte for byte unchanged, map.md included', (src) => {
  const { db, root } = planted({ [`${META}/handoff/map.md`]: '## Guards\n\n- none\n' }, src)
  const before = tree(join(planDir(root, 1), src))
  dried(db, root, 1, fizz())
  expect(tree(join(planDir(root, 1), src))).toEqual(before)
  expect(readdirSync(planDir(root, 1))).toEqual([src])
})

test("a second pass starts from the first pass's out/ and cache/", () => {
  const built = ['out/V.json', 'out/build-info/a.output.json', 'cache/files.json', 'cache/fizz-build-info.json']
  const { db, root } = planted(Object.fromEntries(built.map((path) => [path, 'src'])))
  vi.mocked(compiled).mockImplementationOnce((dir) => {
    for (const path of built) writeFileSync(join(dir, path), 'built')
    return []
  })
  dried(db, root, 1, fizz())
  const seen: string[] = []
  vi.mocked(compiled).mockImplementationOnce((dir) => {
    seen.push(...built.map((path) => readFileSync(join(dir, path), 'utf8')))
    return []
  })
  dried(db, root, 1, fizz())
  expect(seen).toEqual(built.map(() => 'built'))
})

test("--suite lays the suite's files and the plan's own handoff", () => {
  const { db, root } = planted({ 'test/fizz/Old.sol': 'contract Old {}\n', [`${META}/entry-point-selection.json`]: '{}' })
  putPlan(db, { id: 2, pipe_id: Number(pipeNamed(db, 'bench')?.id), target_id: null, template: 'bench', state: 'done', queued_at: AT, step: 4, retries: 0 })
  put(root, 2, 'target.yml', 'target: euler-earn-m01\ngenerator: fizz_lean\n')
  put(root, 2, 'generate.json', JSON.stringify({ suite: 'test/fizz', tokens: 1, seconds: 1 }))
  written(join(planDir(root, 2), 'fuzz-bench/suites/fizz_lean/euler-earn-m01'), { 'Properties.sol': SRC['test/fizz/Properties.sol'],
    'fizz_data/handoff/map.md': 'theirs\n', 'root/foundry.toml': '[profile.default]\n' })
  const seen: { suite: string[]; toml: boolean }[] = []
  vi.mocked(compiled).mockImplementationOnce((dir) => {
    seen.push({ suite: readdirSync(join(dir, 'test/fizz'), { recursive: true, encoding: 'utf8' }).sort(), toml: existsSync(join(dir, 'foundry.toml')) })
    return []
  })
  expect(dried(db, root, 1, fizz(), 2).split('\n')[0]).toBe("plan 1 with plan 2's suite")
  expect(seen).toEqual([{ suite: ['Properties.sol', 'fizz_data', 'fizz_data/entry-point-selection.json', 'fizz_data/handoff',
    'fizz_data/handoff/context.md', 'fizz_data/handoff/scaffold.md'], toml: true }])
})

test('a dry pass logs one bench.dry event, writes no run', () => {
  const { db, root } = planted()
  dried(db, root, 1, fizz())
  vi.mocked(compiled).mockReturnValueOnce([{ rule: 'handoff.ast', note: 'context: forge build --ast failed: boom' }])
  expect(dried(db, root, 1, fizz())).toContain('context\tast\trefuse handoff.ast | context: forge build --ast failed: boom\n')
  expect(eventsAfter(db, 0)).toEqual(['pass', 'refuse'].map((outcome) => ({ plan: 1, kind: 'bench.dry', actor: 'bench', outcome, message: 'plan 1', pointer: null, run: null })))
  expect(runRows(db)).toEqual([])
})
