import { expect, test } from 'vitest'
import type { Packet } from '../../providers/kind.ts'
import { refusalRows } from '../../store/refusals.ts'
import { at } from '../../templates/pr-path.ts'
import { tick } from '../index.ts'
import { thrown } from '../settle.ts'
import { approve, CARRIED, plan, stub, watched, world } from './world.ts'

const FETCH = "Command failed: git fetch --no-tags origin +main:refs/remotes/origin/main\nfatal: unable to access 'https://github.com/caliperforge/caliperforge.git/': Could not resolve host: github.com"

test('offline throw holds the step', () => {
  expect(thrown(at(3), FETCH)).toMatchObject({ outcome: 'pass', held: true, spans: ['offline'] })
  expect(thrown(at(2), 'getaddrinfo ENOTFOUND api.anthropic.com')).toMatchObject({ held: true })
})

test('an api_error stop holds the step', async () => {
  const w = world()
  approve(w.db, w.target)
  const inner = stub(CARRIED)
  const down = { ...inner, fire: async (packet: Packet) => {
    const out = await inner.fire(packet)
    return packet.tools.includes('Write') ? { ...out, ended: 'stopped' as const, exit: 1, stop_reason: 'api_error' } : out
  } }
  const fired = await tick(w.db, w.root, down, undefined, undefined, watched([], w.root, 1), 5)
  expect(fired.at(-1)).toMatchObject({ step: 2, held: true })
  expect(plan(w.db, 1)).toMatchObject({ step: 2, state: 'running' })
  expect(refusalRows(w.db, 1)).toEqual([])
})

test('other throws still refuse', () => {
  expect(thrown(at(6), 'plan 123 has no checkout at /x/src')).toMatchObject({ outcome: 'refuse', spans: ['threw: plan 123 has no checkout at /x/src'] })
})
