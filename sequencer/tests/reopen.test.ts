import { execFileSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { checkout, srcDir } from '../workspace.ts'
import { world } from './world.ts'

const BRANCH = 'widget-12-a1'

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
}

test('a reaped plan with a pushed branch reopens on that branch and keeps its base', () => {
  const w = world()
  const first = checkout(w.root, 1, 'acme/widget', BRANCH)
  writeFileSync(join(first.dir, 'added.ts'), 'export const added = 1\n')
  git(first.dir, ['add', '-A'])
  git(first.dir, ['commit', '-qm', 'round one'])
  git(first.dir, ['push', '-q', 'origin', BRANCH])
  rmSync(srcDir(w.root, 1), { recursive: true, force: true })

  const again = checkout(w.root, 1, 'acme/widget', BRANCH)
  expect(existsSync(join(again.dir, 'added.ts'))).toBe(true)
  expect(again.base).toBe(first.base)
})

test('a reaped plan that never pushed is cut fresh from main', () => {
  const w = world()
  const first = checkout(w.root, 1, 'acme/widget', BRANCH)
  rmSync(srcDir(w.root, 1), { recursive: true, force: true })
  expect(checkout(w.root, 1, 'acme/widget', BRANCH).base).toBe(first.base)
})
