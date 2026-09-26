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
    'migrate', 'digests', 'map', 'dump', 'runs', 'backfill-cost', 'fire', 'pipe', 'priority', 'lanes', 'hq', 'usage',
    'measure', 'record', 'scan', 'queue', 'plan', 'plans', 'reap', 'release', 'return', 'park', 'unpark', 'inbox', 'tight',
    'retry', 'approve', 'refuse', 'batch', 'session', 'push-check', 'halted', 'brief', 'adopt', 'tick', 'lap', 'watch',
    'signoff',
  ])
})

test.each([
  ['queue', ['add', 'list', 'note']],
  ['approve', ['target', 'plan', 'proposal']],
  ['refuse', ['target', 'plan', 'proposal']],
  ['plan', ['add']],
  ['session', ['close']],
])('cf %s --help keeps its subcommand order', (name, subcommands) => {
  expect(commands(name)).toEqual(subcommands)
})
