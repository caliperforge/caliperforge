import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Provider } from '../../providers/kind.ts'
import { runRows } from '../../store/events.ts'
import { holdOf } from '../../store/holds.ts'
import { refusedOf } from '../../store/record.ts'
import { verdictRows } from '../../store/verdict.ts'
import { tick } from '../index.ts'
import { diffOf, get, maybe, put, srcDir } from '../workspace.ts'
import { approve, built, CARRIED, plan, stub, watched, world, type World } from './world.ts'

const UNPOINTED = 'built\n\n---\ndone:\n  - id: D1\n    status: done\n    pointer:\n---\n'
const REFENCED = `built\n\n${CARRIED.slice(CARRIED.indexOf('---\n'))}`

/** The builder answers its n-th fire with `texts[n]`, running `edit(n)` first; every other seat answers as `stub` does. */
function answers(texts: string[], edit: (n: number) => void = () => undefined): Provider {
  const inner = stub(CARRIED)
  let n = 0
  return {
    ...inner,
    fire: async (packet) => {
      if (!packet.tools.includes('Write')) return inner.fire(packet)
      edit(n)
      const text = texts[n] ?? CARRIED
      n += 1
      return { ...await inner.fire(packet), text }
    },
  }
}

async function atBuild(): Promise<World> {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
  return w
}

const builderRuns = (w: World): number => runRows(w.db).filter((r) => r.plan === 1 && r.step === 2).length

test('D1 a fenceless hand-back is asked once; the audit passes', async () => {
  const w = await atBuild()
  const diffs: string[] = []
  const fired = (await tick(w.db, w.root, answers(['built', CARRIED], (n) => { if (n === 1) diffs.push(diffOf(w.root, 1)) })))[0]
  diffs.push(diffOf(w.root, 1))
  expect(fired).toMatchObject({ step: 2, outcome: 'pass' })
  expect(builderRuns(w)).toBe(2)
  expect(get(w.root, 1, 'step-2.handback.md')).toBe(REFENCED)
  expect(diffs[0]).toBe(diffs[1])
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  expect(verdictRows(w.db, 1).find((v) => v.rail_id === 'completion-audit')?.outcome).toBe('pass')
})

test('D1 unparsable YAML is re-asked; the answer\'s fence is kept', async () => {
  const w = await atBuild()
  await tick(w.db, w.root, answers(['built\n\n---\ndone: [\n---\n', CARRIED]))
  expect(builderRuns(w)).toBe(2)
  expect(get(w.root, 1, 'step-2.handback.md')).toBe(REFENCED)
})

test('D2 a re-ask answer that edits the tree is refused', async () => {
  const w = await atBuild()
  const fired = (await tick(w.db, w.root, answers(['built', CARRIED], (n) => { if (n === 1) built(w.root, 1, 'export const more = 1') })))[0]
  expect(fired).toMatchObject({ step: 2, outcome: 'refuse', spans: ['step-2.handback.md'] })
})

const MOVED = join(import.meta.dirname, '../../store/fixtures/unfinished.transcript.jsonl')

/** The builder hands back UNPOINTED from a transcript whose test run was moved to the background. */
function unfinishedBuild(): Provider {
  const inner = stub(UNPOINTED)
  return {
    ...inner,
    fire: async (packet) => {
      const fired = await inner.fire(packet)
      if (packet.tools.includes('Write')) copyFileSync(MOVED, packet.transcript)
      return fired
    },
  }
}

const refusalNote = (w: World): string => get(w.root, 1, 'refusal.md').split('\n')[2] ?? ''

test('D1 an unfinished test run refuses at step 3, command first', async () => {
  const w = await atBuild()
  await tick(w.db, w.root, unfinishedBuild())
  expect((await tick(w.db, w.root, stub(UNPOINTED)))[0]).toMatchObject({ step: 3, outcome: 'refuse' })
  expect(refusalNote(w)).toMatch(/^the builder's test run did not finish: npm test; completion-audit: /)
})

test('D2 no moved-to-background result is refused as today', async () => {
  const w = await atBuild()
  await tick(w.db, w.root, stub(UNPOINTED))
  expect((await tick(w.db, w.root, stub(UNPOINTED)))[0]).toMatchObject({ step: 3, outcome: 'refuse' })
  expect(refusalNote(w)).toMatch(/^completion-audit: /)
  expect(maybe(w.root, 1, 'step-2.unfinished.md')).toBeNull()
})

const EMPTY = /changed no file and handed back no fence; a file the ask removes goes under `## Deleted`/

test('D1 an empty diff with no fence is refused at step 2', async () => {
  const w = await atBuild()
  const fired = (await tick(w.db, w.root, answers(['', ''])))[0]
  expect(fired).toMatchObject({ step: 2, outcome: 'refuse', spans: ['step-2.handback.md'] })
  expect(fired?.note).toMatch(EMPTY)
  expect(plan(w.db, 1).step).toBe(2)
})

test('D2 a second empty build stops for a person with the note', async () => {
  const w = await atBuild()
  await tick(w.db, w.root, answers(['', '']))
  const fired = (await tick(w.db, w.root, answers(['', ''])))[0]
  expect(plan(w.db, 1).state).toBe('blocked_on_ceo')
  expect(fired?.note).toMatch(EMPTY)
})

test('D3 a fenceless hand-back that changed a file passes step 2', async () => {
  const w = await atBuild()
  const fired = (await tick(w.db, w.root, answers(['built', 'built'], (n) => { if (n === 0) built(w.root, 1, 'export const more = 1') })))[0]
  expect(fired).toMatchObject({ step: 2, outcome: 'pass' })
})

test('D1 a fenceless hand-back deleting a listed file passes', async () => {
  const w = await atBuild()
  const text = 'built\n\n## Deleted\n\n- src/hello.ts\n'
  const fired = (await tick(w.db, w.root, answers([text, text])))[0]
  expect(fired).toMatchObject({ step: 2, outcome: 'pass' })
  expect(existsSync(join(srcDir(w.root, 1), 'src/hello.ts'))).toBe(false)
  expect(diffOf(w.root, 1)).toContain('deleted file')
})

const NOT_DONE = 'Not done: this round only allowed changes to kotlin-ci.yml:23'

test('D4 a Not done hand-back stops for the director at step 3', async () => {
  const w = await atBuild()
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(`${NOT_DONE}\n\n${CARRIED}`))
  expect(plan(w.db, 1)).toMatchObject({ state: 'blocked_on_ceo', step: 3 })
  expect(holdOf(w.db, 1)?.held_why).toMatch(/^completion-audit: Not done: /)
  expect(refusedOf(w.db, 1)[0]?.message).toBe(NOT_DONE)
})

