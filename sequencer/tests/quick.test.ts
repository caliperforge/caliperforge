import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Provider } from '../../providers/kind.ts'
import { dispositionsOf, unsettled } from '../../store/dispositions.ts'
import { tick } from '../index.ts'
import { get, srcDir } from '../workspace.ts'
import { OOPS } from './bases.ts'
import { approve, builds, CARRIED, internalPlan, ours, plan, stub, watched, WORDS, world, type World } from './world.ts'

const SLOW = 30000
const ID = 2
const HELLO = 'src/hello.ts'
const SPAN = `${HELLO}:1`
const FIX = 'export const hello = (): string => "hey"'

function fence(...spans: string[]): string {
  return `${WORDS}\n\n---\noutcome: refuse\nclass: minimal\nspans:\n${spans.join('\n')}\n---\n`
}

function cosmetic(span: string, fix: string): string {
  return `  - span: ${span}\n    kind: cosmetic\n    fix: ${JSON.stringify(fix)}`
}

function writes(root: string, id: number, body: string, path = HELLO): () => void {
  return () => { writeFileSync(join(srcDir(root, id), path), body) }
}

/** Twenty exported lines, the ones `changed` names under a second letter, so two grids differ on exactly those. */
function grid(changed: number[]): string {
  return `${[...Array(20).keys()].map((i) =>
    `export const ${changed.includes(i + 1) ? 'b' : 'a'}${String(i + 1)} = ${String(i + 1)}`).join('\n')}\n`
}

const ELEVEN = [...Array(11).keys()].map((i) => i + 6)

/** A target plan standing on step 4, with `body` in `src/hello.ts` as its builder left it. */
async function toReview(body?: string): Promise<World> {
  const w = world()
  approve(w.db, w.target)
  const provider = body === undefined ? stub(CARRIED) : builds(writes(w.root, 1, body))
  for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, provider, undefined, undefined, watched([], w.root, 1))
  return w
}

async function refused(w: World, id: number, provider: Provider): Promise<void> {
  const fired = (await tick(w.db, w.root, provider))[0]
  expect(fired).toMatchObject({ step: 4, outcome: 'refuse', state: 'retried' })
  expect(plan(w.db, id)).toMatchObject({ step: 2, retries: 1 })
}

test('a cosmetic-only refusal is fixed in place and passes step 4', async () => {
  const w = await toReview()
  const fired = (await tick(w.db, w.root, builds(writes(w.root, 1, `${FIX}\n`), fence(cosmetic(SPAN, FIX)))))[0]
  expect(fired).toMatchObject({ step: 4, outcome: 'pass', state: 'running' })
  expect(plan(w.db, 1)).toMatchObject({ step: 5, retries: 0 })
  expect(readFileSync(join(srcDir(w.root, 1), HELLO), 'utf8')).toBe(`${FIX}\n`)
  expect(get(w.root, 1, 'step-2.handback.md')).toBe(CARRIED)
})

test('the round leaves a quick_lane pass row and step-2 tokens', async () => {
  const w = await toReview()
  await tick(w.db, w.root, builds(writes(w.root, 1, `${FIX}\n`), fence(cosmetic(SPAN, FIX))))
  expect(w.db.prepare("SELECT outcome, quick_lane, step FROM verdicts WHERE plan = 1 AND gate = 'review' ORDER BY id").all())
    .toEqual([{ outcome: 'refuse', quick_lane: 0, step: 4 }, { outcome: 'pass', quick_lane: 1, step: 4 }])
  expect(w.db.prepare('SELECT seat, input_tokens + cache_read_tokens + output_tokens AS tokens FROM runs WHERE plan = 1 AND step = 2').all())
    .toEqual([{ seat: 'outside_specialist', tokens: 60 }, { seat: 'outside_specialist', tokens: 60 }])
  expect(w.db.prepare('SELECT count(*) AS n FROM runs WHERE plan = 1 AND step IN (4, 5)').get()).toEqual({ n: 1 })
})

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

