import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { checkout, cloned, maybe } from '../workspace.ts'
import { git } from './bases.ts'
import { world } from './world.ts'

const BRANCH = 'widget-12-a1'

test('D1 a missing fork is forked once, then cloned from main', () => {
  const w = world()
  const upstream = join(w.root, 'remotes/acme/widget')
  const fork = join(w.root, 'remotes/caliperforge/widget')
  rmSync(fork, { recursive: true, force: true })
  const calls: string[][] = []
  const exec = (args: string[]): string => {
    calls.push(args)
    cpSync(upstream, fork, { recursive: true })
    return ''
  }

  const out = checkout(w.root, 1, 'acme/widget', BRANCH, 'main', exec)
  expect(calls).toEqual([['repo', 'fork', 'acme/widget', '--org', 'caliperforge', '--clone=false']])
  expect(cloned(out.dir)).toBe(true)
  expect(out.branch).toBe(BRANCH)
  expect(out.base).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim())
})

test('D2 an existing fork makes no gh call', () => {
  const w = world()
  const exec = (): string => { throw new Error('forked') }

  expect(cloned(checkout(w.root, 1, 'acme/widget', BRANCH, 'main', exec).dir)).toBe(true)
})

test('D2 a master-only target is cut from its master', () => {
  const w = world()
  const upstream = join(w.root, 'remotes/acme/widget')
  for (const repo of [upstream, join(w.root, 'remotes/caliperforge/widget')]) execFileSync('git', ['branch', '-m', 'main', 'master'], { cwd: repo })
  const exec = (): string => { throw new Error('forked') }

  const out = checkout(w.root, 1, 'acme/widget', BRANCH, 'main', exec)
  expect(out.base).toBe(execFileSync('git', ['rev-parse', 'master'], { cwd: upstream, encoding: 'utf8' }).trim())
  expect(maybe(w.root, 1, 'base.sha')).toBe(`${out.base}\n`)
})

test('D3 an unreachable fork throws offline and forks nothing', () => {
  const w = world()
  writeFileSync(join(w.root, '.cf/git-base'), 'http://127.0.0.1:9')
  const calls: string[][] = []
  const exec = (args: string[]): string => { calls.push(args); return '' }

  expect(() => checkout(w.root, 1, 'acme/widget', BRANCH, 'main', exec)).toThrow(/Failed to connect to/)
  expect(calls).toEqual([])
})

test('D3 empty remotes throw and write no base', () => {
  const w = world()
  for (const slug of ['acme/widget', 'caliperforge/widget']) {
    const dir = join(w.root, 'remotes', slug)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    git(dir, ['init', '-q'])
  }

  expect(() => checkout(w.root, 1, 'acme/widget', BRANCH, 'main', () => '')).toThrow(/couldn't find remote ref HEAD/)
  expect(maybe(w.root, 1, 'base.sha')).toBeNull()
})
