import { expect, test } from 'vitest'
import { eventsOf, logged, newestRun, pointers } from '../../store/events.ts'
import { returnToLane } from '../../store/holds.ts'
import { retry } from '../../store/plans.ts'
import { builds, clear, fingerprint, refused, sinceSent } from '../../store/refusals.ts'
import { tick } from '../index.ts'
import { reasons, streak } from '../refusal.ts'
import { maybe } from '../workspace.ts'
import { approve, CARRIED, plan, REFUSE, stub, watched, world, type World } from './world.ts'

const refuse = (w: World, step: number, span: string, note: string): void =>
  void refused(w.db, { plan: 1, step, fingerprint: fingerprint(step, [span, note]), diff: null, span, note })

test('D1 a plan stops before its 6th build, after clear and retry', async () => {
  const w = world()
  approve(w.db, w.target)
  let fired = 0
  const provider = stub(CARRIED, 0, undefined, (p) => { if (!p.transcript.includes('director')) fired += 1 })
  while (builds(w.db, 1) === 0) await tick(w.db, w.root, provider)
  for (let n = 0; n < 4; n += 1) {
    logged(w.db, { plan: 1, kind: 'build', actor: 'typescript_specialist', outcome: 'pass', message: '', pointer: null, run: newestRun(w.db) })
  }
  const before = fired
  for (let round = 1; round <= 2; round += 1) {
    clear(w.db, 1)
    retry(w.db, plan(w.db, 1))
    await tick(w.db, w.root, provider)
    expect(fired).toBe(before)
    expect(plan(w.db, 1).state).toBe('blocked_on_ceo')
    expect(pointers(w.db, 'build_cap')).toEqual(Array<string>(round).fill('director.md'))
  }
  expect(maybe(w.root, 1, 'director.md')).toBe('# Build cap\n\n5 builds ran; the next waits for the director\n')
})

test('D3 D4 a coo return lets 5 more builds run', async () => {
  const w = world()
  approve(w.db, w.target)
  let fired = 0
  const provider = stub(CARRIED, 0, undefined, (p) => { if (!p.transcript.includes('director')) fired += 1 })
  const build = (): void =>
    void logged(w.db, { plan: 1, kind: 'build', actor: 'typescript_specialist', outcome: 'pass', message: '', pointer: null, run: newestRun(w.db) })
  while (builds(w.db, 1) === 0) await tick(w.db, w.root, provider)
  for (let n = 0; n < 4; n += 1) build()
  retry(w.db, plan(w.db, 1))
  await tick(w.db, w.root, provider)
  expect(pointers(w.db, 'build_cap')).toEqual(['director.md'])
  returnToLane(w.db, 1, 'coo')
  const before = fired
  await tick(w.db, w.root, provider)
  expect(fired).toBe(before + 1)
  while (sinceSent(w.db, 1) < 5) build()
  retry(w.db, plan(w.db, 1))
  await tick(w.db, w.root, provider)
  expect(plan(w.db, 1).state).toBe('blocked_on_ceo')
  expect(pointers(w.db, 'build_cap')).toEqual(['director.md', 'director.md'])
  expect(maybe(w.root, 1, 'director.md')).toBe('# Build cap\n\n5 builds ran; the next waits for the director\n')
})

test('D2 D4 a third code_quality refusal in a row stops the plan', async () => {
  const w = world()
  approve(w.db, w.target)
  const wire = watched([], w.root, 1)
  for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  const states: (string | undefined)[] = []
  for (const line of [1, 2, 3]) {
    if (line > 1) {
      clear(w.db, 1)
      for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
    }
    const review = REFUSE.replace('src/hello.ts:1', `src/hello.ts:${String(line)}`)
    states.push((await tick(w.db, w.root, stub(CARRIED, 0, review)))[0]?.state)
  }
  expect(states).toEqual(['retried', 'retried', 'blocked_on_ceo'])
  const why = 'code_quality refused it 3 times in a row'
  expect(plan(w.db, 1).state).toBe('blocked_on_ceo')
  expect(eventsOf(w.db, 1, 'build_cap')).toEqual([{ actor: 'settle', outcome: 'needs_ceo', message: why }])
  expect(maybe(w.root, 1, 'director.md')).toBe(['# Build cap', '', why, '', '## code_quality: 3', '',
    '- src/hello.ts:3 (1)', '- src/hello.ts:2 (1)', '- src/hello.ts:1 (1)', ''].join('\n'))
})

test('D2 greptile scores in a row are one streak past the build', () => {
  const w = world()
  refuse(w, 6, 'greptile:3/5', 'Greptile scored abc1234 3/5')
  refuse(w, 6, 'greptile:2/5', 'Greptile scored abc1235 2/5')
  refuse(w, 2, 'src/hello.ts:1', 'typescript_specialist: no fence')
  refuse(w, 6, 'greptile:3/5', 'Greptile scored abc1236 3/5')
  expect(streak(w.db, 1)).toEqual({ source: 'greptile', n: 3 })
})

test('D3 identifiers, tight, identifiers make no streak', () => {
  const w = world()
  for (const rail of ['identifiers', 'tight', 'identifiers']) refuse(w, 3, 'src/hello.ts:1', `${rail}: hello`)
  expect(streak(w.db, 1)).toEqual({ source: 'identifiers', n: 1 })
})

test('D4 reasons group by source then span, cleared included', () => {
  const w = world()
  refuse(w, 3, 'src/a.ts:1', 'tight: long')
  clear(w.db, 1)
  refuse(w, 3, 'src/a.ts:1', 'tight: longer')
  refuse(w, 4, 'src/b.ts:2', 'code_quality refuse')
  refuse(w, 3, 'src/c.ts:3', 'tight: wide')
  expect(reasons(w.db, 1)).toEqual([
    { source: 'tight', n: 3, spans: [{ span: 'src/a.ts:1', n: 2 }, { span: 'src/c.ts:3', n: 1 }] },
    { source: 'code_quality', n: 1, spans: [{ span: 'src/b.ts:2', n: 1 }] },
  ])
})
