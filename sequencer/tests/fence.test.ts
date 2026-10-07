import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runRows } from '../../store/events.ts'
import { refusalsOf } from '../../store/refusals.ts'
import { cooLite } from '../director.ts'
import { broken, deletions, renumbered, strays } from '../fence.ts'
import { tick } from '../index.ts'
import { get, srcDir } from '../workspace.ts'
import { CARRIED, internalPlan, ours, plan, stub, watched, world, type World } from './world.ts'

const ID = 2
const LISTED = ['sequencer/fence.ts', 'sequencer/rails.ts']
const OWNED = '## Outside the files\n\n- `cli/extra.ts` — the command the ask names lives there\n'
const OWNS = CARRIED.replace('built\n\n', `built\n\n${OWNED}\n`)
const RULE = '---\nmove: rule\nwhy: the ask needs it\nanswer: the command the ask names lives in cli/extra.ts\n---\n'
const RETURN = '---\nmove: return\nwhy: the builder reverts it\n---\n'

function mine(): World {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root)
  internalPlan(w.db, w.root, ID)
  return w
}

async function stray(handback: string): Promise<{ w: World; rails: unknown }> {
  const w = mine()
  return { w, rails: await strayed(w, handback) }
}

async function strayed(w: World, handback: string, before = (): unknown => null, director?: string): Promise<unknown> {
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(handback))
  mkdirSync(join(srcDir(w.root, ID), 'cli'), { recursive: true })
  writeFileSync(join(srcDir(w.root, ID), 'cli/extra.ts'), 'export const extra = 1\n')
  before()
  return (await tick(w.db, w.root, stub(handback, 0, director)))[0]
}

async function directed(move: string): Promise<World> {
  const w = mine()
  await strayed(w, CARRIED, undefined, RULE)
  w.db.exec(`INSERT INTO settings (key, value, who, origin_kind, origin_ref, set_at)
    VALUES ('director.apply', '1', 'ceo', 'ruling', 't', '2026-09-28')`)
  await cooLite(w.db, w.root, plan(w.db, ID), stub(CARRIED, 0, move), new Date(), () => undefined, watched([], w.root, ID))
  return w
}

test('listed, beside a listed file, or filled by step 3', () => {
  const touched = ['sequencer/rails.ts', 'sequencer/tests/fence.test.ts', 'sequencer/fence.test.ts',
    'sequencer/tests/fixtures/a.diff', 'rules/roster/writer.yaml', 'rules.seed.sql']
  expect(strays(touched, LISTED, '')).toEqual([])
  expect(strays(['sequencer/seat.ts', 'cli/tests/x.test.ts'], LISTED, '')).toEqual(['sequencer/seat.ts', 'cli/tests/x.test.ts'])
  expect(strays(['sequencer/seat.ts'], [], '')).toEqual([])
})

test('a per-seat roster file is admitted, its neighbours are not', () => {
  expect(strays(['rules/roster/fixer.yaml'], LISTED, '')).toEqual([])
  const outside = ['rules/rosters/x.yaml', 'rules/registry/x.yaml']
  expect(strays(outside, LISTED, '')).toEqual(outside)
})

test('a row owns a stray only with its reason, under its heading', () => {
  expect(strays(['cli/extra.ts'], LISTED, OWNED)).toEqual([])
  expect(strays(['cli/extra.ts'], LISTED, '## Outside the files\n\n- `cli/extra.ts`\n')).toEqual(['cli/extra.ts'])
  expect(strays(['cli/extra.ts'], LISTED, OWNED.replace('## Outside the files', '## Notes'))).toEqual(['cli/extra.ts'])
})

test('D6 a brief row owns a stray only with its reason', () => {
  expect(strays(['cli/extra.ts'], LISTED, '', OWNED)).toEqual([])
  expect(strays(['cli/extra.ts'], LISTED, '', '## Outside the files\n\n- `cli/extra.ts`\n')).toEqual(['cli/extra.ts'])
})

test('an owned stray passes the rails and goes to review', async () => {
  const { w, rails } = await stray(OWNS)
  expect(rails).toMatchObject({ plan: ID, step: 3, name: 'rails', outcome: 'pass' })
  expect(plan(w.db, ID).step).toBe(4)
})

test('D1 an unowned stray stops for the director', async () => {
  const w = mine()
  const rails = await strayed(w, CARRIED, undefined, RULE)
  expect(rails).toMatchObject({ plan: ID, step: 3, name: 'rails', outcome: 'refuse', spans: ['cli/extra.ts:1 authority.outside_files'] })
  expect(w.db.prepare('SELECT 1 FROM runs WHERE plan = ? AND step > 3').all(ID)).toEqual([])
  expect(plan(w.db, ID)).toMatchObject({ state: 'blocked_on_ceo', step: 3 })
  expect(runRows(w.db).filter((r) => r.plan === ID && r.seat === 'director')).toHaveLength(1)
  for (const part of ['cli/extra.ts', '- `cli/extra.ts` — ']) expect(get(w.root, ID, 'refusal.md')).toContain(part)
})

