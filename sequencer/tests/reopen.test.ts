import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { checkout, cloned, diffOf, drop, maybe, planDir, PR_BRANCH, PR_HEAD, put, recut, srcDir } from '../workspace.ts'
import { world } from './world.ts'

const BRANCH = 'widget-12-a1'

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
}

test('a reaped plan with a pushed branch reopens on it, same base', () => {
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

test('an unpushed branch reopens on the fork branch of pr.head', () => {
  const w = world()
  const first = checkout(w.root, 1, 'acme/widget', BRANCH)
  writeFileSync(join(first.dir, 'added.ts'), 'export const added = 1\n')
  git(first.dir, ['add', '-A'])
  git(first.dir, ['commit', '-qm', 'round one'])
  git(first.dir, ['push', '-q', 'origin', 'HEAD:asm/1-a3', 'HEAD:asm/1-a3-next'])
  const sha = git(first.dir, ['rev-parse', 'HEAD']).trim()
  put(w.root, 1, PR_HEAD, `${sha} ${sha}\n`)
  rmSync(srcDir(w.root, 1), { recursive: true, force: true })

  const again = checkout(w.root, 1, 'acme/widget', BRANCH)
  expect(again.branch).toBe('asm/1-a3')
  expect(git(again.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('asm/1-a3')
  expect(existsSync(join(again.dir, 'added.ts'))).toBe(true)
  expect(again.base).toBe(first.base)
})

test('a pr.head on no fork branch throws and keeps base.sha', () => {
  const w = world()
  const first = checkout(w.root, 1, 'acme/widget', BRANCH)
  put(w.root, 1, PR_HEAD, `${first.base} ${first.base}\n`)
  rmSync(srcDir(w.root, 1), { recursive: true, force: true })

  expect(() => checkout(w.root, 1, 'acme/widget', BRANCH)).toThrow(`pr.head ${first.base.slice(0, 12)}`)
  expect(() => checkout(w.root, 1, 'acme/widget', BRANCH)).toThrow(`pr.head ${first.base.slice(0, 12)}`)
  expect(cloned(srcDir(w.root, 1))).toBe(false)
  expect(maybe(w.root, 1, 'base.sha')).toBe(`${first.base}\n`)
})

test('a pr.head never pushed throws on every later checkout', () => {
  const w = world()
  const first = checkout(w.root, 1, 'acme/widget', BRANCH)
  git(first.dir, ['commit', '-q', '--allow-empty', '-m', 'never pushed'])
  const sha = git(first.dir, ['rev-parse', 'HEAD']).trim()
  put(w.root, 1, PR_HEAD, `${sha} ${sha}\n`)
  rmSync(srcDir(w.root, 1), { recursive: true, force: true })

  expect(() => checkout(w.root, 1, 'acme/widget', BRANCH)).toThrow(sha.slice(0, 12))
  expect(() => checkout(w.root, 1, 'acme/widget', BRANCH)).toThrow(sha.slice(0, 12))
  expect(cloned(srcDir(w.root, 1))).toBe(false)
  expect(maybe(w.root, 1, 'base.sha')).toBe(`${first.base}\n`)
})

/** A first round committed and sent to `asm/1-a3` as `pr.head`, its checkout reaped. */
function sent(root: string): { base: string } {
  const first = checkout(root, 1, 'acme/widget', BRANCH)
  writeFileSync(join(first.dir, 'added.ts'), 'export const added = 1\n')
  git(first.dir, ['add', '-A'])
  git(first.dir, ['commit', '-qm', 'round one'])
  git(first.dir, ['push', '-q', 'origin', 'HEAD:asm/1-a3'])
  const sha = git(first.dir, ['rev-parse', 'HEAD']).trim()
  put(root, 1, PR_HEAD, `${sha} ${sha}\n`)
  rmSync(srcDir(root, 1), { recursive: true, force: true })
  return first
}

test('no base.sha still reopens on the pr.head branch', () => {
  const w = world()
  const first = sent(w.root)
  drop(w.root, 1, 'base.sha')

  const again = checkout(w.root, 1, 'acme/widget', BRANCH)
  expect(again.branch).toBe('asm/1-a3')
  expect(git(again.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('asm/1-a3')
  expect(existsSync(join(again.dir, 'added.ts'))).toBe(true)
  expect(maybe(w.root, 1, 'base.sha')).toBe(`${first.base}\n`)
})

test('D3 a recut pr.head plan reopens on its branch at main', () => {
  const w = world()
  sent(w.root)
  checkout(w.root, 1, 'acme/widget', BRANCH)
  const upstream = join(w.root, 'remotes', 'acme/widget')
  writeFileSync(join(upstream, 'later.ts'), 'export const later = 1\n')
  git(upstream, ['add', '-A'])
  git(upstream, ['commit', '-qm', 'main moves on'])
  const main = git(upstream, ['rev-parse', 'HEAD']).trim()
  recut(w.root, 1)

  const again = checkout(w.root, 1, 'acme/widget', BRANCH)
  expect(again.branch).toBe('asm/1-a3')
  expect(git(again.dir, ['rev-parse', 'HEAD']).trim()).toBe(main)
  expect(maybe(w.root, 1, 'base.sha')).toBe(`${main}\n`)
  expect(existsSync(join(again.dir, 'added.ts'))).toBe(false)
})

test('pr.head wins over a pushed branch of the same name', () => {
  const w = world()
  const first = sent(w.root)
  git(join(w.root, 'remotes', 'caliperforge/widget'), ['branch', BRANCH, first.base])

  expect(checkout(w.root, 1, 'acme/widget', BRANCH).branch).toBe('asm/1-a3')
})

test('a base.sha past the merge-base is reset to it', () => {
  const w = world()
  const first = sent(w.root)
  const upstream = join(w.root, 'remotes', 'acme/widget')
  writeFileSync(join(upstream, 'later.ts'), 'export const later = 1\n')
  git(upstream, ['add', '-A'])
  git(upstream, ['commit', '-qm', 'main moves on'])
  put(w.root, 1, 'base.sha', `${git(upstream, ['rev-parse', 'HEAD']).trim()}\n`)

  expect(checkout(w.root, 1, 'acme/widget', BRANCH).base).toBe(first.base)
  expect(maybe(w.root, 1, 'base.sha')).toBe(`${first.base}\n`)
  expect(diffOf(w.root, 1)).toContain('added.ts')
  expect(diffOf(w.root, 1)).not.toContain('later.ts')
})

test('no base.sha and a pr.head on no branch throws', () => {
  const w = world()
  const first = checkout(w.root, 1, 'acme/widget', BRANCH)
  put(w.root, 1, PR_HEAD, `${first.base} ${first.base}\n`)
  rmSync(srcDir(w.root, 1), { recursive: true, force: true })
  drop(w.root, 1, 'base.sha')

  expect(() => checkout(w.root, 1, 'acme/widget', BRANCH)).toThrow(`pr.head ${first.base.slice(0, 12)}`)
  expect(cloned(srcDir(w.root, 1))).toBe(false)
  expect(maybe(w.root, 1, 'base.sha')).toBeNull()
})

const stale = (root: string): string[] => readdirSync(planDir(root, 1)).filter((n) => n.startsWith('src.stale-'))

test('D2 an adopted plan checks out its pr.branch at the tip', () => {
  const w = world()
  const first = checkout(w.root, 1, 'acme/widget', BRANCH)
  writeFileSync(join(first.dir, 'added.ts'), 'export const added = 1\n')
  git(first.dir, ['add', '-A'])
  git(first.dir, ['commit', '-qm', 'their round'])
  git(first.dir, ['push', '-q', 'origin', 'HEAD:pay-button'])
  const sha = git(first.dir, ['rev-parse', 'HEAD']).trim()
  rmSync(planDir(w.root, 1), { recursive: true, force: true })
  put(w.root, 1, PR_BRANCH, 'pay-button\n')

  const again = checkout(w.root, 1, 'acme/widget', BRANCH)
  expect(again.branch).toBe('pay-button')
  expect(git(again.dir, ['rev-parse', 'HEAD']).trim()).toBe(sha)
  expect(again.base).toBe(first.base)
  expect(maybe(w.root, 1, 'base.sha')).toBe(`${first.base}\n`)
})

test('a src with no base.sha is moved aside and cloned fresh', () => {
  const w = world()
  writeFileSync(join(srcDir(w.root, 1), 'leftover.txt'), 'partial\n')

  const { dir } = checkout(w.root, 1, 'acme/widget', BRANCH)
  expect(cloned(dir)).toBe(true)
  expect(maybe(w.root, 1, 'base.sha')).not.toBeNull()
  const aside = stale(w.root)
  expect(aside).toHaveLength(1)
  expect(existsSync(join(planDir(w.root, 1), aside[0] ?? '', 'leftover.txt'))).toBe(true)
})

/** A commit on a fork branch the plan's clone never fetched, pushed from a second clone. */
function elsewhere(root: string, files: Record<string, string>): string {
  const other = join(root, 'other')
  git(root, ['clone', '-q', join(root, 'remotes', 'caliperforge/widget'), other])
  for (const [path, body] of Object.entries(files)) writeFileSync(join(other, path), body)
  git(other, ['add', '-A'])
  git(other, ['commit', '-qm', 'redesign'])
  git(other, ['push', '-q', 'origin', 'HEAD:redesign'])
  return git(other, ['rev-parse', 'HEAD']).trim()
}

test('D1 a base.sha HEAD lacks re-checks the branch out there', () => {
  const w = world()
  checkout(w.root, 1, 'acme/widget', BRANCH)
  const sha = elsewhere(w.root, { 'redesign.ts': 'export const redesign = 1\n' })
  put(w.root, 1, 'base.sha', `${sha}\n`)

  const again = checkout(w.root, 1, 'acme/widget', BRANCH)
  expect(git(again.dir, ['rev-parse', 'HEAD']).trim()).toBe(sha)
  expect(git(again.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(BRANCH)
  expect(again.base).toBe(sha)
  expect(diffOf(w.root, 1)).not.toContain('redesign.ts')
})

test('D2 a base.sha HEAD already holds leaves HEAD where it was', () => {
  const w = world()
  const first = checkout(w.root, 1, 'acme/widget', BRANCH)
  writeFileSync(join(first.dir, 'added.ts'), 'export const added = 1\n')
  git(first.dir, ['add', '-A'])
  git(first.dir, ['commit', '-qm', 'round one'])
  const head = git(first.dir, ['rev-parse', 'HEAD']).trim()

  checkout(w.root, 1, 'acme/widget', BRANCH)
  expect(git(first.dir, ['rev-parse', 'HEAD']).trim()).toBe(head)
  expect(diffOf(w.root, 1)).toContain('added.ts')
})

test('D3 an untracked file survives the move to a new base', () => {
  const w = world()
  const first = checkout(w.root, 1, 'acme/widget', BRANCH)
  writeFileSync(join(first.dir, 'added.ts'), 'export const added = 1\n')
  put(w.root, 1, 'base.sha', `${elsewhere(w.root, { 'redesign.ts': 'export const redesign = 1\n' })}\n`)

  checkout(w.root, 1, 'acme/widget', BRANCH)
  expect(diffOf(w.root, 1)).toContain('added.ts')
  expect(diffOf(w.root, 1)).not.toContain('redesign.ts')
})

test('D4 a tracked edit the new base overwrites throws', () => {
  const w = world()
  const first = checkout(w.root, 1, 'acme/widget', BRANCH)
  const tracked = git(first.dir, ['ls-files']).split('\n')[0] ?? ''
  const head = git(first.dir, ['rev-parse', 'HEAD']).trim()
  writeFileSync(join(first.dir, tracked), 'builder edit\n')
  const sha = elsewhere(w.root, { [tracked]: 'redesign edit\n' })
  put(w.root, 1, 'base.sha', `${sha}\n`)

  expect(() => checkout(w.root, 1, 'acme/widget', BRANCH)).toThrow()
  expect(git(first.dir, ['rev-parse', 'HEAD']).trim()).toBe(head)
  expect(git(first.dir, ['diff', '--name-only']).trim()).toBe(tracked)
  expect(maybe(w.root, 1, 'base.sha')).toBe(`${sha}\n`)
})

test('a src with a base.sha is reused with its untracked files', () => {
  const w = world()
  const first = checkout(w.root, 1, 'acme/widget', BRANCH)
  writeFileSync(join(first.dir, 'untracked.txt'), 'kept\n')

  expect(checkout(w.root, 1, 'acme/widget', BRANCH).base).toBe(first.base)
  expect(existsSync(join(first.dir, 'untracked.txt'))).toBe(true)
  expect(stale(w.root)).toEqual([])
})
