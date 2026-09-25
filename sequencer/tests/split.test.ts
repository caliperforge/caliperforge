import { expect, test } from 'vitest'
import { split, STANDING, unclear, wide } from '../brief.ts'
import { tick } from '../index.ts'
import { following } from '../split.ts'
import { maybe } from '../workspace.ts'
import { approve, CARRIED, internalPlan, ours, plan, stub, watched, world, type World } from './world.ts'

const ID = 2

const PARTS = ['---', 'outcome: split', 'parts:',
  '  - title: file the parts', '    what: the machine files each part', '    why: one job per ticket', '    ends: two issues exist',
  '  - title: queue them in order', '    what: a landing queues the next', '    why: order without a gate', '    ends: the last closes the parent',
  '---', ''].join('\n')

const BRIEF_OF = (paths: string[]): string => `# t\n\n## Files\n\n${paths.map((p) => `- ${p}`).join('\n')}\n`

function mine(): World {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root)
  internalPlan(w.db, w.root, ID)
  return w
}

async function briefed(w: World, id: number, brief: string, log: string[]): Promise<void> {
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched(log, w.root, id))
  await tick(w.db, w.root, stub(CARRIED, 0, undefined, undefined, brief), undefined, undefined, watched(log, w.root, id))
}

test('a split fence is two or more parts in landing order; one part or a question is not a split', () => {
  expect(split(PARTS)?.map((p) => p.title)).toEqual(['file the parts', 'queue them in order'])
  expect(split(PARTS.replace(/ {2}- title: queue[\s\S]*?parent\n/, ''))).toBeNull()
  expect(split('---\noutcome: unclear\nquestion: which one?\n---\n')).toBeNull()
})

test('a part whose prose holds a colon still reads as a split, and a question with one still reads', () => {
  const colon = PARTS.replace('ends: two issues exist', 'ends: tests show all four cases: a 3/5 is refused')
  expect(split(colon)?.[0]?.ends).toBe('tests show all four cases: a 3/5 is refused')
  expect(unclear('---\noutcome: unclear\nquestion: which of these: a or b?\n---\n')).toBe('which of these: a or b?')
})

test('past five files besides tests a brief is wide; tests do not count', () => {
  const five = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']
  expect(wide(BRIEF_OF([...five, 'tests/a.test.ts', 'x.test.ts', 'fixtures/y.md']))).toBeNull()
  expect(wide(BRIEF_OF([...five, 'f.ts']))).toBe(6)
})