test('D2 a director rule owns the stray; the rails pass', async () => {
  const w = await directed(RULE)
  expect(get(w.root, ID, 'issue.md')).toContain('## Outside the files\n\n- `cli/extra.ts` — the command the ask names lives in cli/extra.ts\n')
  expect(plan(w.db, ID)).toMatchObject({ state: 'queued', step: 3 })
  expect((await tick(w.db, w.root, stub(CARRIED)))[0]).toMatchObject({ plan: ID, step: 3, name: 'rails', outcome: 'pass' })
  expect(plan(w.db, ID).step).toBe(4)
})

test('D3 a director return sends the stray to the builder', async () => {
  const w = await directed(RETURN)
  expect(plan(w.db, ID)).toMatchObject({ state: 'running', step: 2 })
  expect(refusalsOf(w.db, ID)).toBe(1)
})

test('D4 a frozen migration goes back to the builder', async () => {
  const w = mine()
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))
  mkdirSync(join(srcDir(w.root, ID), 'schema'), { recursive: true })
  writeFileSync(join(srcDir(w.root, ID), 'schema/0001_x.sql'), 'SELECT 1;\n')
  const rails = (await tick(w.db, w.root, stub(CARRIED, 0, RULE)))[0]
  expect(rails).toMatchObject({ plan: ID, step: 3, outcome: 'refuse', spans: ['schema/0001_x.sql:1 authority.frozen_schema'] })
  expect(plan(w.db, ID).step).toBe(2)
  expect(runRows(w.db).filter((r) => r.seat === 'director')).toEqual([])
})

test('D5 no profiles: the write fence refuses an unowned stray', async () => {
  const w = mine()
  rmSync(join(w.root, 'profiles'), { recursive: true })
  const rails = await strayed(w, CARRIED)
  expect(rails).toMatchObject({ plan: ID, step: 3, name: 'rails', outcome: 'refuse', spans: ['cli/extra.ts:1 authority.write_paths'] })
})

test('D6 a plan with a target reads its repo\'s profile, not ours', async () => {
  const w = mine()
  const rails = await strayed(w, CARRIED, () => w.db.prepare('UPDATE plans SET target_id = 1 WHERE id = ?').run(ID))
  expect(rails).toMatchObject({ plan: ID, step: 3, name: 'rails', outcome: 'refuse', spans: ['cli/extra.ts:1 authority.write_paths'] })
})

test('D3 only an unlisted failing test on a changed path returns', () => {
  const src = mkdtempSync(join(tmpdir(), 'cf-broken-'))
  mkdirSync(join(src, 'store/tests'), { recursive: true })
  writeFileSync(join(src, 'store/tests/x.test.ts'), "import { x } from '../x.ts'\n")
  expect(broken(src, ['store/tests/x.test.ts:1 x'], ['store/y.ts'], ['store/x.ts'])).toEqual(['store/tests/x.test.ts'])
  expect(broken(src, ['store/tests/x.test.ts:1 x'], ['store/tests/x.test.ts'], ['store/x.ts'])).toBeNull()
  expect(broken(src, [], ['store/y.ts'], ['store/x.ts'])).toBeNull()
})

test('a `+` path reads, a pathless row is unread, blanks skipped', () => {
  const plus = 'Atelier/Services/Dashboard/DashboardSource+Spend.swift'
  expect(deletions(`## Deleted\n\n- ${plus}\n`)).toEqual({ paths: [plus], unread: [] })
  expect(deletions('## Deleted\n\n- src/a.ts — why\n\n- the old spend file\n\n---\ndone:\n---\n'))
    .toEqual({ paths: ['src/a.ts'], unread: ['- the old spend file'] })
  expect(deletions('## Deleted\n- src/a.ts\n\n```\n---\nsummary: x\n---\n```\n'))
    .toEqual({ paths: ['src/a.ts'], unread: [] })
})

test('a code-fence line is not a row; a prose row is still unread', () => {
  expect(deletions('## Deleted\n\n```\n- src/a.ts\n- src/b.ts\n```\n')).toEqual({ paths: ['src/a.ts', 'src/b.ts'], unread: [] })
  expect(deletions('## Deleted\n\n- src/a.ts\n```\n\n```yaml\n---\ndone:\n---\n```\n')).toEqual({ paths: ['src/a.ts'], unread: [] })
  expect(deletions('## Deleted\n\n```\n- the old spend file\n```\n')).toEqual({ paths: [], unread: ['- the old spend file'] })
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
