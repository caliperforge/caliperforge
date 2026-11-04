import { expect, test } from 'vitest'
import type { Gh } from '../../rails/ci-green/index.ts'
import { ofKind } from '../../store/events.ts'
import { GREEN, onBase } from '../base.ts'
import { put } from '../workspace.ts'
import { RUN, world } from './world.ts'

const HEAD = { fork: 'caliperforge/widget', branch: 'ci', sha: 'b'.repeat(40) }

test('a gh that throws is logged once and refuses as before', () => {
  const { db, root, plan } = world()
  put(root, plan, GREEN, `ci ${'a'.repeat(40)}\n`)
  const broken: Gh = () => { throw new Error('gh: 502\nretry later') }
  expect(onBase(db, root, plan, HEAD, [`${RUN} ci.red`], [], broken)).toBeNull()
  expect(ofKind(db, 'swallowed').map((e) => [e.plan, e.actor, e.message])).toEqual([[plan, 'onBase', 'gh: 502']])
})

test('no green head, or a span not red, reads no gh', () => {
  const { db, root, plan } = world()
  const calls: string[][] = []
  const gh: Gh = (args) => { calls.push(args); throw new Error('gh: read') }
  expect(onBase(db, root, plan, HEAD, [`${RUN} ci.red`], [], gh)).toBeNull()
  put(root, plan, GREEN, `ci ${'a'.repeat(40)}\n`)
  expect(onBase(db, root, plan, HEAD, [`${RUN} ci.red`, `${RUN} ci.pending`], [], gh)).toBeNull()
  expect(calls).toEqual([])
  expect(ofKind(db, 'swallowed')).toEqual([])
})
