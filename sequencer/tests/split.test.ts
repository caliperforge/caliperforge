import { expect, test } from 'vitest'
import { split, STANDING, unclear, wide } from '../brief.ts'
import { tick } from '../index.ts'
import { assembly } from '../home.ts'
import { following, languages, parted, released } from '../split.ts'
import { languageFor } from '../route.ts'
import type { Wire } from '../push.ts'
import { maybe, put, srcDir } from '../workspace.ts'
import { record } from '../../store/files.ts'
import { builder } from '../../templates/pr-path.ts'
import { ofKind, runRows } from '../../store/events.ts'
import { priority } from '../../store/lanes.ts'
import { setLimit } from '../../store/limits.ts'
import { addPart, allParts } from '../../store/parts.ts'
import { dropPlan, finish } from '../../store/plans.ts'
import { afterOf, recordListing } from '../../store/tickets.ts'
import { approve, CARRIED, internalPlan, ours, plan, stub, watched, world, type World } from './world.ts'

const ID = 2

const PARTS = ['---', 'outcome: split', 'parts:',
  '  - title: file the parts', '    what: the machine files each part', '    why: one job per ticket', '    ends: two issues exist',
  '  - title: queue them in order', '    what: a landing queues the next', '    why: order without a gate', '    ends: the last closes the parent',
  '---', ''].join('\n')

const AFTER = (after: (string | null)[]): string => ['---', 'outcome: split', 'parts:',
  ...after.flatMap((a, i) => [`  - title: part ${String(i)}`, '    what: w', '    why: y', '    ends: e', ...a === null ? [] : [`    after: ${a}`]]),
  '---', ''].join('\n')

const BRIEF_OF = (paths: string[]): string => `# t\n\n## Files\n\n${paths.map((p) => `- ${p}`).join('\n')}\n`

function mine(): World {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, ID)
  return w
}

function partPlan(w: World, n: number): number | null | undefined {
  return allParts(w.db).find((p) => p.parent === ID && p.n === n)?.plan
}

async function briefed(w: World, id: number, brief: string, log: string[], wire = watched(log, w.root, id)): Promise<void> {
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  await tick(w.db, w.root, stub(CARRIED, 0, undefined, undefined, brief), undefined, undefined, wire)
}

function landing(w: World, n: number, log: string[]): string | null {
  const id = partPlan(w, n) ?? 0
  const note = following(w.db, w.root, plan(w.db, id), String(n).repeat(40), watched(log, w.root, id))
  finish(w.db, plan(w.db, id))
  return note
}

test('a split is 2+ ordered parts; one part or a question is not', () => {
  expect(split(PARTS)?.map((p) => p.title)).toEqual(['file the parts', 'queue them in order'])
  expect(split(PARTS.replace(/ {2}- title: queue[\s\S]*?parent\n/, ''))).toBeNull()
  expect(split('---\noutcome: unclear\nquestion: which one?\n---\n')).toBeNull()
})

test('a colon in a part or a question still reads', () => {
  const colon = PARTS.replace('ends: two issues exist', 'ends: tests show all four cases: a 3/5 is refused')
  expect(split(colon)?.[0]?.ends).toBe('tests show all four cases: a 3/5 is refused')
  expect(unclear('---\noutcome: unclear\nquestion: which of these: a or b?\n---\n')).toBe('which of these: a or b?')
})

test('D1, D2: each part names its after, else the part before', () => {
  expect(split(AFTER(['none', 'a', 'none']))?.map((p) => p.after)).toEqual(['none', 'a', 'none'])
  expect(split(AFTER(['none', 'A', 'none']))?.map((p) => p.after)).toEqual(['none', 'a', 'none'])
  expect(split(AFTER(['none', 'A', 'none']))).toEqual(split(AFTER(['none', 'a', 'none'])))
  expect(split(PARTS)?.map((p) => p.after)).toEqual(['none', 'a'])
  expect(split(AFTER([null, null, null, null]))?.map((p) => p.after)).toEqual(['none', 'a', 'b', 'c'])
  expect(split(AFTER([null, 'none', null]))?.map((p) => p.after)).toEqual(['none', 'none', 'b'])
})

test('D3: an after on itself, a later part or no part is no split', () => {
  for (const after of [['none', 'c', 'none'], ['a', 'none', 'none'], ['none', 'none', 'c'], ['none', 'z', 'none'], ['none', 'none', 'ab'],
    ['none', 'none', 'C'], ['B', 'none', 'none'], ['none', "''", 'none']]) {
    expect(split(AFTER(after))).toBeNull()
  }
})

