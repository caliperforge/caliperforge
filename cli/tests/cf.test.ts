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
    'migrate', 'digests', 'map', 'dump', 'runs', 'backfill-cost', 'backfill-tickets', 'fire', 'pipe', 'priority', 'lanes', 'usage',
    'measure', 'record', 'scan', 'queue', 'plan', 'plans', 'reap', 'release', 'return', 'park', 'hold', 'unpark', 'files', 'close',
    'inbox', 'tight', 'retry', 'approve', 'refuse', 'batch', 'session', 'push-check', 'halted', 'flow', 'brief', 'adopt', 'desk', 'health', 'science', 'tick', 'lap', 'watch',
    'signoff', 'coo-lite',
  ])
})

test.each([
  ['queue', ['add', 'list', 'note']],
  ['approve', ['target', 'plan', 'proposal', 'card']],
  ['refuse', ['target', 'plan', 'proposal', 'card']],
  ['plan', ['add']],
  ['session', ['close']],
  ['desk', ['list', 'show', 'edit', 'approve', 'return']],
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
  [['approve', 'target', '3']],
  [['refuse', 'target', '3', 'x']],
  [['approve', 'proposal', '3']],
  [['refuse', 'proposal', '3', 'x']],
  [['approve', 'target', '3', '--by', 'cto']],
  [['refuse', 'target', '3', 'x', '--by', 'cto']],
  [['approve', 'proposal', '3', '--by', 'cto']],
  [['refuse', 'proposal', '3', 'x', '--by', 'cto']],
])('D1 D2 cf %j is refused over --by before it acts', (args) => {
  expect(stderr(args)).toContain('--by')
})

test('cf priority without --why is refused', () => {
  expect(stderr(['priority', '7', '0', '--by', 'coo'])).toContain('--why')
})
