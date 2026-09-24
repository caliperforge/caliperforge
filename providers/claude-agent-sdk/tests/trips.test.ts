import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('symlinked checkout reads inside', () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-trips-'))
  const src = join(root, 'real', 'work', '68', 'src')
  mkdirSync(join(src, 'Atelier'), { recursive: true })
  writeFileSync(join(src, 'Atelier', 'ContentView.swift'), '')
  mkdirSync(join(root, 'tick'))
  symlinkSync(join(root, 'real'), join(root, 'tick', '.cf'))
  const cwd = join(root, 'tick', '.cf', 'work', '68', 'src')
  expect(readOutside(cwd, 'Read', { file_path: join(src, 'Atelier', 'ContentView.swift') })).toBeNull()
  expect(readOutside(cwd, 'Read', { file_path: join(src, 'Atelier', 'New.swift') })).toBeNull()
  expect(readOutside(cwd, 'Read', { file_path: join(root, 'real', 'work', '69', 'src', 'x.rb') })).toContain('run.outside_checkout')
})

test('spilled tool result reads', () => {
  const spill = '/Users/m/.claude/projects/-Users-m-cf-v2--cf-work-68-src/44737eb4/tool-results/bvvskcyql.txt'
  expect(readOutside('/Users/m/cf_v2/.cf/work/68/src', 'Read', { file_path: spill })).toBeNull()
})

test('an idle builder trips, a writer or a reviewer does not', () => {
  expect(idle(['Read', 'Write'], false, IDLE_TURNS)).toContain('run.idle')
  expect(idle(['Read', 'Write'], false, IDLE_TURNS - 1)).toBeNull()
  expect(idle(['Read', 'Edit'], true, IDLE_TURNS + 10)).toBeNull()
  expect(idle(['Read', 'Glob', 'Grep'], false, IDLE_TURNS + 10)).toBeNull()
})
