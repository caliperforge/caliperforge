import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { conform } from '../conventions.ts'
import { MAIN } from '../workspace.ts'

type Commit = string | [message: string, file: string]

const signed = (subject: string): string => `${subject}\n\nSigned-off-by: t <t@t>`

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'ignore' })
}

function commit(dir: string, c: Commit): void {
  const [message, file] = typeof c === 'string' ? [c, 'a.txt'] : c
  appendFileSync(join(dir, file), `${message}\n`)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', message])
}

function repo(recent: Commit[], ours: Commit[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-conventions-'))
  git(dir, ['init', '-q', '-b', 'main'])
  for (const c of recent) commit(dir, c)
  git(dir, ['update-ref', MAIN, 'HEAD'])
  for (const c of ours) commit(dir, c)
  return dir
}

test('D1 a plain subject in a conventional repo is flagged and quoted', () => {
  const row = conform(repo(['feat: a', 'fix: b', 'c'], ['add hello']))
  expect(row.ok).toBe(false)
  expect(row.says).toContain('"add hello"')
})

test('D2 a conventional subject in a plain repo is flagged and quoted', () => {
  const row = conform(repo(['a', 'b', 'fix: c'], ['feat: add hello']))
  expect(row.ok).toBe(false)
  expect(row.says).toContain('"feat: add hello"')
})

test('D3 a repo that signs off flags a commit without one and passes one with it', () => {
  const recent = [signed('a'), signed('b')]
  const row = conform(repo(recent, ['add hello']))
  expect(row.ok).toBe(false)
  expect(row.says).toContain('Signed-off-by')
  expect(conform(repo(recent, [signed('add hello')])).ok).toBe(true)
})

test('D4 a repo with a changelog flags a branch that leaves it untouched and passes one that touches it', () => {
  const recent: Commit[] = [['a', 'CHANGELOG.md'], 'b']
  const row = conform(repo(recent, ['add hello']))
  expect(row.ok).toBe(false)
  expect(row.says).toContain('changelog')
  expect(conform(repo(recent, [['add hello', 'CHANGELOG.md']])).ok).toBe(true)
})

test('D5 plain subjects, no sign-off and no changelog pass a plain commit', () => {
  expect(conform(repo(['a', 'b'], ['add hello'])))
    .toEqual({ check: 'conventions', ok: true, says: 'matches the last 2 commits' })
})
