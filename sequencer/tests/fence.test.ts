import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { strays } from '../fence.ts'
import { tick } from '../index.ts'
import { srcDir } from '../workspace.ts'
import { CARRIED, internalPlan, ours, plan, stub, world, type World } from './world.ts'

const ID = 2
const LISTED = ['sequencer/fence.ts', 'sequencer/rails.ts']
const OWNED = '## Outside the files\n\n- `cli/extra.ts` — the command the ask names lives there\n'
const OWNS = CARRIED.replace('built\n\n', `built\n\n${OWNED}\n`)

function mine(): World {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root)
  internalPlan(w.db, w.root, ID)
  return w
}

async function stray(handback: string): Promise<{ w: World; rails: unknown }> {
  const w = mine()
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(handback))
  mkdirSync(join(srcDir(w.root, ID), 'cli'), { recursive: true })
  writeFileSync(join(srcDir(w.root, ID), 'cli/extra.ts'), 'export const extra = 1\n')
  return { w, rails: (await tick(w.db, w.root, stub(handback)))[0] }
}

test('listed, beside a listed file, or filled by step 3', () => {
  const touched = ['sequencer/rails.ts', 'sequencer/tests/fence.test.ts', 'sequencer/fence.test.ts',
    'sequencer/tests/fixtures/a.diff', 'rules/roster.yaml', 'rules.seed.sql']
  expect(strays(touched, LISTED, '')).toEqual([])
  expect(strays(['sequencer/seat.ts', 'cli/tests/x.test.ts'], LISTED, '')).toEqual(['sequencer/seat.ts', 'cli/tests/x.test.ts'])
  expect(strays(['sequencer/seat.ts'], [], '')).toEqual([])
})

test('a row owns a stray only with its reason, under its heading', () => {
  expect(strays(['cli/extra.ts'], LISTED, OWNED)).toEqual([])
  expect(strays(['cli/extra.ts'], LISTED, '## Outside the files\n\n- `cli/extra.ts`\n')).toEqual(['cli/extra.ts'])
  expect(strays(['cli/extra.ts'], LISTED, OWNED.replace('## Outside the files', '## Notes'))).toEqual(['cli/extra.ts'])
})

test('an owned stray passes the rails and goes to review', async () => {
  const { w, rails } = await stray(OWNS)
  expect(rails).toMatchObject({ plan: ID, step: 3, name: 'rails', outcome: 'pass' })
  expect(plan(w.db, ID).step).toBe(4)
})

test('an unowned stray refuses at the rails, before any review', async () => {
  const { w, rails } = await stray(CARRIED)
  expect(rails).toMatchObject({ plan: ID, step: 3, name: 'rails', outcome: 'refuse', spans: ['cli/extra.ts:1 authority.outside_files'] })
  expect(w.db.prepare('SELECT 1 FROM runs WHERE plan = ? AND step > 3').all(ID)).toEqual([])
  expect(plan(w.db, ID).step).toBe(2)
})
