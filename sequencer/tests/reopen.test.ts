import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { checkout, cloned, maybe, planDir, srcDir } from '../workspace.ts'
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

const stale = (root: string): string[] => readdirSync(planDir(root, 1)).filter((n) => n.startsWith('src.stale-'))

test('a leftover src with no base.sha is moved aside and cloned fresh', () => {
  const w = world()
  writeFileSync(join(srcDir(w.root, 1), 'leftover.txt'), 'partial\n')

  const { dir } = checkout(w.root, 1, 'acme/widget', BRANCH)
  expect(cloned(dir)).toBe(true)
  expect(maybe(w.root, 1, 'base.sha')).not.toBeNull()
  const aside = stale(w.root)
  expect(aside).toHaveLength(1)
  expect(existsSync(join(planDir(w.root, 1), aside[0] ?? '', 'leftover.txt'))).toBe(true)
})

test('a src with a base.sha is reused with its untracked files', () => {
  const w = world()
  const first = checkout(w.root, 1, 'acme/widget', BRANCH)
  writeFileSync(join(first.dir, 'untracked.txt'), 'kept\n')

  expect(checkout(w.root, 1, 'acme/widget', BRANCH).base).toBe(first.base)
  expect(existsSync(join(first.dir, 'untracked.txt'))).toBe(true)
  expect(stale(w.root)).toEqual([])
})
