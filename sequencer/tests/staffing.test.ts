import { expect, test, vi } from 'vitest'
import type { Packet } from '../../providers/kind.ts'
import { holdOf } from '../../store/holds.ts'
import { tick } from '../index.ts'
import { approve, CARRIED, PASS, plan, stub, world } from './world.ts'

vi.mock('../route.ts', async (importOriginal) => ({
  ...await importOriginal<object>(),
  languageFor: () => 'cobol',
}))

test('D2 a language with no build seat holds for the director', async () => {
  const w = world()
  approve(w.db, w.target)
  const packets: Packet[] = []
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED, 0, PASS, (p) => packets.push(p)))
  expect(plan(w.db, 1).state).toBe('blocked_on_ceo')
  expect(holdOf(w.db, 1)).toEqual({ held_by: 'coo', held_why: 'no cobol build seat' })
  expect(packets.filter((p) => p.tools.includes('Write'))).toEqual([])
})
