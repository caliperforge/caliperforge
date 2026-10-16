import { expect, test } from 'vitest'
import type { Packet } from '../../providers/kind.ts'
import { runRows } from '../../store/events.ts'
import { dropPlan, putPlan } from '../../store/plans.ts'
import { at } from '../../templates/pr-path.ts'
import { fireSeat } from '../seat.ts'
import { put } from '../workspace.ts'
import { CARRIED, plan, stub, world } from './world.ts'

test('D1 D4 a design_lead plan builds as design_lead in its fence', async () => {
  const w = world()
  dropPlan(w.db, 1)
  putPlan(w.db, { id: 1, pipe_id: 1, target_id: null, template: 'pr_path', state: 'running', queued_at: '2026-10-11T00:00:00.000Z',
    step: 2, retries: 0, lane: 'loupe', seat: 'design_lead', origin: 'https://github.com/caliperforge/atelier-web/issues/1' })
  put(w.root, 1, 'issue.md', '# a design system\n\n- D1 write DESIGN.md\n- D2 file a ticket\n')
  const step = at(2, 'web', 'design_lead')
  expect(step).toMatchObject({ seat: 'design_lead', runs: 'design_lead' })
  const sent: Packet[] = []
  await fireSeat(w.db, w.root, plan(w.db, 1), step, stub(CARRIED, 0, undefined, (p) => sent.push(p)))
  expect(runRows(w.db).map((r) => r.seat)).toContain('design_lead')
  const built = sent.find((p) => p.tools.includes('Write'))
  expect(built?.refuse('index.html')).not.toBeNull()
  expect([built?.refuse('DESIGN.md'), built?.refuse('design/tickets/a.md')]).toEqual([null, null])
})

test('D2 the design_lead label changes no other step', () => {
  expect(at(4, 'web', 'design_lead')).toMatchObject({ seat: 'web_specialist', runs: 'code_quality', design: true })
  for (const step of [0, 1, 3, 5, 6, 7, 8]) expect(at(step, 'web', 'design_lead')).toEqual(at(step, 'web'))
  expect([at(2, 'web', 'web_specialist').runs, at(2, 'web').runs]).toEqual(['web_specialist', 'web_specialist'])
})