test('past five files besides tests a brief is wide', () => {
  const five = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']
  expect(wide(BRIEF_OF([...five, 'tests/a.test.ts', 'x.test.ts', 'fixtures/y.md']))).toBeNull()
  expect(wide(BRIEF_OF([...five, 'f.ts']))).toBe(6)
})

test('an internal split files parts, first queued, parent unbuilt', async () => {
  const w = mine()
  const log: string[] = []
  await briefed(w, ID, PARTS, log)
  expect(log).toEqual([
    'file caliperforge/caliperforge 34a: file the parts',
    'file caliperforge/caliperforge 34b: queue them in order',
    'comment caliperforge/caliperforge#34',
  ])
  expect(plan(w.db, ID)).toMatchObject({ state: 'done', step: 1 })
  expect(runRows(w.db).filter((r) => r.plan === ID && r.step >= 2)).toHaveLength(0)
  const parts = allParts(w.db).filter((p) => p.parent === ID)
  expect(parts.map((p) => [p.n, p.url.split('/').at(-1), p.plan === null])).toEqual([[0, '901', false], [1, '902', true]])
  const first = parts[0]?.plan ?? 0
  expect(ofKind(w.db, 'filed').map((e) => ({ plan: e.plan, actor: e.actor }))).toEqual([{ plan: first, actor: 'split' }])
  expect(plan(w.db, first)).toMatchObject({ state: 'queued', step: 0, priority: plan(w.db, ID).priority, lane: 'machine',
    origin: 'https://github.com/caliperforge/caliperforge/issues/901' })
  expect(maybe(w.root, first, 'ask.md')).toMatch(/^# 34a: file the parts\n\n\*\*What:\*\* the machine files each part/)
  expect(allParts(w.db).find((p) => p.n === 1)).toMatchObject({ body: expect.stringContaining('After: #901') as unknown })
})

test('parentCarried', async () => {
  const w = mine()
  await briefed(w, ID, PARTS, [])
  const parts = allParts(w.db).filter((p) => p.parent === ID)
  for (const { body } of parts) expect(body).toContain('## Parent ticket\n\n# let an internal plan run')
  expect(maybe(w.root, partPlan(w, 0) ?? 0, 'ask.md')).toContain('## Parent ticket\n\n# let an internal plan run')
})

test('parentCut', async () => {
  const w = mine()
  put(w.root, ID, 'ask.md', `${'a'.repeat(6000)}${'~'.repeat(1000)}`)
  await briefed(w, ID, PARTS, [])
  const body = allParts(w.db).find((p) => p.parent === ID && p.n === 0)?.body ?? ''
  expect(body).toContain(`## Parent ticket\n\n${'a'.repeat(6000)}\ncut, see #34`)
  expect(body).not.toContain('~')
})

test('a parent After: line gates no part', async () => {
  const w = mine()
  put(w.root, ID, 'ask.md', '# t\n\nAfter: #77\n\n- **D1** x\n')
  await briefed(w, ID, AFTER(['none', 'none']), [])
  expect(allParts(w.db).filter((p) => p.parent === ID).map((p) => afterOf(p.body))).toEqual([null, null])
})

const TABLE = '| reason | count |\n| --- | --- |\n| slow | 3 |'

const CITING = PARTS.replace('what: the machine files each part', 'what: "the machine files each part in the #34 breakdown table"')

const commented = (w: World, body: string): Wire => ({ ...watched([], w.root, ID),
  thread: () => [{ author: { login: 'reviewer' }, body, url: 'https://github.com/caliperforge/caliperforge/issues/34#issuecomment-1' }] })

test('D1, D2: only a part citing the parent carries its comments', async () => {
  const w = mine()
  await briefed(w, ID, CITING, [], commented(w, TABLE))
  const [a, b] = allParts(w.db).filter((p) => p.parent === ID)
  expect(a?.body).toContain(`## Parent comments\n\n### reviewer\n\n${TABLE}`)
  expect(maybe(w.root, partPlan(w, 0) ?? 0, 'ask.md')).toContain(`## Parent comments\n\n### reviewer\n\n${TABLE}`)
  expect(b?.body).not.toContain('## Parent comments')
})

test('D3: a thread read that throws files no part', () => {
  const w = mine()
  const log: string[] = []
  const wire = { ...watched(log, w.root, ID), thread: () => { throw new Error('gh down') } }
  expect(parted(w.db, w.root, plan(w.db, ID), split(PARTS) ?? [], wire)).toMatchObject({ outcome: 'refuse', spans: ['gh'], blip: true })
  expect(log.filter((l) => l.startsWith('file '))).toEqual([])
})

test('D4: an After: line in a parent comment gates no part', async () => {
  const w = mine()
  await briefed(w, ID, CITING, [], commented(w, `${TABLE}\nAfter: #77`))
  const body = allParts(w.db).find((p) => p.parent === ID && p.n === 0)?.body ?? ''
  expect(body).toContain('## Parent comments')
  expect(afterOf(body)).toBeNull()
})

test('a part landing queues the next; the last closes the parent', async () => {
  const w = mine()
  const log: string[] = []
  await briefed(w, ID, PARTS, log)
  const a = partPlan(w, 0) ?? 0
  expect(following(w.db, w.root, plan(w.db, a), 'a'.repeat(40), watched(log, w.root, a))).toMatch(/^part b queued as plan \d+$/)
  finish(w.db, plan(w.db, a))
  const b = partPlan(w, 1) ?? 0
  expect(maybe(w.root, b, 'ask.md')).toContain('After: #901')
  expect(ofKind(w.db, 'filed').map((e) => ({ plan: e.plan }))).toEqual([{ plan: a }, { plan: b }])
  expect(following(w.db, w.root, plan(w.db, b), 'b'.repeat(40), watched(log, w.root, b))).toBe('the last part landed; #34 closed')
  expect(log.at(-1)).toBe('close caliperforge/caliperforge#34 bbbbbbb')
  expect(following(w.db, w.root, plan(w.db, ID), 'c'.repeat(40), watched(log, w.root, ID))).toBeNull()
})

test('D1, D2: a re-split part closes and its grandparent goes on', async () => {
  const w = mine()
  internalPlan(w.db, w.root, 3, 'the parent', 33)
  addPart(w.db, { parent: 3, n: 0, url: 'https://github.com/caliperforge/caliperforge/issues/34', title: 't', body: 'b', plan: ID })
  addPart(w.db, { parent: 3, n: 1, url: 'https://github.com/caliperforge/caliperforge/issues/35', title: 't', body: 'b', after: 0 })
  finish(w.db, plan(w.db, 3))
  const log: string[] = []
  await briefed(w, ID, PARTS, log)
  expect(log).toEqual([
    'file caliperforge/caliperforge 34a: file the parts',
    'file caliperforge/caliperforge 34b: queue them in order',
    'comment caliperforge/caliperforge#34',
  ])
  expect(plan(w.db, ID)).toMatchObject({ state: 'done', step: 1 })
  const a = partPlan(w, 0) ?? 0
  following(w.db, w.root, plan(w.db, a), 'a'.repeat(40), watched(log, w.root, a))
  finish(w.db, plan(w.db, a))
  const b = partPlan(w, 1) ?? 0
  expect(following(w.db, w.root, plan(w.db, b), 'b'.repeat(40), watched(log, w.root, b)))
    .toMatch(/^the last part landed; #34 closed; part b queued as plan \d+$/)
  expect(log.at(-1)).toBe('close caliperforge/caliperforge#34 bbbbbbb')
})

test('D1, D2, D6: free parts start; only waiters name their issue', async () => {
  const w = mine()
  const log: string[] = []
  const said: string[] = []
  await briefed(w, ID, AFTER(['none', 'a', 'none']), log, { ...watched(log, w.root, ID), comment: (...a) => void said.push(a[2]) })
  expect(log.filter((l) => l.startsWith('file '))).toHaveLength(3)
  const parts = allParts(w.db).filter((p) => p.parent === ID)
  expect(parts.map((p) => [p.after, p.plan === null ? null : plan(w.db, p.plan).state, p.body.includes('After:')])).toEqual([[null, 'queued', false], [0, null, true], [null, 'queued', false]])
  expect(parts[1]?.body).toContain('After: #901')
  expect(said).toEqual([expect.stringContaining('#901, #903 started; #902 waits on #901.') as unknown])
})

test('D3, D4: a landing queues its waiters; the parent closes once', async () => {
  const w = mine()
  const log: string[] = []
  await briefed(w, ID, AFTER(['none', 'a', 'none']), log)
  expect(landing(w, 2, log)).toBeNull()
  expect({ plan: partPlan(w, 1) }).toEqual({ plan: null })
  expect(landing(w, 0, log)).toMatch(/^part b queued as plan \d+$/)
  expect(landing(w, 2, log)).toBeNull()
  expect(log.filter((l) => l.startsWith('close '))).toEqual([])
  expect(landing(w, 1, log)).toBe('the last part landed; #34 closed')
  expect(log.filter((l) => l.startsWith('close '))).toEqual(['close caliperforge/caliperforge#34 1111111'])
})

test('D4: a part released early is not queued again; parent closes', async () => {
  const w = mine()
  const log: string[] = []
  await briefed(w, ID, AFTER(['none', 'a', 'none']), log)
  recordListing(w.db, 'caliperforge/caliperforge', [{ number: 902, title: 't', body: 'After: #901',
    url: 'https://github.com/caliperforge/caliperforge/issues/902', labels: [{ name: 'lane:machine' }], createdAt: '2026-09-27T00:00:00Z', closedAt: null,
    stateReason: null }], false)
  released(w.db, w.root, 'caliperforge/caliperforge', new Set())
  expect(landing(w, 1, log)).toBeNull()
  expect(landing(w, 2, log)).toBeNull()
  expect(landing(w, 0, log)).toBe('the last part landed; #34 closed')
})

test('D5: a split whose parts all say none queues them at once', async () => {
  const w = mine()
  await briefed(w, ID, AFTER(['none', 'none']), [])
  expect(allParts(w.db).filter((p) => p.parent === ID && p.plan !== null && plan(w.db, p.plan).state === 'queued')).toHaveLength(2)
})

test('D1: an approved outside split files our parts on asm/<plan>', async () => {
  const out = world()
  approve(out.db, out.target)
  const log: string[] = []
  await briefed(out, 1, PARTS, log)
  expect(log).toEqual(['file caliperforge/caliperforge p1a: file the parts', 'file caliperforge/caliperforge p1b: queue them in order'])
  expect(plan(out.db, 1)).toMatchObject({ state: 'done' })
  const parts = allParts(out.db).filter((p) => p.parent === 1)
  for (const { body } of parts) expect(body).toMatch(/Internal only[\s\S]*asm\/1/)
  const a = parts[0]?.plan ?? 0
  expect(plan(out.db, a)).toMatchObject({ target_id: 1 })
  expect(assembly(out.db, plan(out.db, a))?.branch).toBe('asm/1')
})

test('D2: an unapproved outside split files nothing and waits', () => {
  const out = world()
  const log: string[] = []
  expect(parted(out.db, out.root, plan(out.db, 1), split(PARTS) ?? [], watched(log, out.root, 1))).toMatchObject({ outcome: 'needs_ceo' })
  expect(log).toEqual([])
  expect(maybe(out.root, 1, 'question.md')).toMatch(/split by the COO[\s\S]*a\. file the parts/)
})

test('a wide internal brief goes back to the brief writer', async () => {
  const w = mine()
  const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'].map((p) => `src/${p} (new)`)
  const log: string[] = []
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched(log, w.root, ID))
  const fired = await tick(w.db, w.root, stub(CARRIED, 0, undefined, undefined, wideBrief(paths)), undefined, undefined, watched(log, w.root, ID))
  expect(fired[0]).toMatchObject({ step: 1, outcome: 'refuse', spans: ['brief.wide'] })
  expect(maybe(w.root, ID, 'refusal.md')).toContain('answer with the split fence')
  expect(maybe(w.root, ID, 'issue.md')).toBeNull()
})

const SIX = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'].map((p) => `src/${p} (new)`)

async function outside(brief: string, limit?: number): Promise<{ w: World; fired: unknown }> {
  const w = world()
  approve(w.db, w.target)
  if (limit !== undefined) {
    setLimit(w.db, { repo: 'acme/widget', lines: limit, origin_kind: 'ruling', origin_ref: 't', set_at: '2026-09-26' })
  }
  await tick(w.db, w.root, stub(CARRIED))
  const fired = (await tick(w.db, w.root, stub(CARRIED, 0, undefined, undefined, brief)))[0]
  return { w, fired }
}

test('D1: an outside brief of six files is wide and saved aside', async () => {
  const brief = wideBrief(SIX, 'hello')
  const { w, fired } = await outside(brief)
  expect(fired).toMatchObject({ step: 1, outcome: 'refuse', spans: ['brief.wide'] })
  expect(maybe(w.root, 1, 'issue.md')).toBeNull()
  expect(maybe(w.root, 1, 'brief.refused.md')).toBe(brief)
})

test('D2: an outside brief past its size limit is wide, naming it', async () => {
  const { w, fired } = await outside(wideBrief(SIX.slice(0, 5), 'hello', 'Estimate: ~1,300 lines'), 250)
  expect(fired).toMatchObject({ step: 1, outcome: 'refuse', spans: ['brief.wide'] })
  expect(maybe(w.root, 1, 'refusal.md')).toContain("the brief estimates 1300 lines besides tests and generated files; past acme/widget's 250 it is more than one job, so answer with the split fence")
})

test('D3: an outside brief of five files at the limit is the issue', async () => {
  const brief = wideBrief(SIX.slice(0, 5), 'hello', 'Estimate: 250 lines')
  const { w, fired } = await outside(brief, 250)
  expect(fired).toMatchObject({ step: 1, outcome: 'pass' })
  expect(maybe(w.root, 1, 'issue.md')).toBe(brief)
})

const SPANNING = wideBrief(['kotlin/Main.kt (new)', '.github/workflows/k.yml (new)'], 'hello', 'x', 'harness/test/x.test.ts (new)')

test('D1: an outside brief splits into one part per language', () => {
  const out = world()
  expect(split(languages(plan(out.db, 1), SPANNING) ?? '')?.map((p) => [p.title, p.what, p.after])).toEqual([
    ['kotlin part of hello', "plan 1's kotlin files: kotlin/Main.kt, .github/workflows/k.yml", 'none'],
    ['typescript part of hello', "plan 1's typescript files: harness/test/x.test.ts", 'a'],
  ])
})

test('D2, D3: each language part files on asm/1 to its own builder', async () => {
  const out = world()
  approve(out.db, out.target)
  const log: string[] = []
  await briefed(out, 1, SPANNING, log)
  expect(log).toEqual(['file caliperforge/caliperforge p1a: kotlin part of hello', 'file caliperforge/caliperforge p1b: typescript part of hello'])
  expect(plan(out.db, 1)).toMatchObject({ state: 'done' })
  expect(maybe(out.root, 1, 'issue.md')).toBeNull()
  const at = (n: number) => allParts(out.db).find((p) => p.parent === 1 && p.n === n)
  expect(at(1)?.body).toContain('After: #901')
  const a = at(0)?.plan ?? 0
  following(out.db, out.root, plan(out.db, a), 'a'.repeat(40), watched(log, out.root, a))
  const b = at(1)?.plan ?? 0
  record(out.db, a, [{ path: 'kotlin/Main.kt', is_new: true }, { path: '.github/workflows/k.yml', is_new: true }])
  record(out.db, b, [{ path: 'harness/test/x.test.ts', is_new: true }])
  expect([a, b].map((id) => builder(languageFor(out.db, plan(out.db, id), srcDir(out.root, id))))).toEqual(['kotlin_specialist', 'outside_specialist'])
})

test('D4: an outside brief in one language is not split', async () => {
  const out = world()
  approve(out.db, out.target)
  const brief = wideBrief(['kotlin/Main.kt (new)', '.github/workflows/k.yml (new)', 'docs/k.md (new)'], 'hello', 'x', 'kotlin/test/MainTest.kt (new)')
  const log: string[] = []
  await briefed(out, 1, brief, log)
  expect(maybe(out.root, 1, 'issue.md')).toBe(brief)
  expect(log).toEqual([])
})

test('D5: an internal mixed brief is not split by language', async () => {
  const w = mine()
  const brief = wideBrief(['kotlin/Main.kt (new)', 'src/b.ts (new)'], 'let an internal plan run', 'x', 'harness/test/x.test.ts (new)')
  expect(languages(plan(w.db, ID), brief)).toBeNull()
  await briefed(w, ID, brief, [])
  expect(maybe(w.root, ID, 'issue.md')).toBe(brief)
  expect(allParts(w.db)).toEqual([])
})

function wideBrief(paths: string[], title = 'let an internal plan run', approach = 'x', tests = 'src/a.ts'): string {
  return [`# ${title}`, '', '**What:** a.', '**Why:** b.', '**When it ends:** c.', '',
    '## Approach', '', approach, '', '## Settled facts', '', '- none: every name the change uses is in this checkout', '', '## Cases', '', '- D1 one', '- D2 a call with no name is refused', '',
    '## Must not break', '', '- y', '', '## Files', '', ...paths.map((p) => `- ${p}`), '',
    '## Files to read', '', '- src/hello.ts — what it exports today', '',
    '## Who else reads what this changes', '', '- nobody else', '', '## Tests', '', `- ${tests} — the case`, '',
    '## Out of scope', '', '- z', '', '## Standing', '', ...STANDING, ''].join('\n')
}

test('parts carry the parent priority label', async () => {
  const w = mine()
  priority(w.db, ID, 0)
  const labels: string[][] = []
  const wire = (id: number) => {
    const inner = watched([], w.root, id)
    return { ...inner, file: (...a: Parameters<typeof inner.file>) => { labels.push(a[3]); return inner.file(...a) } }
  }
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire(ID))
  await tick(w.db, w.root, stub(CARRIED, 0, undefined, undefined, PARTS), undefined, undefined, wire(ID))
  expect(labels).toEqual([['lane:machine', 'P0'], ['lane:machine', 'P0']])
})
