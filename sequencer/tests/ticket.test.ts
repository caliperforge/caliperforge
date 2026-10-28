import { expect, test } from 'vitest'
import type { Db } from '../../store/index.ts'
import { pipeOf, planRows } from '../../store/plans.ts'
import type { Wire } from '../push.ts'
import { ticketed } from '../ticket.ts'
import { SELF } from '../workspace.ts'
import { internalPlan, plan, world } from './world.ts'

const now = new Date('2026-10-28T12:00:00.000Z')
const BENCH = 'run_pair drops a seed (lane:bench, P0)'

function wire(filed: { repo: string; labels: string[] }[]): Wire {
  const no = (): never => { throw new Error('not in this test') }
  return { send: no, open: no, close: no, runs: no, comment: no, review: no, merged: no,
    file: (...[repo, , , labels]) => {
      filed.push({ repo, labels })
      return `https://github.com/${repo}/issues/${String(900 + filed.length)}`
    } }
}

const waitsOn = (db: Db, id: number) => Number(planRows(db).find((r) => r.id === id)?.waits_on)

function ticket(title: string) {
  const { db, root } = world()
  const filed: { repo: string; labels: string[] }[] = []
  const origin = ticketed(db, root, plan(db, 1), title, 'body', 'why', wire(filed), now)
  return { db, root, filed, origin, on: waitsOn(db, 1) }
}

test('a lane:bench title files and queues in the bench lane', () => {
  const { db, filed, origin, on } = ticket(BENCH)
  expect(filed).toEqual([{ repo: 'caliperforge/fuzz-bench', labels: ['lane:bench', 'P0', 'fix'] }])
  expect(plan(db, on)).toMatchObject({ lane: 'bench', seat: 'solidity_specialist', priority: 0, state: 'queued', origin })
  expect(pipeOf(db, plan(db, on).pipe_id).name).toBe('bench')
})

test.each(['the run wall counts each block', 'a stop (lane:nope)'])('"%s" is a machine ticket on SELF', (title) => {
  const { db, filed, on } = ticket(title)
  expect(filed).toEqual([{ repo: SELF, labels: ['lane:machine', 'P0', 'fix'] }])
  expect(plan(db, on)).toMatchObject({ lane: 'machine', seat: 'typescript_specialist', priority: 0 })
})

test('a second lane:bench ticket waits on the first bench plan', () => {
  const { db, root, filed, on } = ticket(BENCH)
  const job = internalPlan(db, root, on + 1)
  ticketed(db, root, plan(db, job), BENCH, 'body', 'why', wire(filed), now)
  expect(filed).toHaveLength(1)
  expect(waitsOn(db, job)).toBe(on)
})
