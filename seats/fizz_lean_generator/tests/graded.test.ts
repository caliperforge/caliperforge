import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { put } from '../../../sequencer/workspace.ts'
import type { Extracted } from '../../../templates/extract.ts'
import { fixed, graded, listed, type Touched, touched } from '../../../templates/graded.ts'

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
  const extracted: Extracted = { sources: {}, modifiers: [], checks: [], conversions: [], aggregates: [],
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
})

test('listed reads scalar, comma, flow and block lists alike', () => {
  const both = ['src/A.sol', 'src/B.sol']
  expect(listed('files: src/A.sol\n')).toEqual(['src/A.sol'])
  expect(listed('files: src/A.sol, src/B.sol\n')).toEqual(both)
  expect(listed('files: [src/A.sol, src/B.sol]\n')).toEqual(both)
  expect(listed('files:\n  - src/A.sol\n  - src/B.sol\nrepo: o/r\n')).toEqual(both)
  for (const empty of ['repo: o/r\n', 'files: []\n', 'files:\nrepo: o/r\n']) expect(listed(empty)).toEqual([])
})
