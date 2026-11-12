import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import type { Provider } from '../../../providers/kind.ts'
import { mapOf } from '../../../sequencer/steps.ts'
import { git, maybe, put } from '../../../sequencer/workspace.ts'
import { eventsAfter } from '../../../store/events.ts'
import { pipeNamed, planById, putPlan } from '../../../store/plans.ts'
import { CEILING } from '../../../templates/bench.ts'
import type { Extracted } from '../../../templates/extract.ts'
import { fixed, graded, listed, type Touched, touched } from '../../../templates/graded.ts'
import { grader } from '../../../templates/missed.ts'
import { type Bench, START } from '../../../templates/phases.ts'

const META = 'test/fizz/fizz_data'
const VAULT = 'src/Vault.sol'
const T: Touched = { functions: [{ file: VAULT, start: 28, end: 33, name: 'Vault.setFee' }], state: ['Vault.fee', 'Vault.cap'] }
const HANDLER = 'contract VaultHandler {\n  function setFee(uint256 f) public { vault.setFee(f); }\n  function currentFee() public view returns (uint256) { return vault.fee(); }\n}\n'

function written(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-graded-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

const fn = (name: string, file: string, start: number, end: number): Extracted['signatures'][number] => ({ file, start, end, name, signature: '', modifiers: [] })

const variable = (name: string, line: number, constant = false): Extracted['state'][number] => ({ file: VAULT, start: line, end: line, name, constant, writers: [], writes: [] })

test('touched skips hunks outside bodies, keeps named state', () => {
  const extracted: Extracted = { sources: {}, modifiers: [], checks: [], conversions: [], aggregates: [], inherited: [],
    signatures: [fn('Vault.deposit', VAULT, 20, 25), fn('Vault.setFee', VAULT, 28, 33), fn('Other.run', 'src/Other.sol', 25, 35)],
    state: [variable('Vault.cap', 3), variable('Vault.fee', 4), variable('Vault.MAX', 5, true), variable('Vault.idle', 6)] }
  const diff = ['diff --git a/src/Vault.sol b/src/Vault.sol', 'index 1111111..2222222 100644', '--- a/src/Vault.sol', '+++ b/src/Vault.sol',
    '@@ -12,0 +13 @@ contract Vault {', '+    uint256 public extra = cap + MAX;', '@@ -30 +31 @@', '-        fee = 1;', '+        fee = 2;', ''].join('\n')
  expect(touched(diff, extracted)).toEqual({ functions: T.functions, state: ['Vault.cap', 'Vault.fee'] })
})

test('context hits on a touched function and state, else misses', () => {
  const hit = written({ [`${META}/handoff/context.md`]: '- Vault.setFee — sets the fee\n', [`${META}/handoff/map.md`]: '- fee | at: src/Vault.sol L4-L4\n' })
  expect(graded('context', hit, T)).toBe('hit Vault.setFee, Vault.fee')
  expect(graded('context', written({ [`${META}/handoff/context.md`]: '- Vault.deposit\n' }), T)).toBe('miss: context names none of Vault.setFee')
})

test('suite hits through a handler getter, else misses', () => {
  const read = 'function invariant_fee() public { assert(handler.currentFee() <= 1e18); }\n'
  expect(graded('suite', written({ 'test/fizz/handlers/VaultHandler.sol': HANDLER, 'test/fizz/Properties.sol': read }), T)).toBe('hit Vault.setFee, Vault.fee')
  expect(graded('suite', written({ 'test/fizz/handlers/VaultHandler.sol': HANDLER, 'test/fizz/Properties.sol': 'function invariant_held() public {}\n' }), T))
    .toBe('miss: suite names none of Vault.fee, Vault.cap')
})

test('suite counts option and calldata calls, not mentions', () => {
  const suite = (body: string, name: string): string => graded('suite', written({ 'test/fizz/handlers/H.sol': `contract H {\n${body}\n}\n` }),
    { functions: [{ file: VAULT, start: 1, end: 1, name }], state: [] })
  const allocator = '  function reallocateTo(uint256 supplyId) public {\n    publicAllocator.reallocateTo{value: value}(vault, withdrawals, IERC4626(supplyId));\n  }'
  const actor = '  function reallocateTo(uint256 supplyId) public {\n    Actor(payable(actor)).callWithValue(address(publicAllocator), value, abi.encodeCall(publicAllocator.reallocateTo, (vault, withdrawals, IERC4626(supplyId))));\n  }'
  for (const body of [allocator, actor]) expect(suite(body, 'PublicAllocator.reallocateTo')).toBe('hit PublicAllocator.reallocateTo')
  for (const call of ['target.fn{value: v}(a);', 'target.fn\n  { value: v,\n    gas: g }\n  (a);', 'abi.encodeCall(target.fn, (a));', 'abi.encodeWithSelector(target.fn.selector, a);',
    'address(t).call(abi.encodeWithSelector(X.fn.selector));', 'abi.encodeWithSignature("fn(uint256)", a);']) expect(suite(call, 'X.fn')).toBe('hit X.fn')
  for (const mention of ['// target.fn(a);', '/* target.fn(a); */', 'string s = "target.fn(a)";', 'string s = \'target.fn(a)\';', 'target.fnX(a);', 'target.fnX{value: v}(a);',
    '// abi.encodeCall(target.fn, (a));', '/* target.fn.selector */', 'string s = \'abi.encodeWithSignature("fn(uint256)")\';', '// abi.encodeWithSignature("fn(uint256)", a);',
    'abi.encodeWithSignature("fnX(uint256)", a);', 'target.fnX.selector;', 'abi.encodeCall(target.other, (a.fn, b));'])
    expect(suite(mention, 'X.fn')).toBe('miss: suite names none of X.fn')
})

test('suite grading skips directories named .sol', () => {
  const read = 'function invariant_fee() public { assert(handler.currentFee() <= 1e18); }\n'
  expect(graded('suite', written({ 'test/fizz/handlers/VaultHandler.sol': HANDLER, 'test/fizz/handlers/Foo.sol/Foo.json': '{}', 'test/fizz/Properties.sol': read }), T))
    .toBe('hit Vault.setFee, Vault.fee')
  expect(graded('suite', written({ 'test/fizz/handlers/VaultHandler.sol': HANDLER, 'test/fizz/Properties.sol/x.json': '{}' }), { ...T, state: [] })).toBe('hit Vault.setFee')
})

test('coverage hits a counted line in the span, misses count 0', () => {
  const lcov = (n: number): string => written({ [`${META}/corpus_medusa/coverage/lcov.info`]: `SF:/w/src/Vault.sol\nDA:27,5\nDA:29,${String(n)}\nend_of_record\n` })
  expect(graded('coverage', lcov(3), T)).toBe('hit Vault.setFee')
  expect(graded('coverage', lcov(0), T)).toBe('miss: coverage names none of Vault.setFee')
})

test('an empty half is skipped; with none left it cannot run', () => {
  const stateless: Touched = { ...T, state: [] }
  const grades = [
    graded('context', written({ [`${META}/handoff/context.md`]: '- Vault.setFee\n' }), stateless),
    graded('context', written({ [`${META}/handoff/context.md`]: '- Vault.deposit\n' }), stateless),
    graded('suite', written({ 'test/fizz/handlers/VaultHandler.sol': HANDLER }), stateless),
    graded('coverage', written({}), { ...T, functions: [] }),
    graded('context', written({}), { functions: [], state: [] }),
  ]
  expect(grades).toEqual(['hit Vault.setFee', 'miss: context names none of Vault.setFee', 'hit Vault.setFee',
    'cannot run: the fix touches no functions', 'cannot run: the fix touches no functions or state'])
  expect(grades.filter((grade) => grade.endsWith('none of '))).toEqual([])
})

test('a target.yml with no fix cannot run', () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-graded-'))
  put(root, 1, 'target.yml', 'repo: o/r\npre_fix: abc\nfiles: [src/Vault.sol]\n')
  expect(fixed(root, 1, root)).toBe('cannot run: target.yml has no fix')
  expect(maybe(root, 1, 'touched.json')).toBeNull()
})