test('an internal ticket split is filed as parts, the first queued, and the parent ends with no build', async () => {
  const w = mine()
  const log: string[] = []
  await briefed(w, ID, PARTS, log)
  expect(log).toEqual([
    'file caliperforge/caliperforge 34a: file the parts',
    'file caliperforge/caliperforge 34b: queue them in order',
    'comment caliperforge/caliperforge#34',
  ])
  expect(plan(w.db, ID)).toMatchObject({ state: 'done', step: 1 })
  expect(w.db.prepare('SELECT count(*) AS n FROM runs WHERE plan = ? AND step >= 2').get(ID)).toEqual({ n: 0 })
  const parts = w.db.prepare('SELECT n, url, plan FROM parts WHERE parent = ? ORDER BY n').all(ID) as
    { n: number; url: string; plan: number | null }[]
  expect(parts.map((p) => [p.n, p.url.split('/').at(-1), p.plan === null])).toEqual([[0, '901', false], [1, '902', true]])
  const first = parts[0]?.plan ?? 0
  expect(plan(w.db, first)).toMatchObject({ state: 'queued', step: 0, priority: plan(w.db, ID).priority, lane: 'machine',
    origin: 'https://github.com/caliperforge/caliperforge/issues/901' })
  expect(maybe(w.root, first, 'ask.md')).toMatch(/^# 34a: file the parts\n\n\*\*What:\*\* the machine files each part/)
  expect(w.db.prepare('SELECT body FROM parts WHERE n = 1').get()).toMatchObject({ body: expect.stringContaining('After: #901') as unknown })
})

test('a part landing queues the next; the last one landing closes the parent', async () => {
  const w = mine()
  const log: string[] = []
  await briefed(w, ID, PARTS, log)
  const a = (w.db.prepare('SELECT plan FROM parts WHERE n = 0').get() as { plan: number }).plan
  expect(following(w.db, w.root, plan(w.db, a), 'a'.repeat(40), watched(log, w.root, a))).toMatch(/^part b queued as plan \d+$/)
  const b = (w.db.prepare('SELECT plan FROM parts WHERE n = 1').get() as { plan: number }).plan
  expect(maybe(w.root, b, 'ask.md')).toContain('After: #901')
  expect(following(w.db, w.root, plan(w.db, b), 'b'.repeat(40), watched(log, w.root, b))).toBe('the last part landed; #34 closed')
  expect(log.at(-1)).toBe('close caliperforge/caliperforge#34 bbbbbbb')
  expect(following(w.db, w.root, plan(w.db, ID), 'c'.repeat(40), watched(log, w.root, ID))).toBeNull()
})

test('a split of a split, and a split of somebody else\'s ticket, wait for the COO with the parts', async () => {
  const w = mine()
  internalPlan(w.db, w.root, 3, 'the parent', 33)
  w.db.prepare("INSERT INTO parts (parent, n, url, title, body, plan) VALUES (3, 0, 'https://github.com/caliperforge/caliperforge/issues/34', 't', 'b', ?)").run(ID)
  w.db.prepare("UPDATE plans SET state = 'done' WHERE id = 3").run()
  const log: string[] = []
  await briefed(w, ID, PARTS, log)
  expect(plan(w.db, ID)).toMatchObject({ state: 'blocked_on_ceo', step: 1 })
  expect(log).toEqual([])
  expect(maybe(w.root, ID, 'question.md')).toMatch(/a split of a split is the COO's[\s\S]*a\. file the parts[\s\S]*b\. queue them in order/)
  expect(maybe(w.root, ID, 'split.md')).toBeNull()

  const out = world()
  approve(out.db, out.target)
  const theirs: string[] = []
  await briefed(out, 1, PARTS, theirs)
  expect(plan(out.db, 1)).toMatchObject({ state: 'blocked_on_ceo', step: 1 })
  expect(theirs).toEqual([])
})

test('a wide internal brief goes back to the brief writer to be split', async () => {
  const w = mine()
  const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'].map((p) => `src/${p} (new)`)
  const log: string[] = []
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched(log, w.root, ID))
  const fired = await tick(w.db, w.root, stub(CARRIED, 0, undefined, undefined, wideBrief(paths)), undefined, undefined, watched(log, w.root, ID))
  expect(fired[0]).toMatchObject({ step: 1, outcome: 'refuse', spans: ['brief.wide'] })
  expect(maybe(w.root, ID, 'refusal.md')).toContain('answer with the split fence')
  expect(maybe(w.root, ID, 'issue.md')).toBeNull()
})

function wideBrief(paths: string[]): string {
  return ['# let an internal plan run', '', '**What:** a.', '**Why:** b.', '**When it ends:** c.', '',
    '## Approach', '', 'x', '', '## Settled facts', '', '- none: every name the change uses is in this checkout', '', '## Cases', '', '- D1 one', '- D2 a call with no name is refused', '',
    '## Must not break', '', '- y', '', '## Files', '', ...paths.map((p) => `- ${p}`), '',
    '## Files to read', '', '- src/hello.ts — what it exports today', '',
    '## Who else reads what this changes', '', '- nobody else', '', '## Tests', '', '- src/a.ts — the case', '',
    '## Out of scope', '', '- z', '', '## Standing', '', ...STANDING, ''].join('\n')
}

test('parts carry the parent priority label', async () => {
  const w = mine()
  w.db.prepare('UPDATE plans SET priority = 0 WHERE id = ?').run(ID)
  const labels: string[][] = []
  const wire = (id: number) => {
    const inner = watched([], w.root, id)
    return { ...inner, file: (...a: Parameters<typeof inner.file>) => { labels.push(a[3]); return inner.file(...a) } }
  }
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire(ID))
  await tick(w.db, w.root, stub(CARRIED, 0, undefined, undefined, PARTS), undefined, undefined, wire(ID))
  expect(labels).toEqual([['lane:machine', 'P0'], ['lane:machine', 'P0']])
})
