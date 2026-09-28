import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const cf = join(import.meta.dirname, '../cf.ts')

function commands(...args: string[]): (string | undefined)[] {
  const help = execFileSync(process.execPath, [cf, ...args, '--help'], { encoding: 'utf8' })
  return [...help.slice(help.indexOf('Commands:')).matchAll(/^ {2}(\S+)/gm)].map((m) => m[1]).filter((n) => n !== 'help')
}

test('cf --help lists every command in registration order', () => {
  expect(commands()).toEqual([
    'migrate', 'digests', 'map', 'dump', 'runs', 'backfill-cost', 'backfill-tickets', 'fire', 'pipe', 'priority', 'lanes', 'hq', 'usage',
    'measure', 'record', 'scan', 'queue', 'plan', 'plans', 'reap', 'release', 'return', 'park', 'hold', 'unpark', 'inbox', 'tight',
    'retry', 'approve', 'refuse', 'batch', 'session', 'push-check', 'halted', 'flow', 'brief', 'adopt', 'health', 'tick', 'lap', 'watch',
    'signoff', 'coo-lite',
  ])
})

test.each([
  ['queue', ['add', 'list', 'note']],
  ['approve', ['target', 'plan', 'proposal', 'card']],
  ['refuse', ['target', 'plan', 'proposal', 'card']],
  ['plan', ['add']],
  ['session', ['close']],
])('cf %s --help keeps its subcommand order', (name, subcommands) => {
  expect(commands(name)).toEqual(subcommands)
})

function stderr(args: string[]): string {
  try {
    execFileSync(process.execPath, [cf, ...args], { encoding: 'utf8', stdio: 'pipe' })
  } catch (error) {
    return (error as { stderr: string }).stderr
  }
  throw new Error(`cf ${args.join(' ')} exited 0`)
}

test.each([
  [['approve', 'plan', '7']],
  [['refuse', 'card', '7', 'x']],
  [['approve', 'plan', '7', '--by', 'cto']],
])('D1 D2 cf %j is refused over --by before it acts', (args) => {
  expect(stderr(args)).toContain('--by')
})
