import { Command } from 'commander'
import { expect, test } from 'vitest'
import { registerApprovals } from '../cf-targets.ts'
import { WAIVED, waived } from '../../sequencer/waived.ts'
import { ours, world } from '../../sequencer/tests/world.ts'
import { checkout, headSha, maybe, SELF } from '../../sequencer/workspace.ts'
import { eventsOf, pointers } from '../../store/events.ts'

function setup() {
  const { db, root } = world()
  ours(root)
  const { dir } = checkout(root, 1, SELF, 'p1-x')
  const said: string[] = []
  const cf = new Command()
  registerApprovals(cf, { root, db: () => db, out: (s: string) => { said.push(s) } })
  const run = (...args: string[]) => cf.parse(['waive', 'greptile', '1', ...args], { from: 'user' })
  return { db, root, sha: headSha(dir), said, run }
}

test('waive greptile writes the head line and one event', () => {
  const { db, root, sha, said, run } = setup()
  run('--why', 'fork silent since 10-27', '--by', 'coo')
  expect(said).toEqual([`plan 1 greptile waived at ${sha.slice(0, 12)}\n`])
  expect(maybe(root, 1, WAIVED)).toBe(`${sha} coo fork silent since 10-27\n`)
  expect(eventsOf(db, 1, WAIVED)).toEqual([{ actor: 'coo', outcome: 'pass', message: 'fork silent since 10-27' }])
  expect(pointers(db, WAIVED)).toEqual([sha])
  expect(waived(root, 1, sha)).toBe(`waived at ${sha.slice(0, 12)} by coo: fork silent since 10-27`)
  expect(waived(root, 1, 'f'.repeat(40))).toBeNull()
  expect(waived(root, 1, sha.slice(0, 12))).toBeNull()
})

test('a bad --by or --why is refused and writes nothing', () => {
  const { db, root, run } = setup()
  expect(() => run('--why', 'x', '--by', 'director')).toThrow(/--by takes ceo or coo/)
  expect(() => run('--why', '', '--by', 'coo')).toThrow(/--why/)
  expect(() => run('--why', 'a\nb', '--by', 'ceo')).toThrow(/--why/)
  expect(maybe(root, 1, WAIVED)).toBeNull()
  expect(eventsOf(db, 1, WAIVED)).toEqual([])
})
