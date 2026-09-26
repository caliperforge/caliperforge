import { expect, test } from 'vitest'
import { fingerprint, refused } from '../../store/refusals.ts'
import { at } from '../../templates/pr-path.ts'
import { tick } from '../index.ts'
import { fingerprintOf } from '../refusal.ts'
import { CARRIED, internalPlan, ours, REFUSE, stub, world } from './world.ts'

const text = (note: string) => ({ outcome: 'refuse' as const, spans: ['text:5 identifier.unresolved'], note })
const base = (note: string) => ({ outcome: 'refuse' as const, spans: ['base:stale'], note })

test('text spans differ by what they name', () => {
  expect(fingerprintOf(at(3), text('identifiers: cli/extra.ts'))).not.toBe(fingerprintOf(at(3), text('identifiers: schema/0036_x.sql')))
  expect(fingerprintOf(at(3), text('identifiers: cli/extra.ts'))).toBe(fingerprintOf(at(3), text('identifiers: cli/extra.ts')))
})

test('D1 identifiers notes naming a .sh and a .sql file differ', () => {
  const said = (name: string) => text(`identifiers: 1 identifier(s) name no source in the tree: ${name}`)
  expect(fingerprintOf(at(3), said('scripts/vendor_machine_schema.sh'))).not.toBe(fingerprintOf(at(3), said('schema/0049_target_take.sql')))
})

test('other spans still match on the span alone', () => {
  expect(fingerprintOf(at(6), base('behind main'))).toBe(fingerprintOf(at(6), base('behind main again')))
})

test('D2 a shared refusal turns its lane off and names both plans and the span', async () => {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root)
  internalPlan(w.db, w.root, 2)
  internalPlan(w.db, w.root, 3, 'an earlier plan', 35)
  w.db.prepare("UPDATE plans SET state = 'done' WHERE id = 3").run()
  refused(w.db, { plan: 3, step: 4, fingerprint: fingerprint(4, ['src/hello.ts:1']), diff: null })
  for (let step = 0; step < 4; step += 1) await tick(w.db, w.root, stub(CARRIED))
  const fired = (await tick(w.db, w.root, stub(CARRIED, 0, REFUSE)))[0]
  expect(fired?.note).toContain('lane off: plans 2 and 3 refused on src/hello.ts:1')
  expect(w.db.prepare('SELECT enabled FROM pipes WHERE id = 1').get()).toEqual({ enabled: 0 })
})
