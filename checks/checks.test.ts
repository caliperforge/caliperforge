import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CHECKS, runAll } from './all.ts'
import { migrationOrder } from './migration-order.ts'
import { walk } from './tree.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = join(root, 'checks/fixtures')

describe.each(CHECKS)('$name', (check) => {
  it('passes on the repository', async () => {
    expect(await check.run(root)).toEqual([])
  })

  it.each(cases(check.name))('is red on the %s fixture', async (name) => {
    expect(await check.run(join(fixtures, check.name, name))).not.toEqual([])
  })
})

it('a job checkout parked under .cf is not walked as our own tree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-walk-'))
  mkdirSync(join(dir, '.cf/work/1/src'), { recursive: true })
  writeFileSync(join(dir, '.cf/work/1/src/theirs.ts'), '// a stranger\n')
  writeFileSync(join(dir, 'ours.ts'), '// ours\n')
  expect(walk(dir, () => true)).toEqual([join(dir, 'ours.ts')])
})

it('every check owns at least one fixture', () => {
  expect(CHECKS.filter((c) => cases(c.name).length === 0).map((c) => c.name)).toEqual([])
})

it('runAll sees the repository as clean', async () => {
  expect(await runAll(root)).toEqual([])
})

it('migration-order judges new migrations against upstream main, then origin main', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-order-'))
  const git = (args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'ignore' })
  }
  const add = (name: string): void => {
    writeFileSync(join(dir, 'schema', name), 'SELECT 1;\n')
  }
  const paths = async (): Promise<string[]> => (await migrationOrder.run(dir)).map((f) => f.path)
  mkdirSync(join(dir, 'schema'))
  add('0001_a.sql')
  add('0003_c.sql')
  git(['init', '-q'])
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'main'])
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])

  add('0002_b.sql')
  expect(await paths()).toEqual(['schema/0002_b.sql'])

  rmSync(join(dir, 'schema/0002_b.sql'))
  add('0004_d.sql')
  expect(await paths()).toEqual([])

  add('0005_e.sql')
  git(['add', 'schema/0005_e.sql'])
  git(['commit', '-q', '-m', 'upstream'])
  git(['update-ref', 'refs/remotes/upstream/main', 'HEAD'])
  expect(await paths()).toEqual(['schema/0004_d.sql'])
})

function cases(check: string): string[] {
  return readdirSync(join(fixtures, check), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
}
