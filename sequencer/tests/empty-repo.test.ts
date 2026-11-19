import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { allEvents, kindsOf } from '../../store/events.ts'
import { tick } from '../index.ts'
import { maybe } from '../workspace.ts'
import { git } from './bases.ts'
import { approve, CARRIED, plan, stub, world } from './world.ts'

test('a repo with no commits is held for the COO once', async () => {
  const w = world()
  await tick(w.db, w.root, stub(CARRIED))
  approve(w.db, w.target)
  for (const slug of ['acme/widget', 'caliperforge/widget']) {
    const dir = join(w.root, 'remotes', slug)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    git(dir, ['init', '-q'])
  }

  const [fired] = await tick(w.db, w.root, stub(CARRIED))
  expect(fired).toMatchObject({ step: 1, outcome: 'needs_coo', spans: ['empty_repo'], state: 'blocked_on_ceo' })
  expect(fired?.note).toContain('repo has no commits')
  expect(plan(w.db, 1).state).toBe('blocked_on_ceo')
  expect(maybe(w.root, 1, 'base.sha')).toBeNull()

  const seen = kindsOf(w.db, 1)
  await tick(w.db, w.root, stub(CARRIED))
  expect(kindsOf(w.db, 1)).toEqual(seen)
  expect(allEvents(w.db).filter((e) => e.kind === 'cli_error')).toEqual([])
})