const ALLOCATOR = 'src/PublicAllocator.sol'
const allocator = (fee: string, body: string): string => `contract PublicAllocator {\n  uint256 public fee${fee};\n  function reallocateTo(uint256 a) public {\n    fee = ${body};\n  }\n}\n`

function commit(repo: string, text: string): string {
  writeFileSync(join(repo, ALLOCATOR), text)
  git(repo, ['add', '-A'])
  git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'allocator'])
  return git(repo, ['rev-parse', 'HEAD']).trim()
}

test('a new grader keeps touched functions after out/ loses src', () => {
  const home = mkdtempSync(join(tmpdir(), 'cf-graded-'))
  const repo = join(home, 'remotes/o/r')
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(join(home, '.cf'))
  git(repo, ['init', '-q'])
  const source = allocator('', 'a + 1')
  const [pre, fix, outside] = [commit(repo, allocator('', 'a')), commit(repo, source), commit(repo, allocator(' = 1', 'a + 1'))]
  writeFileSync(join(home, '.cf/git-base'), join(home, 'remotes'))
  const start = source.indexOf('function')
  const fn = { nodeType: 'FunctionDefinition', id: 3, name: 'reallocateTo', kind: 'function', visibility: 'public', implemented: true, src: `${String(start)}:${String(source.indexOf('}') + 1 - start)}:0`,
    parameters: { parameters: [] }, returnParameters: { parameters: [] }, modifiers: [] }
  const ast = { nodeType: 'SourceUnit', id: 1, absolutePath: ALLOCATOR, src: '0:0:0', nodes: [{ nodeType: 'ContractDefinition', id: 2, name: 'PublicAllocator', src: '0:0:0', nodes: [fn] }] }
  const dir = written({ [ALLOCATOR]: source, 'out/PublicAllocator.sol/PublicAllocator.json': JSON.stringify({ ast }), [`${META}/handoff/coverage.md`]: '',
    [`${META}/corpus_medusa/coverage/lcov.info`]: `SF:/w/${ALLOCATOR}\nDA:4,3\nend_of_record\n` })
  const db = fresh(join(import.meta.dirname, '../../../schema'))
  const provider: Provider = { name: 'claude-agent-sdk', fire: () => Promise.reject(new Error('a grade fires no seat')) }
  const grade = (plan: number): void => {
    grader({ db, root: home, plan: planById(db, plan), step: mapOf('bench').at(1), provider, name: 'fizz_lean_generator', dir, tmp: dir, granted: [],
      walls: { usd: 100, input: 0, cache_write: 0, cache_write_1h: 0, cache_read: 0, output: 0 }, ceiling: CEILING } satisfies Bench, dir)('coverage', START)
  }
  for (const [plan, from, to] of [[1, pre, fix], [2, fix, outside]] as const) {
    putPlan(db, { id: plan, pipe_id: Number(pipeNamed(db, 'bench')?.id), target_id: null, template: 'bench', state: 'queued', queued_at: '2026-11-07T00:00:00.000Z', step: 1, retries: 0 })
    put(home, plan, 'target.yml', `repo: o/r\npre_fix: ${from}\nfix: ${to}\nfiles: [${ALLOCATOR}]\n`)
    grade(plan)
  }
  rmSync(join(dir, 'out'), { recursive: true })
  mkdirSync(join(dir, 'out/FuzzTester.sol'), { recursive: true })
  writeFileSync(join(dir, 'out/FuzzTester.sol/FuzzTester.json'), JSON.stringify({ ast: { nodeType: 'SourceUnit', id: 9, absolutePath: 'test/fizz/FuzzTester.sol', src: '0:0:0', nodes: [] } }))
  grade(1)
  grade(2)
  const hit = 'coverage: hit PublicAllocator.reallocateTo'
  const none = 'coverage: cannot run: the fix touches no functions'
  expect(eventsAfter(db, 0).filter((e) => e.kind === 'bench.grade').map((e) => e.message)).toEqual([hit, none, hit, none])
})

test('listed reads scalar, comma, flow and block lists alike', () => {
  const both = ['src/A.sol', 'src/B.sol']
  expect(listed('files: src/A.sol\n')).toEqual(['src/A.sol'])
  expect(listed('files: src/A.sol, src/B.sol\n')).toEqual(both)
  expect(listed('files: [src/A.sol, src/B.sol]\n')).toEqual(both)
  expect(listed('files:\n  - src/A.sol\n  - src/B.sol\nrepo: o/r\n')).toEqual(both)
  for (const empty of ['repo: o/r\n', 'files: []\n', 'files:\nrepo: o/r\n']) expect(listed(empty)).toEqual([])
})
