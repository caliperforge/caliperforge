import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { afterEach, expect, test, vi } from 'vitest'
import { world } from '../../sequencer/tests/world.ts'
import { git } from '../../sequencer/workspace.ts'
import { get } from '../../store/lanes.ts'
import { registerSite } from '../site.ts'

afterEach(() => { vi.unstubAllEnvs() })

function setup() {
  const { db, root } = world()
  const said: string[] = []
  const cf = new Command()
  registerSite(cf, { root, db: () => db, out: (s: string) => void said.push(s) })
  const run = (path: string, by = 'ceo') => cf.parse(['site', 'dir', path, '--by', by], { from: 'user' })
  return { db, said, run }
}

const checkout = (dir = mkdtempSync(join(tmpdir(), 'cf-site-'))): string => {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  return dir
}

test('D1 a git checkout is written and both values printed', () => {
  const { db, said, run } = setup()
  const dir = checkout()
  run(dir)
  expect(get(db, 'comms.site_dir')).toBe(dir)
  expect(said).toEqual([`comms.site_dir "" → ${JSON.stringify(dir)}\n`])
})

test('D2 D3 D4 a missing path, no .git or --by coo is refused', () => {
  const { db, run } = setup()
  const bare = mkdtempSync(join(tmpdir(), 'cf-site-'))
  expect(() => { run(join(bare, 'gone')) }).toThrow(`${join(bare, 'gone')} is not a directory`)
  expect(() => { run(bare) }).toThrow(`${bare} has no .git`)
  expect(() => { run(checkout(), 'coo') }).toThrow('site dir takes --by ceo, not coo')
  expect(get(db, 'comms.site_dir')).toBe('')
})

test('D5 a ~ path under homedir is stored as typed', () => {
  const { db, run } = setup()
  const home = mkdtempSync(join(tmpdir(), 'cf-home-'))
  checkout(join(home, 'site'))
  vi.stubEnv('HOME', home)
  run('~/site')
  expect(get(db, 'comms.site_dir')).toBe('~/site')
})
