import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { self } from '../index.ts'

const root = join(import.meta.dirname, '../../..')

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'ignore' })
}

/** A clone cut from main: the rails file the ceilings come from, committed, with origin/main at that commit. */
function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-tight-'))
  mkdirSync(join(dir, 'rules'))
  cpSync(join(root, 'rules/rails.yaml'), join(dir, 'rules/rails.yaml'))
  git(dir, ['init', '-q'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'main'])
  git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  mkdirSync(join(dir, 'src'))
  return dir
}

const fn = (lines: number): string =>
  `export function f(n: number): number {\n${[...Array(lines).keys()].map((i) => `  n += ${String(i)}`).join('\n')}\n  return n\n}\n`

test('an uncommitted function past the ceiling is refused', () => {
  const dir = checkout()
  writeFileSync(join(dir, 'src/long.ts'), fn(60))
  const verdict = self(dir)
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.spans[0]).toMatch(/^src\/long\.ts:1 /)
})

test('a short one passes', () => {
  const dir = checkout()
  writeFileSync(join(dir, 'src/short.ts'), fn(3))
  expect(self(dir).outcome).toBe('pass')
})
