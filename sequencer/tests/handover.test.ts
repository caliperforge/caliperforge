import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { handover } from '../handover.ts'

function repo(files: Record<string, string>): { dir: string; base: string; write: (p: string, b: string) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cf-handover-'))
  const run = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  const write = (path: string, body: string): void => {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  run('init', '-q', '-b', 'main')
  for (const [path, body] of Object.entries(files)) write(path, body)
  run('add', '-A')
  run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base')
  return { dir, base: run('rev-parse', 'HEAD').trim(), write }
}

const pad = (n: number): string => [...Array(n).keys()].map((i) => `    let x${String(i)} = ${String(i)};`).join('\n')

const RUST = `// Verifies a payment challenge.\npub fn verify(c: &Challenge) -> bool {\n${pad(40)}\n    c.amount > 0\n}\n`

test('context', () => {
  const r = repo({ 'rust/src/verify.rs': RUST, 'rust/src/lib.rs': '//! pay-kit core\npub mod verify;\n' })
  r.write('rust/src/verify.rs', RUST.replace('c.amount > 0', 'c.amount > 0 && !c.expired()'))
  const { context } = handover(r.dir, r.base)
  expect(context).toContain('pub fn verify(c: &Challenge) -> bool {')
  expect(context).toContain('let x0 = 0;')
  expect(context).toContain('+    c.amount > 0 && !c.expired()')
})

test('map', () => {
  const r = repo({ 'rust/src/verify.rs': RUST, 'rust/src/lib.rs': '//! pay-kit core\npub mod verify;\n', 'README.md': '# pay-kit\n' })
  r.write('rust/src/verify.rs', RUST.replace('> 0', '>= 1'))
  expect(handover(r.dir, r.base).map).toBe(
    'rust/src/\n    lib.rs  2 lines — pay-kit core\n  * verify.rs  44 lines — Verifies a payment challenge.')
})

test('cap', () => {
  const big = [...Array(2000).keys()].map((i) => `line ${String(i)}`).join('\n')
  const r = repo({ 'data.txt': `${big}\n` })
  r.write('data.txt', `${big.replaceAll('line', 'row')}\n`)
  expect(handover(r.dir, r.base).context).toBeUndefined()
})

test('clean', () => {
  const r = repo({ 'a.ts': 'export const a = 1\n' })
  expect(handover(r.dir, r.base)).toEqual({})
})

test('pragma', () => {
  const r = repo({
    'lib/gate.rb': '# frozen_string_literal: true\n\n# Gate builder.\nclass Gate; end\n',
    'lib/config.lua': '--[[\nBoot-time configuration.\n]]\nreturn {}\n',
  })
  r.write('lib/gate.rb', '# frozen_string_literal: true\n\n# Gate builder.\nclass Gate; def a; end; end\n')
  expect(handover(r.dir, r.base).map).toBe(
    'lib/\n    config.lua  4 lines — Boot-time configuration.\n  * gate.rb  4 lines — Gate builder.')
})
