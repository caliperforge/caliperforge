import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { holds, tried } from '../workspace.ts'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-holds-'))
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  writeFileSync(join(dir, 'a'), 'a\n')
  git('add', 'a')
  git('commit', '-q', '-m', 'a')
  return dir
}

const MISSING = 'c25df73dec9cf17243c4b119960f288f013f2ecd'

test('a re-cut checkout lacks the commit judged earlier',() => {
  const dir = repo()
  expect(holds(dir, tried(dir, ['rev-parse', 'HEAD'])?.trim() ?? '')).toBe(true)
  expect(holds(dir, MISSING)).toBe(false)
})

test('D2 tried: stdout on exit 0, null otherwise, throws unspawned', () => {
  const dir = repo()
  expect(tried(dir, ['rev-parse', 'HEAD'])).toMatch(/^[0-9a-f]{40}\n$/)
  expect(tried(dir, ['cat-file', '-e', MISSING])).toBeNull()
  expect(() => tried(join(dir, 'absent'), ['rev-parse', 'HEAD'])).toThrow(/ENOENT/)
})
