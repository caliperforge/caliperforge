import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { TestProject } from 'vitest/node'
import setup, { key, TYPESCRIPT } from './bases.ts'

afterEach(() => { vi.unstubAllEnvs() })

const run = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })

function hostile(): void {
  const config = join(mkdtempSync(join(tmpdir(), 'cf-unsigned-')), 'gitconfig')
  writeFileSync(config, '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n')
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
}

function commit(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-unsigned-'))
  run(dir, ['init', '-q'])
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  run(dir, ['add', '-A'])
  run(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'a'])
  return run(dir, ['cat-file', 'commit', 'HEAD'])
}

test('D3 a worker commit is unsigned under a signing gitconfig', () => {
  hostile()
  expect(commit()).not.toMatch(/^gpgsig /m)
})

test('D4 the signing gitconfig signs once the count is zero', () => {
  hostile()
  vi.stubEnv('GIT_CONFIG_COUNT', '0')
  expect(commit).toThrow()
})

test('D2 setup builds unsigned bases under a signing gitconfig', () => {
  hostile()
  let bases = ''
  const teardown = setup({ provide: (...[, dir]: [string, string]) => { bases = dir } } as unknown as TestProject)
  expect(run(join(bases, key('ours', TYPESCRIPT, true)), ['cat-file', 'commit', 'HEAD'])).not.toMatch(/^gpgsig /m)
  teardown()
  expect(existsSync(bases)).toBe(false)
})
