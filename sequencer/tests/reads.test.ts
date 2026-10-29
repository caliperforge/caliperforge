import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { readOutside } from '../../providers/claude-agent-sdk/index.ts'
import type { PlanRow } from '../../store/plans.ts'
import { inputs } from '../output.ts'
import { machineReads } from '../seat.ts'
import { put } from '../workspace.ts'

const plan = (lane: string | null) => ({ id: 1, lane } as unknown as PlanRow)

afterEach(() => { vi.unstubAllEnvs() })

const temp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

const home = (): string => {
  const dir = temp('cf-home-')
  vi.stubEnv('HOME', dir)
  return dir
}

test('#274 loupe brief writer reads schema and cli', () => {
  expect(machineReads('/m', plan('loupe'), 'brief_writer')).toEqual(['/m/schema', '/m/cli'])
})

test('#274 no reads for other lanes or seats', () => {
  expect(machineReads('/m', plan('machine'), 'brief_writer')).toEqual([])
  expect(machineReads('/m', plan('atelier'), 'brief_writer')).toEqual([])
  expect(machineReads('/m', plan('loupe'), 'swift_specialist')).toEqual([])
  expect(machineReads('/m', plan(null), 'brief_writer')).toEqual([])
})

test('inputs D1: a folder the ask names under ~/cf_work', () => {
  const dir = home()
  const root = temp('cf-root-')
  put(root, 7, 'ask.md', 'Copy the recordings at ~/cf_work/1886/pay-oracle/.\n')
  expect(inputs(root, 7)).toEqual([join(dir, 'cf_work/1886/pay-oracle')])
})

test.each(['issue.md', 'rulings.md'])('inputs D1: %s names it by home path, once', (name) => {
  const dir = home()
  const root = temp('cf-root-')
  put(root, 7, name, `See \`${dir}/cf_work/1886/pay-oracle/\` and (${dir}/cf_work/1886/pay-oracle).\n`)
  put(root, 7, 'ask.md', 'From "~/cf_work/1886/pay-oracle/", copy them.\n')
  expect(inputs(root, 7)).toEqual([join(dir, 'cf_work/1886/pay-oracle')])
})

test.each(['~/cf_work', '~/cf_work/../x', '~/.ssh/config', '/tmp/x'])('inputs D2: %s grants nothing', (named) => {
  home()
  const root = temp('cf-root-')
  put(root, 7, 'ask.md', `Read ${named} first.\n`)
  expect(inputs(root, 7)).toEqual([])
})

test('inputs D2: a plan with no ask, issue or rulings', () => {
  home()
  expect(inputs(temp('cf-root-'), 7)).toEqual([])
})

test('inputs D3: readOutside admits the cited folder only', () => {
  const dir = home()
  const root = temp('cf-root-')
  const cwd = temp('cf-src-')
  put(root, 7, 'ask.md', 'Copy ~/cf_work/1886/pay-oracle/ in.\n')
  const read = (path: string) => readOutside(cwd, 'Read', { file_path: join(dir, path) }, inputs(root, 7))
  expect(read('cf_work/1886/pay-oracle/r01.json')).toBeNull()
  expect(read('cf_work/1887/x.json')).toMatch(/^ruling:run\.outside_checkout refuses a read of /)
  expect(read('notes/x.ts')).toMatch(/^ruling:run\.outside_checkout refuses a read of /)
})
