import { Command } from 'commander'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { registerLanes } from '../cf-lanes.ts'
import { ofKind } from '../../store/events.ts'
import type { Db } from '../../store/index.ts'
import { pipeNamed } from '../../store/plans.ts'

const schema = join(import.meta.dirname, '../../schema')

function world(): { db: Db; run: (...args: string[]) => void } {
  const db = fresh(schema)
  const cf = new Command()
  registerLanes(cf, { root: '', db: () => db, out: () => undefined })
  const run = (...args: string[]): void => { cf.parse(args, { from: 'user' }) }
  run('pipe', 'on', 'internal')
  return { db, run }
}

test('D1 cf pipe width sets the width and logs one pipe event', () => {
  const { db, run } = world()
  run('pipe', 'width', 'internal', '3', '--by', 'ceo')
  expect(pipeNamed(db, 'internal')?.max_concurrent).toBe(3)
  expect(ofKind(db, 'pipe')).toEqual([{ plan: null, kind: 'pipe', actor: 'ceo', outcome: 'pass', message: 'internal width 1 → 3' }])
})

test.each([
  [['internal', '0']],
  [['internal', '9']],
  [['nowhere', '3']],
])('D2 cf pipe width %j is refused and writes nothing', (args) => {
  const { db, run } = world()
  expect(() => { run('pipe', 'width', ...args, '--by', 'ceo') }).toThrow()
  expect(pipeNamed(db, 'internal')?.max_concurrent).toBe(1)
  expect(ofKind(db, 'pipe')).toEqual([])
})

test('D4 cf pipe off switches an existing pipe off', () => {
  const { db, run } = world()
  expect(pipeNamed(db, 'internal')?.enabled).toBe(1)
  run('pipe', 'off', 'internal')
  expect(pipeNamed(db, 'internal')?.enabled).toBe(0)
})
