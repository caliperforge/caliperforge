import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CHECKS, runAll } from './all.ts'

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

it('every check owns at least one fixture', () => {
  expect(CHECKS.filter((c) => cases(c.name).length === 0).map((c) => c.name)).toEqual([])
})

it('runAll sees the repository as clean', async () => {
  expect(await runAll(root)).toEqual([])
})

function cases(check: string): string[] {
  return readdirSync(join(fixtures, check), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
}
