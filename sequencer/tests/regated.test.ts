import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Provider } from '../../providers/kind.ts'
import { dispositionsOf, unsettled } from '../../store/dispositions.ts'
import { tick } from '../index.ts'
import { srcDir } from '../workspace.ts'
import { approve, builds, CARRIED, plan, stub, watched, WORDS, world, type World } from './world.ts'

const HELLO = 'src/hello.ts'
const SPAN = `${HELLO}:1`
const FIX = 'export const hello = (): string => "hey"'

function fence(...spans: string[]): string {
  return `${WORDS}\n\n---\noutcome: refuse\nclass: minimal\nspans:\n${spans.join('\n')}\n---\n`
}

function cosmetic(span: string, fix: string): string {
  return `  - span: ${span}\n    kind: cosmetic\n    fix: ${JSON.stringify(fix)}`
}

function writes(root: string, id: number, body: string): () => void {
  return () => { writeFileSync(join(srcDir(root, id), HELLO), body) }
}

/** A target plan standing on step 4. */
async function toReview(): Promise<World> {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  return w
}

async function refused(w: World, id: number, provider: Provider): Promise<void> {
  const fired = (await tick(w.db, w.root, provider))[0]
  expect(fired).toMatchObject({ step: 4, outcome: 'refuse', state: 'retried' })
  expect(plan(w.db, id)).toMatchObject({ step: 2, retries: 1 })
}

function dispositions(w: World): unknown[] {
  expect(unsettled(w.db, 1, 4, Number.MAX_SAFE_INTEGER)).toBeUndefined()
  return dispositionsOf(w.db)
}

const EVIDENCE: unknown = expect.stringMatching(/^verdicts:\d+$/)

function fixed(defect_class: string): unknown[] {
  return [{ kind: 'fixed', defect_class, owner: 'review', evidence: EVIDENCE }]
}

/** Refused at step 4 with `review`, rebuilt to `FIX`, and passed at step 4. */
async function regated(review: string): Promise<World> {
  const w = await toReview()
  await refused(w, 1, stub(CARRIED, 0, review))
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, builds(writes(w.root, 1, `${FIX}\n`)), undefined, undefined, watched([], w.root, 1))
  expect(plan(w.db, 1)).toMatchObject({ step: 5, retries: 1 })
  return w
}

test('a refusal passed after a rebuild settles fixed', async () => {
  const w = await regated(fence(`  - ${SPAN}`))
  expect(dispositions(w)).toEqual(fixed('minimal'))
})

test('a cosmetic-only refusal goes back to the build and settles', async () => {
  const w = await regated(fence(cosmetic(SPAN, FIX)))
  expect(dispositions(w)).toEqual(fixed('minimal'))
})

test('a class outside the build map settles as correctness', async () => {
  const w = await regated(fence(`  - ${SPAN}`).replace('class: minimal', 'class: vibes'))
  expect(dispositions(w)).toEqual(fixed('correctness'))
})
