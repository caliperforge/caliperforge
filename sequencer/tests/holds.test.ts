import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { holds } from '../workspace.ts'

test('a re-cut checkout does not hold the commit an earlier round judged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-holds-'))
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  writeFileSync(join(dir, 'a'), 'a\n')
  git('add', 'a')
  git('commit', '-q', '-m', 'a')
  expect(holds(dir, git('rev-parse', 'HEAD'))).toBe(true)
  expect(holds(dir, 'c25df73dec9cf17243c4b119960f288f013f2ecd')).toBe(false)
})
