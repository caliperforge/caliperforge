import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { approve as approvePlan } from '../../cli/batch.ts'
import { decide, digestOf, headDigest } from '../../store/approvals.ts'
import { eventsOf } from '../../store/events.ts'
import { advance } from '../../store/plans.ts'
import { approve, refuse, waiting } from '../card.ts'
import { tick } from '../index.ts'
import { headOf, push } from '../push.ts'
import { get, maybe, put, srcDir } from '../workspace.ts'
import { approve as approveTarget, CARRIED, internalPlan, plan, PR, stub, watched, world, type World } from './world.ts'

const SHA = 'a'.repeat(40)
const TARGET = { repo: 'acme/widget', issue_no: 12, named_merger: 'maintainer' }

const NONE = 'flag\toutside merges\tnone in 30 days\n'

async function atBatch(): Promise<World> {
  const w = world()
  approveTarget(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  writeFileSync(join(srcDir(w.root, 1), 'src/hello.ts'), 'export const hello = (): string => "hey"\n')
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  return w
}

async function atPush(): Promise<World> {
  const w = await atBatch()
  approvePlan(w.db, w.root, 'plan', 1, 'ceo')
  advance(w.db, plan(w.db, 1), 8)
  return w
}

const rows = (w: World, kind: string): unknown[] =>
  w.db.prepare('SELECT * FROM approvals WHERE subject_kind = ? ORDER BY id').all(kind)

test('D1 outside push: card written, no wire, held on step 8', async () => {
  const w = await atPush()
  const sent: string[] = []
  const signed = headOf(w.root, 1).sha
  const held = push(w.db, w.root, plan(w.db, 1), watched(sent, w.root, 1))
  expect(held).toMatchObject({ outcome: 'pass', held: true, spans: ['card'] })
  expect(held.note).toContain('cf approve card 1')
  expect(get(w.root, 1, 'maintainer.md')).toBe(`plan 1 at ${signed}\npass\tlead\twhole issue, 1 lead(s)\npass\ttests\t+0 test / +1 code lines\npass\tconventions\tmatches the last 1 commits\npass\tsize\t2 code lines (2 in all), limit 400\npass\tprose\tclean\n${NONE}`)
  expect(sent).toEqual([])
  expect(plan(w.db, 1).step).toBe(8)
})

test('D9 a tell in pr.md is flagged and held until approved', async () => {
  const w = await atPush()
  const sent: string[] = []
  const wire = watched(sent, w.root, 1)
  put(w.root, 1, 'pr.md', 'Addresses #12.\n\nThis is robust.\n')
  expect(push(w.db, w.root, plan(w.db, 1), wire)).toMatchObject({ outcome: 'pass', held: true, spans: ['card'] })
  expect(get(w.root, 1, 'maintainer.md')).toContain('\nflag\tprose\tbody:3 tell:robust\n')
  expect(sent).toEqual([])
  approve(w.db, w.root, 1, 'ceo')
  expect(push(w.db, w.root, plan(w.db, 1), wire)).toMatchObject({ note: `pushed widget-12-a1 as ${PR}` })
})

test('a pr.md line naming a changed file flags on the card', async () => {
  const w = await atPush()
  const sent: string[] = []
  put(w.root, 1, 'pr.md', 'Addresses #12.\n\n- Updated src/hello.ts so hello() says hey.\n')
  expect(push(w.db, w.root, plan(w.db, 1), watched(sent, w.root, 1))).toMatchObject({ outcome: 'pass', held: true, spans: ['card'] })
  expect(get(w.root, 1, 'maintainer.md')).toContain('\nflag\tprose\tbody:3 tight.summary')
  expect(sent).toEqual([])
})

test('D2 an approved card sends and opens beside one step-7 row', async () => {
  const w = await atPush()
  const sent: string[] = []
  const wire = watched(sent, w.root, 1)
  const signed = rows(w, 'plan')
  push(w.db, w.root, plan(w.db, 1), wire)
  approve(w.db, w.root, 1, 'ceo')
  expect(push(w.db, w.root, plan(w.db, 1), wire)).toMatchObject({ outcome: 'pass', spans: [], note: `pushed widget-12-a1 as ${PR}` })
  expect(sent).toEqual(['send src widget-12-a1', 'unrehearse caliperforge/widget widget-12-a1-next', 'open acme/widget caliperforge:widget-12-a1'])
  expect(rows(w, 'publish')).toMatchObject([{ who: 'ceo', decision: 'approved', subject_digest: digestOf(get(w.root, 1, 'maintainer.md')) }])
  expect(rows(w, 'plan')).toEqual(signed)
  expect(signed).toHaveLength(1)
  expect(eventsOf(w.db, 1, 'card')).toMatchObject([{ actor: 'ceo', outcome: 'pass' }])
})

test('D3 a failing check is a flag row, held until approved', () => {
  const w = world()
  const lint = (): { check: string; ok: boolean; says: string } => ({ check: 'lint', ok: false, says: 'two errors' })
  const held = waiting(w.db, w.root, 1, SHA, TARGET, [lint])
  expect(held).toMatchObject({ outcome: 'pass', held: true, spans: ['card'] })
  expect(held?.note).toContain('1 flag(s)')
  expect(get(w.root, 1, 'maintainer.md')).toBe(`plan 1 at ${SHA}\nflag\tlint\ttwo errors\n`)
  approve(w.db, w.root, 1, 'ceo')
  expect(waiting(w.db, w.root, 1, SHA, TARGET, [lint])).toBeNull()
})

test('D4 approving a stale card rewrites it and sends nothing', async () => {
  const w = await atPush()
  const sent: string[] = []
  const wire = watched(sent, w.root, 1)
  push(w.db, w.root, plan(w.db, 1), wire)
  approve(w.db, w.root, 1, 'ceo')
  const pass = (): { check: string; ok: boolean; says: string } => ({ check: 'lint', ok: true, says: 'clean' })
  const sha = headOf(w.root, 1).sha
  expect(waiting(w.db, w.root, 1, sha, TARGET, [pass])).toMatchObject({ held: true })
  expect(get(w.root, 1, 'maintainer.md')).toBe(`plan 1 at ${sha}\npass\tlint\tclean\n`)
  push(w.db, w.root, plan(w.db, 1), wire)
  const src = srcDir(w.root, 1)
  writeFileSync(join(src, 'src/hello.ts'), 'export const hello = (): string => "hi"\n')
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'again'], { cwd: src })
  const moved = headOf(w.root, 1).sha
  decide(w.db, 'plan', 1, headDigest(moved), null)
  const before = sent.length
  expect(push(w.db, w.root, plan(w.db, 1), wire)).toMatchObject({ outcome: 'pass', held: true, spans: ['card'] })
  expect(get(w.root, 1, 'maintainer.md')).toBe(`plan 1 at ${moved}\npass\tlead\twhole issue, 1 lead(s)\npass\ttests\t+0 test / +0 code lines\npass\tconventions\tmatches the last 1 commits\npass\tsize\t0 code lines (0 in all), limit 400\npass\tprose\tclean\n${NONE}`)
  expect(sent.slice(before)).toEqual([])
  approve(w.db, w.root, 1, 'ceo')
  expect(push(w.db, w.root, plan(w.db, 1), wire)).toMatchObject({ note: `pushed widget-12-a1 onto ${PR}` })
})

