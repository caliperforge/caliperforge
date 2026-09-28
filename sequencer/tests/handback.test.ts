import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Provider } from '../../providers/kind.ts'
import { tick } from '../index.ts'
import { diffOf, get, maybe } from '../workspace.ts'
import { approve, built, CARRIED, plan, stub, watched, world, type World } from './world.ts'

const UNPOINTED = 'built\n\n---\ndone:\n  - id: D1\n    status: done\n    pointer:\n---\n'

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

const builderRuns = (w: World): unknown => w.db.prepare('SELECT count(*) AS n FROM runs WHERE plan = 1 AND step = 2').get()

test('D1 a hand-back with no fence is asked once for the fence, and the audit passes on the diff it left', async () => {
  const w = await atBuild()
  const diffs: string[] = []
  const fired = (await tick(w.db, w.root, answers(['built', CARRIED], (n) => { if (n === 1) diffs.push(diffOf(w.root, 1)) })))[0]
  diffs.push(diffOf(w.root, 1))
  expect(fired).toMatchObject({ step: 2, outcome: 'pass' })
  expect(builderRuns(w)).toEqual({ n: 2 })
  expect(get(w.root, 1, 'step-2.handback.md')).toBe(CARRIED)
  expect(diffs[0]).toBe(diffs[1])
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  expect(w.db.prepare("SELECT outcome FROM verdicts WHERE plan = 1 AND rail_id = 'completion-audit'").get())
    .toEqual({ outcome: 'pass' })
})

test('D1 a fence whose YAML does not parse is re-asked, and the kept file holds only the answer\'s fence', async () => {
  const w = await atBuild()
  await tick(w.db, w.root, answers(['built\n\n---\ndone: [\n---\n', CARRIED]))
  expect(builderRuns(w)).toEqual({ n: 2 })
  expect(get(w.root, 1, 'step-2.handback.md')).toBe(CARRIED)
})

test('D2 a re-ask answer that edits the tree is refused on the hand-back', async () => {
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

test('D1 a build whose test run never finished is refused at step 3 leading with the command', async () => {
  const w = await atBuild()
  await tick(w.db, w.root, unfinishedBuild())
  expect((await tick(w.db, w.root, stub(UNPOINTED)))[0]).toMatchObject({ step: 3, outcome: 'refuse' })
  expect(refusalNote(w)).toMatch(/^the builder's test run did not finish: npm test; completion-audit: /)
})

test('D2 a build with no moved-to-background result is refused as today', async () => {
  const w = await atBuild()
  await tick(w.db, w.root, stub(UNPOINTED))
  expect((await tick(w.db, w.root, stub(UNPOINTED)))[0]).toMatchObject({ step: 3, outcome: 'refuse' })
  expect(refusalNote(w)).toMatch(/^completion-audit: /)
  expect(maybe(w.root, 1, 'step-2.unfinished.md')).toBeNull()
})

const EMPTY = /changed no file and handed back no fence; a file the ask removes goes under `## Deleted`/

test('D1 a build with an empty diff and no fence is refused at step 2', async () => {
  const w = await atBuild()
  const fired = (await tick(w.db, w.root, answers(['', ''])))[0]
  expect(fired).toMatchObject({ step: 2, outcome: 'refuse', spans: ['step-2.handback.md'] })
  expect(fired?.note).toMatch(EMPTY)
  expect(plan(w.db, 1).step).toBe(2)
})

test('D2 the same empty build again stops the plan for a person with the note', async () => {
  const w = await atBuild()
  await tick(w.db, w.root, answers(['', '']))
  const fired = (await tick(w.db, w.root, answers(['', ''])))[0]
  expect(plan(w.db, 1).state).toBe('blocked_on_ceo')
  expect(fired?.note).toMatch(EMPTY)
})

test('D3 a fenceless hand-back on a build that changed a file passes step 2', async () => {
  const w = await atBuild()
  const fired = (await tick(w.db, w.root, answers(['built', 'built'], (n) => { if (n === 0) built(w.root, 1, 'export const more = 1') })))[0]
  expect(fired).toMatchObject({ step: 2, outcome: 'pass' })
})

test('D5 a fenceless hand-back naming a file under ## Deleted passes step 2', async () => {
  const w = await atBuild()
  const text = 'built\n\n## Deleted\n\n- src/hello.ts\n'
  expect((await tick(w.db, w.root, answers([text, text])))[0]).toMatchObject({ step: 2, outcome: 'pass' })
})

test('D3 a hand-back whose fence parses fires the builder once', async () => {
  for (const text of [CARRIED, UNPOINTED]) {
    const w = await atBuild()
    await tick(w.db, w.root, stub(text))
    expect(builderRuns(w)).toEqual({ n: 1 })
  }
})
