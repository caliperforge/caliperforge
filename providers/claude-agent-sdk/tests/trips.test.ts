import { expect, test } from 'vitest'

const { IDLE_TURNS, idle, readOutside } = await import('../index.ts')

test('reads outside the checkout are refused', () => {
  const cwd = '/Users/m/cf_v2/.cf/work/70/src'
  expect(readOutside(cwd, 'Read', { file_path: '/Users/m/.cargo/registry/src/lib.rs' })).toContain('run.outside_checkout')
  expect(readOutside(cwd, 'Grep', { pattern: 'x', path: '../../70' })).toContain('run.outside_checkout')
  expect(readOutside(cwd, 'Glob', { pattern: '**/*.rs', path: '/Users/m/.cargo' })).toContain('run.outside_checkout')
})

test('reads inside the checkout pass', () => {
  const cwd = '/Users/m/cf_v2/.cf/work/70/src'
  expect(readOutside(cwd, 'Read', { file_path: `${cwd}/crates/core/src/types.rs` })).toBeNull()
  expect(readOutside(cwd, 'Read', { file_path: 'crates/core/src/types.rs' })).toBeNull()
  expect(readOutside(cwd, 'Grep', { pattern: 'x' })).toBeNull()
  expect(readOutside(cwd, 'Glob', { pattern: '*', path: cwd })).toBeNull()
  expect(readOutside(cwd, 'Write', { file_path: '/etc/x' })).toBeNull()
})

test('an idle builder trips, a writer or a reviewer does not', () => {
  expect(idle(['Read', 'Write'], false, IDLE_TURNS)).toContain('run.idle')
  expect(idle(['Read', 'Write'], false, IDLE_TURNS - 1)).toBeNull()
  expect(idle(['Read', 'Edit'], true, IDLE_TURNS + 10)).toBeNull()
  expect(idle(['Read', 'Glob', 'Grep'], false, IDLE_TURNS + 10)).toBeNull()
})