test('D5 a refused card routes to the ceo and sends nothing', async () => {
  const w = await atPush()
  const sent: string[] = []
  const wire = watched(sent, w.root, 1)
  push(w.db, w.root, plan(w.db, 1), wire)
  refuse(w.db, w.root, 1, 'not_yet', 'ceo')
  expect(push(w.db, w.root, plan(w.db, 1), wire)).toMatchObject({ outcome: 'needs_ceo', spans: ['card'] })
  expect(sent).toEqual([])
})

test('D6 approve or refuse with no card throws, writes no row', () => {
  const w = world()
  expect(() => approve(w.db, w.root, 1, 'ceo')).toThrow('plan 1 has no card')
  expect(() => refuse(w.db, w.root, 1, 'not_yet', 'ceo')).toThrow('plan 1 has no card')
  expect(rows(w, 'publish')).toEqual([])
  expect(eventsOf(w.db, 1, 'card')).toEqual([])
})

test('D7 with no step-7 row push refuses and writes no card', async () => {
  const w = await atBatch()
  expect(push(w.db, w.root, plan(w.db, 1), watched([], w.root, 1))).toMatchObject({ outcome: 'refuse', spans: ['approvals'] })
  expect(maybe(w.root, 1, 'maintainer.md')).toBeNull()
})

test('D8 an internal plan writes no card and waits on none', () => {
  const w = world()
  internalPlan(w.db, w.root, 2)
  expect(push(w.db, w.root, plan(w.db, 2), watched([], w.root, 2))).toMatchObject({ outcome: 'refuse', spans: ['deliverables'] })
  expect(maybe(w.root, 2, 'maintainer.md')).toBeNull()
})
