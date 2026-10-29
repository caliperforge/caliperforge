import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { unclamped } from '../clamped.ts'

const RUN = join(import.meta.dirname, '..', 'run.ts')

const FIXTURES = join(import.meta.dirname, 'fixtures')

const run = (...args: string[]) => spawnSync(process.execPath, [RUN, ...args], { encoding: 'utf8' })

const contract = (...lines: string[]): string => `contract C {\n${lines.join('\n')}\n}\n`

const GLOBAL = contract('function property_solvent() public view returns (bool) { return true; }')

function suite(properties?: string, handler?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fizz-clamped-'))
  mkdirSync(join(dir, 'handlers'))
  if (properties !== undefined) writeFileSync(join(dir, 'Properties.sol'), properties)
  if (handler !== undefined) writeFileSync(join(dir, 'handlers', 'VaultHandler.sol'), handler)
  return dir
}

test('D1 a clamped variant passes with no output', () => {
  expect(unclamped(join(FIXTURES, 'clamped'))).toEqual([])
  const ran = run(join(FIXTURES, 'clamped'))
  expect(ran.status).toBe(0)
  expect(ran.stdout).toBe('')
  expect(ran.stderr).toBe('')
})

test('D2 only the raw handler exits 1 naming it', () => {
  const ran = run(join(FIXTURES, 'raw'))
  expect(ran.status).toBe(1)
  expect(ran.stderr).toBe('publicAllocator_reallocateTo: no publicAllocator_reallocateTo_clamped handler\n')
})

test('D3 variants and lone clamped handlers are not listed', () => {
  expect(unclamped(suite(GLOBAL, contract(
    'function vault_deposit(uint256 a) public {}',
    'function vault_deposit_twoSources(uint256 a) public {}',
    'function vault_withdraw_clamped(uint256 a) public {}',
  )))).toEqual(['vault_deposit'])
})

test('D4 inline assertions target only their callers', () => {
  const properties = contract('function _check_shares(uint256 before) internal view {}')
  expect(unclamped(suite(properties, contract(
    'function vault_deposit(uint256 a) public { _check_shares(a); }',
    'function vault_withdraw(uint256 a) public { vault.withdraw(a); }',
  )))).toEqual(['vault_deposit'])
})

test('D5 non-entry functions are never listed', () => {
  expect(unclamped(suite(GLOBAL, contract(
    'function vault_a() internal {}',
    'function vault_b() private {}',
    'function vault_c() public view returns (uint256) { return 1; }',
    'function vault_d() external pure returns (uint256) { return 1; }',
    '// function vault_e() public {}',
    '/* function vault_f() public {} */',
    'function vault_g() external {}',
  )))).toEqual(['vault_g'])
})

test.each([
  { given: 'no Properties.sol', dir: () => suite(undefined, GLOBAL), missing: 'Properties.sol' },
  { given: 'no handler', dir: () => suite(GLOBAL), missing: join('handlers', '*Handler.sol') },
])('D6 $given exits 1 naming the missing path', ({ dir, missing }) => {
  const at = dir()
  const ran = run(at)
  expect(ran.status).toBe(1)
  expect(ran.stderr).toBe(`${join(at, missing)} is missing\n`)
})

test('D6 no argument prints the usage line', () => {
  const ran = run()
  expect(ran.status).toBe(1)
  expect(ran.stderr).toBe('usage: node tools/fizz-clamped/run.ts <suite dir>\n')
})
