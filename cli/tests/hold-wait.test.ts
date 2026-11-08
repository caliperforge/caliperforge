import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { expect, test } from 'vitest'
import { registerPlans } from '../cf-plans.ts'
import { isHeld } from '../../sequencer/hold.ts'
import { put } from '../../sequencer/workspace.ts'
import { eventsOf } from '../../store/events.ts'
import { migrate, open } from '../../store/index.ts'
import { drop, take } from '../../store/leases.ts'

const repo = join(import.meta.dirname, '../..')

function seeded() {
  const db = open(':memory:')
  migrate(db, join(repo, 'schema'))
  db.exec(readFileSync(join(repo, 'runner/tests/fixtures/waiting.sql'), 'utf8'))
  const home = mkdtempSync(join(tmpdir(), 'cf-hold-wait-'))
  put(home, 7, 'question.md', 'which one?\n')
  const cf = new Command()
  registerPlans(cf, { root: home, db: () => db, out: () => undefined })
  const waited = (wait: string) => cf.parseAsync(['hold', '7', '--by', 'coo', '--as', 'coo', '--why', 'x', '--until', '2026-10-04T22:00:00Z', '--wait', wait], { from: 'user' })
  return { db, home, waited }
}

test('hold --wait holds once the lease is dropped', async () => {
  const { db, home, waited } = seeded()
  take(db, 7)
  const start = Date.now()
  const done = waited('10')
  drop(db, 7)
  await done
  expect(isHeld(home, 7)).toBe(true)
  expect(Date.now() - start).toBeLessThan(6_000)
}, 10_000)

test('hold --wait refuses a lease that outlives the wait', async () => {
  const { db, home, waited } = seeded()
  take(db, 7)
  await expect(waited('0.01')).rejects.toThrow(/mid-step in a live tick.* after waiting 0\.01 min$/)
  expect(isHeld(home, 7)).toBe(false)
  expect(eventsOf(db, 7, 'hold')).toEqual([])
})