const BRIEF_WRONG = CARRIED.replaceAll('status: done\n    pointer: src/hello.ts:1', 'status: brief-wrong\n    why: the ask names a file that is not there')

test('D4 a brief-wrong hand-back stops for the director', async () => {
  const w = await atBuild()
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(BRIEF_WRONG))
  expect(plan(w.db, 1)).toMatchObject({ state: 'blocked_on_ceo', step: 3 })
  expect(holdOf(w.db, 1)?.held_why).toMatch(/^completion-audit: brief-wrong: /)
})

test('D5 an unmoved diff after a new ruling stops at step 3', async () => {
  const w = await atBuild()
  await tick(w.db, w.root, stub(UNPOINTED))
  expect((await tick(w.db, w.root, stub(UNPOINTED)))[0]).toMatchObject({ step: 3, outcome: 'refuse' })
  put(w.root, 1, 'rulings.md', 'use bye()\n')
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(UNPOINTED))
  expect(plan(w.db, 1)).toMatchObject({ state: 'blocked_on_ceo', step: 3 })
  expect(holdOf(w.db, 1)?.held_why).toMatch(/^completion-audit: rulings.md/)
})

test('D1 a new ruling with a new hand-back runs the rails', async () => {
  const w = await atBuild()
  await tick(w.db, w.root, stub(UNPOINTED))
  expect((await tick(w.db, w.root, stub(UNPOINTED)))[0]).toMatchObject({ step: 3, outcome: 'refuse' })
  put(w.root, 1, 'rulings.md', 'use bye()\n')
  await tick(w.db, w.root, answers([CARRIED]))
  const lap = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1)))[0]
  expect(lap?.note).not.toMatch(/rulings.md changed/)
  expect(plan(w.db, 1).state).not.toBe('blocked_on_ceo')
  expect(holdOf(w.db, 1)?.held_why ?? '').not.toMatch(/rulings.md/)
})

const STANDS = '**Ruling (COO, 2026-10-20):** park on #1394; it comes back to step 3 with this tree.\nDiff stands.\n'

/** Refuses one lap, puts `rulings`, then builds again, running `edit` on the root first. */
async function ruled(rulings: string, edit: (root: string) => void = () => undefined): Promise<World> {
  const w = await atBuild()
  await tick(w.db, w.root, stub(UNPOINTED))
  expect((await tick(w.db, w.root, stub(UNPOINTED)))[0]).toMatchObject({ step: 3, outcome: 'refuse' })
  put(w.root, 1, 'rulings.md', rulings)
  await tick(w.db, w.root, answers([UNPOINTED], () => { edit(w.root) }))
  return w
}

test('D1 a Diff stands. ruling on the same diff runs the rails', async () => {
  const w = await ruled(STANDS)
  const lap = (await tick(w.db, w.root, stub(UNPOINTED)))[0]
  expect(lap).toMatchObject({ step: 3 })
  expect(lap?.note).not.toMatch(/rulings.md changed/)
  expect(holdOf(w.db, 1)?.held_why ?? '').not.toMatch(/^completion-audit: rulings.md/)
})

test('D3 a new ruling with a moved tree runs the rails', async () => {
  const w = await ruled('use bye()\n', (root) => { built(root, 1, 'export const more = 1') })
  const lap = (await tick(w.db, w.root, stub(UNPOINTED)))[0]
  expect(lap).toMatchObject({ step: 3 })
  expect(lap?.note).not.toMatch(/rulings.md changed/)
})

test('D4 an older Diff stands. does not clear a newer ruling', async () => {
  const w = await ruled(`${STANDS}**Ruling (COO, 2026-10-21):** use bye()\n`)
  await tick(w.db, w.root, stub(UNPOINTED))
  expect(plan(w.db, 1)).toMatchObject({ state: 'blocked_on_ceo', step: 3 })
  expect(holdOf(w.db, 1)?.held_why).toMatch(/^completion-audit: rulings.md/)
})

test('D3 a hand-back whose fence parses fires the builder once', async () => {
  for (const text of [CARRIED, UNPOINTED]) {
    const w = await atBuild()
    await tick(w.db, w.root, stub(text))
    expect(builderRuns(w)).toBe(1)
  }
})