test('the quick lane settles the refusal it fixed in place', async () => {
  const w = await toReview()
  await tick(w.db, w.root, builds(writes(w.root, 1, `${FIX}\n`), fence(cosmetic(SPAN, FIX))))
  expect(dispositions(w)).toEqual(fixed('minimal'))
})

test('a class outside the build map settles as correctness', async () => {
  const w = await regated(fence(`  - ${SPAN}`).replace('class: minimal', 'class: vibes'))
  expect(dispositions(w)).toEqual(fixed('correctness'))
})

test('a bare span keeps the lap and both entries round-trip', async () => {
  const w = await toReview()
  await refused(w, 1, stub(CARRIED, 0, fence(cosmetic(SPAN, FIX), `  - ${HELLO}:2`)))
  expect(w.db.prepare('SELECT count(*) AS n FROM runs WHERE plan = 1 AND step = 2').get()).toEqual({ n: 1 })
  expect(get(w.root, 1, 'step-4.verdict.md'))
    .toBe(`---\noutcome: refuse\nclass: minimal\nspans:\n${cosmetic(SPAN, FIX)}\n  - ${HELLO}:2\n---\n\n${WORDS}\n`)
})

test('a fix off the spans, over 20 lines or in tests keeps the lap', async () => {
  const far = await toReview(grid([]))
  await refused(far, 1, builds(writes(far.root, 1, grid([20])), fence(cosmetic(SPAN, 'export const b20 = 20'))))

  const many = await toReview(grid([]))
  await refused(many, 1, builds(writes(many.root, 1, grid(ELEVEN)), fence(cosmetic(`${HELLO}:11`, 'export const b11 = 11'))))

  const suite = await toReview()
  await refused(suite, 1, builds(writes(suite.root, 1, 'export const t = 1\n', 'src/hello.test.ts'),
    fence(cosmetic('src/hello.test.ts:1', 'export const t = 1'))))
})

test('a builder that exits non-zero keeps the lap', async () => {
  const w = await toReview()
  await refused(w, 1, builds(writes(w.root, 1, `${FIX}\n`), fence(cosmetic(SPAN, FIX)), 1))
})

async function internalReview(): Promise<World> {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root, OOPS)
  internalPlan(w.db, w.root, ID)
  for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, builds(writes(w.root, ID, `// hi\n${HI}`)))
  return w
}

test('a fix the checkout\'s own checks refuse keeps the lap', async () => {
  const w = await internalReview()
  const oops = 'export const oops = 1'
  await refused(w, ID, builds(writes(w.root, ID, `${oops}\n`), fence(cosmetic(SPAN, oops))))
}, SLOW)

const HI = 'export const hello = (): string => "hi"\n'

function note(old: string, next: string, kind = 'text', file = HELLO): string {
  return `  - file: ${file}\n    line: 1\n    old: ${JSON.stringify(old)}\n    new: ${JSON.stringify(next)}\n    why: tidy\n    kind: ${kind}`
}

function noted(...notes: string[]): string {
  return `---\noutcome: pass\nnotes:\n${notes.join('\n')}\n---\n`
}

function hello(w: World, id = 1): string {
  return readFileSync(join(srcDir(w.root, id), HELLO), 'utf8')
}

function notes(w: World, id = 1): unknown {
  return w.db.prepare("SELECT count(*) AS n FROM events WHERE plan = ? AND kind = 'note'").get(id)
}

test('a note removing a comment lands; step 5 with no new build', async () => {
  const w = await toReview(`// the greeting\n${HI}`)
  const fired = (await tick(w.db, w.root, stub(CARRIED, 0, noted(note('// the greeting\n', '')))))[0]
  expect(fired).toMatchObject({ step: 4, outcome: 'pass', state: 'running' })
  expect(plan(w.db, 1)).toMatchObject({ step: 5, retries: 0 })
  expect(w.db.prepare('SELECT count(*) AS n FROM runs WHERE plan = 1 AND step = 2').get()).toEqual({ n: 1 })
  expect(hello(w)).toBe(HI)
  expect(dispositions(w)).toEqual([])
})

