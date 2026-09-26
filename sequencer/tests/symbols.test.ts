import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { symbolMap } from '../symbols.ts'

function repo(): { root: string; dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cf-symbols-'))
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  writeFileSync(join(dir, 'a.ts'), 'export function alpha() {}\n  export const indented = 1\nconst hidden = 2\nexport default class Beta {}\n')
  writeFileSync(join(dir, 'b.rs'), 'pub fn gamma() {}\nfn hidden() {}\npub(crate) struct Delta;\n    pub fn nested() {}\n')
  writeFileSync(join(dir, 'notes.xyz'), 'export const x = 1\n')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
  const sha = git('rev-parse', 'HEAD')
  writeFileSync(join(dir, 'a.ts'), 'export const later = 1\n', { flag: 'a' })
  git('commit', '-q', '-am', 'second')
  writeFileSync(join(dir, 'b.rs'), 'pub fn disk() {}\n', { flag: 'a' })
  return { root: mkdtempSync(join(tmpdir(), 'cf-root-')), dir, sha }
}

const expected = 'a.ts:1 alpha\na.ts:4 Beta\nb.rs:1 gamma\nb.rs:3 Delta\n'

test('a map lists the top-level exports at sha and a second call reads the cache', () => {
  const { root, dir, sha } = repo()
  expect(symbolMap(root, 'org/surfpool', dir, sha)).toBe(expected)
  expect(readFileSync(join(root, '.cf/maps', `surfpool@${sha}`), 'utf8')).toBe(expected)
  rmSync(dir, { recursive: true })
  expect(symbolMap(root, 'org/surfpool', dir, sha)).toBe(expected)
})

test('a sha the checkout does not hold throws and writes no map', () => {
  const { root, dir } = repo()
  expect(() => symbolMap(root, 'org/surfpool', dir, 'c25df73dec9cf17243c4b119960f288f013f2ecd')).toThrow()
  expect(existsSync(join(root, '.cf/maps'))).toBe(false)
})
