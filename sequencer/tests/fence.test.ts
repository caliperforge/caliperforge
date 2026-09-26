import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { broken, renumbered, strays } from '../fence.ts'
import { tick } from '../index.ts'
import { get, srcDir } from '../workspace.ts'
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

test('an unowned stray refuses at the rails, before any review, naming its row; the round that writes it passes', async () => {
  const { w, rails } = await stray(CARRIED)
  expect(rails).toMatchObject({ plan: ID, step: 3, name: 'rails', outcome: 'refuse', spans: ['cli/extra.ts:1 authority.outside_files'] })
  expect(w.db.prepare('SELECT 1 FROM runs WHERE plan = ? AND step > 3').all(ID)).toEqual([])
  expect(plan(w.db, ID).step).toBe(2)
  for (const part of ['cli/extra.ts', '- `cli/extra.ts` — ']) expect(get(w.root, ID, 'refusal.md')).toContain(part)
  await tick(w.db, w.root, stub(OWNS))
  writeFileSync(join(srcDir(w.root, ID), 'cli/extra.ts'), 'export const extra = 1\n')
  expect((await tick(w.db, w.root, stub(OWNS)))[0]).toMatchObject({ plan: ID, step: 3, name: 'rails', outcome: 'pass' })
  expect(plan(w.db, ID).step).toBe(4)
})

test('#191 D3 a failing test is returned only when unlisted and importing a changed path', () => {
  const src = mkdtempSync(join(tmpdir(), 'cf-broken-'))
  mkdirSync(join(src, 'store/tests'), { recursive: true })
  writeFileSync(join(src, 'store/tests/x.test.ts'), "import { x } from '../x.ts'\n")
  expect(broken(src, ['store/tests/x.test.ts:1 x'], ['store/y.ts'], ['store/x.ts'])).toEqual(['store/tests/x.test.ts'])
  expect(broken(src, ['store/tests/x.test.ts:1 x'], ['store/tests/x.test.ts'], ['store/x.ts'])).toBeNull()
  expect(broken(src, [], ['store/y.ts'], ['store/x.ts'])).toBeNull()
})

test('a new migration numbered at or below one the checkout holds', () => {
  const src = mkdtempSync(join(tmpdir(), 'cf-schema-'))
  mkdirSync(join(src, 'schema'))
  for (const f of ['0020_leases.sql', '0021_parts.sql', '0018_label.sql']) writeFileSync(join(src, 'schema', f), '')
  const made = (path: string): string => `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+SELECT 1;\n`
  expect(renumbered(src, made('schema/0018_label.sql'))).toEqual(['schema/0018_label.sql'])
  expect(renumbered(src, made('schema/0022_next.sql'))).toEqual([])
  expect(renumbered(src, '--- a/schema/0021_parts.sql\n+++ b/schema/0021_parts.sql\n@@ -1 +1 @@\n+x\n')).toEqual([])
})