test('a note that changes code refuses and leaves the file alone', async () => {
  const body = 'export const hello = (a: string): string => `${a} x`\nexport const LIMIT = 30 / 2\nexport const t = `y`\n'
  const w = await toReview(body)
  await refused(w, 1, stub(CARRIED, 0, noted(note('= 30', '= 31', 'count'))))
  expect(hello(w)).toBe(body)

  const python = 'def ok():\n    return True\n'
  const py = await toReview()
  const path = join(srcDir(py.root, 1), 'src/hello.py')
  await refused(py, 1, stub(CARRIED, 0, noted(note('True', 'False', 'text', 'src/hello.py')), () => { writeFileSync(path, python) }))
  expect(readFileSync(path, 'utf8')).toBe(python)
})

test('notes on missing text or off the diff drop; the rest land', async () => {
  const w = await toReview(`// one\n${HI}`)
  const fired = (await tick(w.db, w.root, stub(CARRIED, 0, noted(note('nowhere', 'here'), note('x', 'y', 'text', 'PR body'), note('// one\n', '')))))[0]
  expect(fired).toMatchObject({ step: 4, outcome: 'pass' })
  expect(plan(w.db, 1)).toMatchObject({ step: 5, retries: 0 })
  expect(hello(w)).toBe(HI)
  expect(w.db.prepare("SELECT message, pointer FROM events WHERE plan = 1 AND kind = 'note' AND message LIKE 'dropped:%' ORDER BY id").all())
    .toEqual([
      { message: 'dropped: old text matches 0 times', pointer: SPAN },
      { message: 'dropped: not a file in the diff', pointer: 'PR body:1' },
    ])
  expect(w.db.prepare('SELECT count(*) AS n FROM refusals WHERE plan = 1').get()).toEqual({ n: 0 })
})

test('a restore note to the base\'s text lands though tokens differ', async () => {
  const w = await toReview('export const hello = (): number => 1\n')
  await tick(w.db, w.root, stub(CARRIED, 0, noted(note('(): number => 1', '(): string => "hi"', 'restore'))))
  expect(plan(w.db, 1)).toMatchObject({ step: 5, retries: 0 })
  expect(hello(w)).toBe(HI)
})

test('each applied note logs one event; a refused set logs none', async () => {
  const w = await toReview(`// one\n// two\n${HI}`)
  await tick(w.db, w.root, stub(CARRIED, 0, noted(note('// one\n', ''), note('// two\n', ''))))
  expect(notes(w)).toEqual({ n: 2 })

  const refusing = await toReview('export const hello = (): number => 1\n')
  await refused(refusing, 1, stub(CARRIED, 0, noted(note('x', 'y', 'text', 'PR body'), note('=> 1', '=> 2', 'count'))))
  expect(notes(refusing)).toEqual({ n: 0 })
})

test('notes the checks refuse are put back and dropped; it passes', async () => {
  const w = await internalReview()
  const fired = (await tick(w.db, w.root, stub(CARRIED, 0, noted(note('hello', 'oops'), note('"hi"', '"hey"')))))[0]
  expect(fired).toMatchObject({ step: 4, outcome: 'pass' })
  expect(plan(w.db, ID)).toMatchObject({ step: 5, retries: 0 })
  expect(hello(w, ID)).toBe(`// hi\n${HI}`)
  expect(w.db.prepare("SELECT message FROM events WHERE plan = ? AND kind = 'note'").all(ID))
    .toEqual([{ message: 'dropped: lint failed after the notes' }, { message: 'dropped: lint failed after the notes' }])
}, SLOW)
